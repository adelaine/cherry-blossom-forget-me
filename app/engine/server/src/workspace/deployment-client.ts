/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ServiceError } from "../common/errors.ts";

interface Connection {
	baseUrl: URL;
	instanceId: string;
	tokenFile: string;
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("SuiteContainer returned an invalid response.");
	return value as Record<string, unknown>;
}

function loopbackUrl(value: unknown): URL {
	if (typeof value !== "string")
		throw new Error("The connection URL is missing.");
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
		!url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		throw new Error(
			"SuiteContainer's connection must use a loopback HTTP endpoint.",
		);
	return url;
}

function readConnection(): Connection {
	const project = resolve(
		process.env.SUITECONTAINER_INSTALL_ROOT ??
			fileURLToPath(
				new URL(
					import.meta.url.endsWith(".ts")
						? "../../../../../"
						: "../../../../../../",
					import.meta.url,
				),
			),
	);
	const home = resolve(
		process.env.SUITECONTAINER_HOST_ROOT ?? join(project, "home"),
	);
	const descriptor =
		process.env.SUITECONTAINER_CONNECTION_FILE ??
		join(home, ".cache/runtime/connection.json");
	let connection: Record<string, unknown>;
	try {
		connection = object(JSON.parse(readFileSync(descriptor, "utf8")));
	} catch {
		throw new Error(
			"No valid SuiteContainer connection is available. Start it with the launcher first.",
		);
	}
	if (
		connection.schemaVersion !== 1 ||
		connection.apiVersion !== 1 ||
		typeof connection.instanceId !== "string" ||
		!/^[a-f0-9-]{36}$/.test(connection.instanceId) ||
		!["development", "production"].includes(String(connection.mode))
	)
		throw new Error(
			"The SuiteContainer connection descriptor is invalid. Relaunch SuiteContainer.",
		);
	// The mounted descriptor contains host paths and the host's published port.
	// Inside the container, use the launcher-supplied local endpoint and token path.
	const internalUrl = process.env.SUITECONTAINER_INTERNAL_API_URL;
	const tokenFile = internalUrl
		? process.env.SUITECONTAINER_ACCESS_TOKEN_FILE
		: join(home, ".cache/runtime/access-token");
	if (
		!tokenFile ||
		(internalUrl
			? connection.instanceId !== process.env.SUITECONTAINER_INSTANCE_ID
			: typeof connection.projectRoot !== "string" ||
				resolve(connection.projectRoot) !== project ||
				connection.tokenFile !== tokenFile)
	)
		throw new Error(
			"The SuiteContainer connection belongs to another project or backend instance.",
		);
	return {
		baseUrl: loopbackUrl(internalUrl ?? connection.baseUrl),
		instanceId: connection.instanceId,
		tokenFile,
	};
}

/** Send one request, without proxy discovery, redirects, or automatic retries. */
async function requestJson(
	connection: Connection,
	path: string,
	signal: AbortSignal,
	token?: string,
	input?: Record<string, unknown>,
	key?: string,
): Promise<Record<string, unknown>> {
	return new Promise((resolveReply, reject) => {
		const body = input === undefined ? undefined : JSON.stringify(input);
		const pending = request(
			new URL(path, connection.baseUrl),
			{
				method: body === undefined ? "GET" : "POST",
				signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
				agent: false,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(key ? { "Idempotency-Key": key } : {}),
					...(body === undefined
						? {}
						: {
								"Content-Type": "application/json",
								"Content-Length": Buffer.byteLength(body),
							}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("error", () =>
					reject(new Error("The SuiteContainer response was interrupted.")),
				);
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > 2 * 1024 * 1024) {
						response.destroy();
						reject(
							new Error("The SuiteContainer response exceeded its size limit."),
						);
					} else chunks.push(chunk);
				});
				response.on("end", () => {
					try {
						const status = response.statusCode ?? 500;
						// Do not follow redirects, even when the destination is another loopback port.
						if (status >= 300 && status < 400)
							throw new Error("SuiteContainer redirected the request.");
						const reply = object(
							JSON.parse(Buffer.concat(chunks).toString("utf8")),
						);
						if (status < 200 || status >= 300)
							throw new ServiceError(
								typeof reply.code === "string" ? reply.code : "request_failed",
								typeof reply.error === "string"
									? reply.error
									: "SuiteContainer rejected the request.",
								status,
							);
						resolveReply(reply);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		pending.on("error", () =>
			reject(
				new Error(
					"Could not reach SuiteContainer. The request was not retried.",
				),
			),
		);
		pending.end(body);
	});
}

function assertInstance(
	connection: Connection,
	reply: Record<string, unknown>,
): void {
	if (reply.instanceId !== connection.instanceId)
		throw new Error(
			"SuiteContainer's backend identity changed. The request was not retried.",
		);
}

/** Submit a deployment once and print its retained logs until the operation completes. */
export async function deployFromApi(args: string[]): Promise<number> {
	let targetId: string | undefined;
	if (args.length) {
		if (
			args.length !== 2 ||
			args[0] !== "--target" ||
			!/^[a-f0-9]{24}$/.test(args[1])
		)
			throw new Error(
				"Usage: --deploy [--target <id from /api/targets>]. Without --target, deploy all configured targets.",
			);
		targetId = args[1];
	}
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	let submitted = false;
	let operationId = "";
	let token = "";
	try {
		const connection = readConnection();
		const call = (
			path: string,
			input?: Record<string, unknown>,
			key?: string,
		) =>
			requestJson(
				connection,
				path,
				controller.signal,
				token || undefined,
				input,
				key,
			);
		// Check identity before reading or transmitting the access token.
		assertInstance(connection, await call("/health?activity=1"));
		token = readFileSync(connection.tokenFile, "utf8").trim();
		if (!/^[a-f0-9]{64}$/.test(token))
			throw new Error("The SuiteContainer access token is invalid.");
		const capabilities = await call("/api/capabilities");
		assertInstance(connection, capabilities);
		if (
			capabilities.apiVersion !== 1 ||
			!Array.isArray(capabilities.capabilities)
		)
			throw new Error(
				"The SuiteContainer API is incompatible. Relaunch SuiteContainer.",
			);
		const contract = capabilities.capabilities.find((value: unknown) => {
			const candidate = object(value);
			return candidate.method === "POST" && candidate.path === "/api/deploy";
		});
		const fields = object(object(object(contract).schema).fields);
		if (!fields[targetId ? "targetId" : "allTargets"])
			throw new Error(
				"This backend does not support the requested deployment selection. Relaunch SuiteContainer.",
			);
		const targets = await call("/api/targets");
		assertInstance(connection, targets);
		if (!Array.isArray(targets.targets) || !targets.targets.length)
			throw new Error("No deployment targets are configured.");
		if (
			targetId &&
			!targets.targets.some((value: unknown) => object(value).id === targetId)
		)
			throw new Error("The selected target is no longer configured.");
		submitted = true;
		const reply = await call(
			"/api/deploy",
			targetId ? { targetId } : { allTargets: true },
			randomUUID(),
		);
		assertInstance(connection, reply);
		if (
			typeof reply.operationId !== "string" ||
			!reply.operationId.startsWith(connection.instanceId + ".")
		)
			throw new Error(
				"SuiteContainer did not return a valid deployment operation ID.",
			);
		operationId = reply.operationId;
		const operationPath = `/api/operations/${encodeURIComponent(operationId)}`;
		let cursor = "0";
		for (;;) {
			const operation = await call(operationPath);
			assertInstance(connection, operation);
			if (
				operation.id !== operationId ||
				operation.kind !== "deployment" ||
				!["preparing", "running", "succeeded", "failed", "cancelled"].includes(
					String(operation.state),
				)
			)
				throw new Error(
					"SuiteContainer returned an invalid deployment operation.",
				);
			const logs = await call(`${operationPath}/logs?cursor=${cursor}`);
			assertInstance(connection, logs);
			if (
				logs.id !== operationId ||
				typeof logs.log !== "string" ||
				typeof logs.nextCursor !== "string" ||
				!/^\d+$/.test(logs.nextCursor) ||
				!Number.isSafeInteger(Number(logs.nextCursor)) ||
				Number(logs.nextCursor) < Number(cursor)
			)
				throw new Error("SuiteContainer returned invalid deployment logs.");
			if (logs.truncated)
				console.error("Earlier deployment output is outside retained history.");
			process.stdout.write(logs.log);
			cursor = logs.nextCursor;
			if (operation.state === "succeeded") return 0;
			if (operation.state === "failed" || operation.state === "cancelled") {
				if (operation.error) {
					const error = object(operation.error);
					if (typeof error.error === "string") console.error(error.error);
				}
				const code = operation.result
					? object(operation.result).exitCode
					: undefined;
				return typeof code === "number" &&
					Number.isInteger(code) &&
					code > 0 &&
					code < 256
					? code
					: 1;
			}
			await setTimeout(500, undefined, { signal: controller.signal });
		}
	} catch (error) {
		const rejected =
			error instanceof ServiceError &&
			error.status >= 400 &&
			error.status < 500 &&
			!operationId;
		if (rejected && error.code === "suiteapps_missing") {
			console.log(
				"There are no SuiteApps to install in config/suitecontainer.json.",
			);
			return 0;
		}
		const message = (
			controller.signal.aborted
				? "Stopped waiting for deployment."
				: error instanceof Error
					? error.message
					: "Deployment request failed."
		).replaceAll(token || "\0", "[redacted]");
		if (submitted && !rejected)
			throw new Error(
				`${message} Deployment outcome is uncertain${operationId ? ` (operation ${operationId})` : ""}. ` +
					"The deployment may still be running. Inspect its status before starting another deployment.",
			);
		if (controller.signal.aborted) return 130;
		throw new Error(message);
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}
