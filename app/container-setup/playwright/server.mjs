import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const token = process.env.SUITECONTAINER_PLAYWRIGHT_TOKEN || "";
if (!token) {
	console.error("SUITECONTAINER_PLAYWRIGHT_TOKEN must be set.");
	process.exit(1);
}

const tokenHash = createHash("sha256").update(token).digest();
const workspace = "/workspace";
const configuredProject = process.env.SUITECONTAINER_PLAYWRIGHT_PROJECT || "";
const configuredBrowser =
	process.env.SUITECONTAINER_PLAYWRIGHT_BROWSER || "container";
const logLimit = 512 * 1024;
const bodyLimit = 16 * 1024;
const secrets = new Set([token]);
let logBuffer = Buffer.alloc(0);
let state = {
	state: "idle",
	project: configuredProject,
	browser: configuredBrowser,
};
let activeJob = null;
let stopping = false;
let watchdogTimer;

// Read runtime credentials only for redaction; project .env files stay untouched.
for (const [key, value] of Object.entries(process.env)) {
	if (
		value &&
		/(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE_KEY|_AUTH)(?:$|_)/i.test(
			key,
		)
	)
		secrets.add(value);
}
for (const npmrc of new Set([
	"/run/playwright/npmrc",
	process.env.NPM_CONFIG_USERCONFIG,
	process.env.npm_config_userconfig,
])) {
	if (!npmrc) continue;
	try {
		for (const line of (await readFile(npmrc, "utf8")).split(/\r?\n/)) {
			const match = line.match(
				/^\s*[^#;\s]*(?:_authToken|_auth|_password|password)\s*=\s*(.*?)\s*$/i,
			);
			if (!match) continue;
			const value = match[1]
				.replace(/^(["'])(.*)\1$/, "$2")
				.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || "");
			if (value) secrets.add(value);
		}
	} catch (error) {
		if (error.code !== "ENOENT")
			console.error(
				"Could not read mounted npm credentials for log redaction.",
			);
	}
}
let secretValues = [...secrets].sort((a, b) => b.length - a.length);
let secretOverlap = Math.max(1, ...secretValues.map((value) => value.length));

function redact(text) {
	for (const secret of secretValues)
		text = text.split(secret).join("[REDACTED]");
	return text
		.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
		.replace(
			/((?:_authToken|_password|_auth|password)\s*[=:]\s*)[^\s]+/gi,
			"$1[REDACTED]",
		);
}

function appendLog(text) {
	logBuffer = Buffer.concat([logBuffer, Buffer.from(redact(text))]);
	if (logBuffer.length > logLimit)
		logBuffer = logBuffer.subarray(logBuffer.length - logLimit);
}

function outputStream(stream) {
	const decoder = new StringDecoder("utf8");
	let pending = "";
	function drain(final = false) {
		// Flush completed lines even when they are shorter than the credential overlap.
		let end = final
			? pending.length
			: Math.max(
					0,
					pending.length - secretOverlap,
					pending.lastIndexOf("\n") + 1,
				);
		if (!final) {
			for (const secret of secretValues) {
				for (
					let length = Math.min(secret.length - 1, pending.length);
					length > 0;
					length--
				) {
					if (pending.endsWith(secret.slice(0, length))) {
						end = Math.min(end, pending.length - length);
						break;
					}
				}
			}
		}
		// Keep credentials together, including when a child splits one across writes.
		for (const secret of secretValues) {
			const index = pending.lastIndexOf(secret, end - 1);
			if (index >= 0 && index < end && index + secret.length > end) end = index;
		}
		if (end) {
			appendLog(pending.slice(0, end));
			pending = pending.slice(end);
		}
	}
	stream.on("data", (chunk) => {
		pending += decoder.write(chunk);
		drain();
	});
	stream.on("end", () => {
		pending += decoder.end();
		drain(true);
	});
}

function snapshot() {
	return { ...state, log: logBuffer.toString("utf8") };
}

class RequestError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

function within(parent, candidate) {
	const relative = path.relative(parent, candidate);
	return (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

function relativePath(value, label) {
	if (
		typeof value !== "string" ||
		!value ||
		/[\0\\]/.test(value) ||
		path.isAbsolute(value) ||
		/^[A-Za-z]:/.test(value)
	) {
		throw new RequestError(400, `${label} must be a relative path.`);
	}
	return value;
}

async function confinedPath(root, relative, label) {
	const candidate = path.resolve(root, relative);
	if (!within(root, candidate))
		throw new RequestError(400, `${label} must stay inside ${root}.`);
	let resolved;
	try {
		resolved = await realpath(candidate);
	} catch {
		throw new RequestError(400, `${label} does not exist: ${relative}`);
	}
	if (!within(root, resolved))
		throw new RequestError(400, `${label} resolves outside ${root}.`);
	return resolved;
}

async function validateRun(body) {
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new RequestError(400, "Expected a JSON object.");
	if (!configuredProject)
		throw new RequestError(
			400,
			"Choose a Playwright project in the app, save it, and relaunch the app.",
		);
	if (body.project !== configuredProject) {
		throw new RequestError(
			400,
			"The project must match the runner configuration. Save the project in the app and relaunch it to mount its dependencies.",
		);
	}
	relativePath(body.project, "Project");
	const root = await realpath(workspace);
	const project = await confinedPath(root, body.project, "Project");
	if (!(await stat(project)).isDirectory())
		throw new RequestError(400, "Project must be a directory.");
	for (const file of ["package.json", "pnpm-lock.yaml"]) {
		const resolved = await confinedPath(
			root,
			path.relative(root, path.join(project, file)),
			file,
		);
		if (!(await stat(resolved)).isFile())
			throw new RequestError(400, `${file} must be a file.`);
	}
	let hasConfig = false;
	for (const extension of ["ts", "js", "mts", "mjs", "cts", "cjs"]) {
		const file = `playwright.config.${extension}`;
		try {
			const resolved = await realpath(path.join(project, file));
			if (!within(root, resolved))
				throw new RequestError(400, `${file} resolves outside ${workspace}.`);
			if ((await stat(resolved)).isFile()) hasConfig = true;
		} catch (error) {
			if (error instanceof RequestError) throw error;
			if (error.code !== "ENOENT") throw error;
		}
	}
	if (!hasConfig)
		throw new RequestError(
			400,
			"Project must contain a playwright.config.ts, .js, .mts, .mjs, .cts, or .cjs file.",
		);
	let testFile;
	if (body.testFile !== undefined && body.testFile !== "") {
		relativePath(body.testFile, "Test file");
		if (body.testFile.startsWith("-"))
			throw new RequestError(400, "Test file cannot start with a dash.");
		const resolved = await confinedPath(project, body.testFile, "Test file");
		if (!(await stat(resolved)).isFile())
			throw new RequestError(400, "Test file must be a file.");
		testFile = `./${path.relative(project, resolved)}`;
	}
	if (
		typeof body.host !== "string" ||
		!body.host ||
		body.host.length > 253 ||
		/[\s/@\\?#\0]/.test(body.host)
	) {
		throw new RequestError(
			400,
			"Host must be a NetSuite hostname without a URL scheme or path.",
		);
	}
	if (
		typeof body.account !== "string" ||
		!/^[A-Za-z0-9_-]{1,128}$/.test(body.account)
	) {
		throw new RequestError(
			400,
			"Account must contain only letters, numbers, underscores, or dashes.",
		);
	}
	if (
		!Number.isInteger(body.workers) ||
		body.workers < 1 ||
		body.workers > 16
	) {
		throw new RequestError(400, "Workers must be an integer from 1 to 16.");
	}
	for (const name of [".env", ".env.local", ".npmrc"]) {
		try {
			const file = await realpath(path.join(project, name));
			if (!within(root, file))
				throw new RequestError(400, `${name} resolves outside ${workspace}.`);
			for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
				const match = line.match(
					/^\s*(?:export\s+)?([^#;=\s]+)\s*=\s*(.*?)\s*$/,
				);
				if (
					!match ||
					!/(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|PRIVATE_KEY|_AUTH)(?:$|_)/i.test(
						match[1],
					)
				)
					continue;
				const value = match[2]
					.replace(/^(["'])(.*)\1$/, "$2")
					.replace(/\$\{([^}]+)\}/g, (_, key) => process.env[key] || "");
				if (value) secrets.add(value);
			}
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
	}
	secretValues = [...secrets].sort((a, b) => b.length - a.length);
	secretOverlap = Math.max(1, ...secretValues.map((value) => value.length));
	return {
		project,
		testFile,
		host: body.host,
		account: body.account,
		workers: body.workers,
	};
}

function runCommand(job, args, options) {
	return new Promise((resolve, reject) => {
		if (job.cancelled) return resolve(false);
		appendLog(`\n$ pnpm ${args.join(" ")}\n`);
		const child = spawn("pnpm", args, {
			cwd: options.project,
			env: {
				...process.env,
				CI: "1",
				REMOTE_ENV: options.host,
				COMPANY_ID: options.account,
				npm_config_store_dir: "/pnpm/store",
				PLAYWRIGHT_REMOTE_WS_ENDPOINT:
					configuredBrowser === "local-chrome"
						? process.env.PLAYWRIGHT_REMOTE_WS_ENDPOINT
						: "",
				...(configuredBrowser === "local-chrome"
					? { PW_CHANNEL: "chrome" }
					: {}),
			},
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			shell: false,
		});
		job.child = child;
		outputStream(child.stdout);
		outputStream(child.stderr);
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (job.child === child) job.child = null;
			if (job.cancelled) return resolve(false);
			if (code !== 0)
				return reject(
					new Error(`pnpm ${args[0]} failed (${signal || `exit ${code}`}).`),
				);
			resolve(true);
		});
	});
}

async function runJob(job, options) {
	let succeeded = false;
	try {
		const commands = [
			["install", "--frozen-lockfile", "--store-dir=/pnpm/store"],
			...(configuredBrowser === "local-chrome"
				? []
				: [["exec", "playwright", "install"]]),
			[
				"exec",
				"playwright",
				"test",
				...(options.testFile ? [options.testFile] : []),
				`--workers=${options.workers}`,
				...(configuredBrowser === "local-chrome" ? ["--headed"] : []),
			],
		];
		for (const args of commands) {
			if (job.cancelled || !(await runCommand(job, args, options))) return;
		}
		succeeded = true;
	} catch (error) {
		appendLog(`\n${error.message}\n`);
	} finally {
		if (job.cancelled) appendLog("\nRun cancelled.\n");
		state = {
			...state,
			state: succeeded && !job.cancelled ? "succeeded" : "failed",
			finished: new Date().toISOString(),
		};
		if (activeJob === job) activeJob = null;
	}
}

function signalChild(child, signal) {
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH")
			appendLog(`Could not send ${signal} to the running process.\n`);
	}
}

async function cancelCurrent() {
	const job = activeJob;
	if (!job) return;
	job.cancelled = true;
	const child = job.child;
	let escalation;
	if (child?.pid) {
		signalChild(child, "SIGTERM");
		// Kill the group even if its leader exits first and leaves a browser behind.
		escalation = setTimeout(() => signalChild(child, "SIGKILL"), 5000);
	}
	await job.done;
	if (escalation) {
		clearTimeout(escalation);
		signalChild(child, "SIGKILL");
	}
}

function readJson(request) {
	return new Promise((resolve, reject) => {
		let size = 0;
		let oversized = false;
		const chunks = [];
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > bodyLimit) {
				if (!oversized)
					reject(new RequestError(413, "Request body is too large."));
				oversized = true;
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (oversized) return;
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new RequestError(400, "Request body must be valid JSON."));
			}
		});
		request.on("error", reject);
	});
}

function send(response, status, body) {
	const json = JSON.stringify(body);
	response.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(json),
	});
	response.end(json);
}

function authenticated(request) {
	const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization || "");
	const supplied = createHash("sha256")
		.update(match?.[1] || "")
		.digest();
	return Boolean(match) && timingSafeEqual(tokenHash, supplied);
}

const server = createServer(async (request, response) => {
	try {
		if (!authenticated(request))
			return send(response, 401, { error: "Unauthorized." });
		const route = new URL(request.url, "http://runner").pathname;
		if (request.method === "GET" && route === "/health")
			return send(response, 200, { ready: true });
		if (request.method === "GET" && route === "/state")
			return send(response, 200, snapshot());
		if (stopping) return send(response, 503, { error: "Runner is stopping." });
		if (request.method === "POST" && route === "/run") {
			if (activeJob)
				throw new RequestError(409, "A Playwright run is already in progress.");
			const options = await validateRun(await readJson(request));
			if (activeJob || stopping)
				throw new RequestError(409, "The runner is busy or stopping.");
			logBuffer = Buffer.alloc(0);
			state = {
				state: "running",
				project: configuredProject,
				browser: configuredBrowser,
				started: new Date().toISOString(),
			};
			const job = { child: null, cancelled: false, done: null };
			activeJob = job;
			job.done = runJob(job, options);
			return send(response, 202, snapshot());
		}
		if (request.method === "POST" && route === "/cancel") {
			await cancelCurrent();
			return send(response, 200, snapshot());
		}
		if (request.method === "POST" && route === "/shutdown") {
			send(response, 202, { stopping: true });
			void shutdown();
			return;
		}
		send(response, 404, { error: "Endpoint not found." });
	} catch (error) {
		if (!response.headersSent)
			send(response, error.status || 500, {
				error: redact(error.message || "Runner request failed."),
			});
	}
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;

async function shutdown() {
	if (stopping) return;
	stopping = true;
	clearInterval(watchdogTimer);
	await cancelCurrent();
	server.close(() => process.exit(0));
	server.closeIdleConnections();
	setTimeout(() => process.exit(0), 10000).unref();
}

process.on("SIGTERM", () => {
	void shutdown();
});
process.on("SIGINT", () => {
	void shutdown();
});

const appUrl = process.env.SUITECONTAINER_PLAYWRIGHT_APP_URL;
if (appUrl) {
	const graceUntil = Date.now() + 180000;
	let failures = 0;
	let checking = false;
	watchdogTimer = setInterval(async () => {
		if (checking || stopping) return;
		checking = true;
		try {
			const response = await fetch(new URL("/health", appUrl), {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5000),
				redirect: "error",
			});
			await response.body?.cancel();
			if (!response.ok) throw new Error("App health check failed.");
			failures = 0;
		} catch {
			if (Date.now() >= graceUntil && ++failures >= 3) {
				appendLog(
					"\nThe SuiteContainer app is no longer available. Stopping the runner.\n",
				);
				void shutdown();
			}
		} finally {
			checking = false;
		}
	}, 10000);
	watchdogTimer.unref();
}

server.listen(8787, "0.0.0.0", () => {
	console.log("SuiteContainer Playwright runner listening on port 8787.");
});
