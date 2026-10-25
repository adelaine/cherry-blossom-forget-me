import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function downloadFailureMessage(output) {
	if (/\bE429\b|429[^\n]*Too many authentication attempts/i.test(output)) {
		return "The package registry is limiting access (429). Check the selected npm configuration and credentials. Pause repeated builds; contact the registry administrator if access remains blocked.";
	}
	if (/\bE401\b/.test(output)) {
		return "The package registry rejected authentication (401). Check the selected npm configuration and refresh its token or credentials.";
	}
	if (/\bE403\b/.test(output)) {
		return "The package registry denied access (403). Check package permissions and the credentials in the selected npm configuration.";
	}
	if (/TAR_BAD_ARCHIVE|TAR_ENTRY_INVALID/.test(output)) {
		return "Package download did not return a valid archive. A Banyan login page can cause this. Check that Banyan is connected and signed in, then run the launcher again.";
	}
	if (
		/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/.test(
			output,
		)
	) {
		return "Could not connect to the package registry. Check your network and Banyan connection, then run the launcher again.";
	}
	if (
		/\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b/.test(
			output,
		)
	) {
		return "Could not verify the package registry certificate. Check your Banyan connection and company CA certificates, then run the launcher again.";
	}
	return "";
}

export function runNpm(args) {
	const installing = args[0] === "install" || args[0] === "ci";
	const environment = { ...process.env };
	const variables = new Map();
	const environmentFile = "/run/secrets/npm-env";
	if (installing && existsSync(environmentFile)) {
		const pairs = readFileSync(environmentFile, "utf8").split("\0");
		for (let index = 0; index + 1 < pairs.length; index += 2) {
			const name = pairs[index];
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
			variables.set(name, pairs[index + 1]);
			// These paths belong to the host. Keep the container's cache and installation location.
			if (
				/^npm_config_/i.test(name) &&
				!/^npm_config_(?:cache|prefix|local_prefix|userconfig|globalconfig)$/i.test(
					name,
				)
			) {
				environment[name] = pairs[index + 1];
			}
		}
	}
	let configurationDirectory;
	if (installing) {
		const userConfig =
			args
				.find((argument) => argument.startsWith("--userconfig="))
				?.slice("--userconfig=".length) ?? "/run/secrets/npmrc";
		const sources = [
			"/run/secrets/npm-globalrc",
			userConfig,
			"/run/secrets/npm-rootrc",
			"/run/secrets/npm-projectrc",
		].filter((file) => existsSync(file));
		if (sources.length) {
			let variableIndex = 0;
			const configuration = sources
				.map((file) => readFileSync(file, "utf8"))
				.join("\n")
				.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name) => {
					if (!variables.has(name)) return reference;
					const alias = `SUITECONTAINER_NPM_VALUE_${variableIndex++}`;
					environment[alias] = variables.get(name);
					return "${" + alias + "}";
				});
			configurationDirectory = mkdtempSync(
				join(tmpdir(), "suitecontainer-npm-"),
			);
			const configurationFile = join(configurationDirectory, ".npmrc");
			writeFileSync(configurationFile, configuration, { mode: 0o600 });
			args = args.filter((argument) => !argument.startsWith("--userconfig="));
			args.push(`--userconfig=${configurationFile}`);
			if (/^\s*\/\/registry\s*=/m.test(configuration))
				console.error(
					"Check the selected npm configuration: the registry setting should use registry=, not //registry=.",
				);
		}
		const configurationArgs = args.filter((argument) =>
			argument.startsWith("--userconfig="),
		);
		const registry = spawnSync(
			"npm",
			["config", "get", "registry", ...configurationArgs],
			{ env: environment, encoding: "utf8", timeout: 5000 },
		);
		if (registry.status === 0) {
			try {
				const url = new URL(registry.stdout.trim());
				url.username = "";
				url.password = "";
				url.search = "";
				url.hash = "";
				console.log(`npm registry: ${url.href}`);
			} catch {
				console.log("npm registry: could not display the configured URL");
			}
		} else
			console.log(
				"npm registry: npm could not report it; continuing with installation",
			);
	}
	const child = spawn("npm", args, {
		env: environment,
		stdio: ["inherit", installing ? "pipe" : "inherit", "pipe"],
	});
	let recentOutput = "";
	let failureMessage = "";
	let launchFailed = false;
	let progressTimer;

	if (installing) {
		const frames = ["|", "/", "-", "\\"];
		let frame = 0;
		const renderProgress = () => {
			process.stdout.write(
				`\r⬇️  Downloading packages… ${frames[frame++ % frames.length]}`,
			);
		};
		renderProgress();
		progressTimer = setInterval(renderProgress, 250);
		progressTimer.unref();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			recentOutput = (recentOutput + chunk).slice(-32_768);
		});
	}

	const stopProgress = () => {
		if (!progressTimer) return;
		clearInterval(progressTimer);
		progressTimer = undefined;
		process.stdout.write(`\r${" ".repeat(40)}\r`);
	};

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		recentOutput = (recentOutput + chunk).slice(-32_768);
		if (failureMessage) return;
		failureMessage = downloadFailureMessage(recentOutput);
		if (failureMessage) {
			// Stop npm retries when access fails or a login page replaces a download.
			if (!installing) console.error(`\n${failureMessage}`);
			child.kill();
		} else if (!installing) {
			process.stderr.write(chunk);
		}
	});
	child.on("error", (error) => {
		launchFailed = true;
		stopProgress();
		console.error(`Could not start npm: ${error.message}`);
	});
	child.on("close", (code) => {
		stopProgress();
		if (configurationDirectory)
			rmSync(configurationDirectory, { recursive: true, force: true });
		if (installing && (failureMessage || launchFailed || code !== 0)) {
			if (recentOutput)
				process.stderr.write(
					recentOutput.endsWith("\n") ? recentOutput : `${recentOutput}\n`,
				);
			if (failureMessage) console.error(failureMessage);
		}
		process.exitCode = failureMessage || launchFailed ? 1 : (code ?? 1);
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	runNpm(process.argv.slice(2));
}
