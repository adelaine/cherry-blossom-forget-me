/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { createWorkspaceFixture } from "./workspace.fixture.ts";

interface ReadyMessage {
	origin: string;
	session: string;
}

/** Run the actual listener in its own process so signal cleanup is observable. */
async function startProcessFixture(t: TestContext) {
	const workspace = createWorkspaceFixture({
		suiteapps: [],
		vms: [{ account: "000071", url: "shutdown.vm.eng.netsuite.com" }],
	});
	const sessionFile = join(workspace.root, "session");
	const connectionFile = join(workspace.root, "connection.json");
	const workerPidFile = join(workspace.root, "sql-worker.pid");
	const stoppedFile = join(workspace.root, "stopped");
	const worker = join(workspace.root, "worker.mjs");
	writeFileSync(
		worker,
		`import { writeFileSync } from "node:fs";
process.stdin.resume();
process.stdin.once("end", () => {
    writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
});
`,
	);
	const entry = join(workspace.root, "server.mjs");
	const mainModule = pathToFileURL(
		fileURLToPath(new URL("../src/main.ts", import.meta.url)),
	).href;
	writeFileSync(
		entry,
		`import { readFileSync, watch, writeFileSync } from "node:fs";
import { startWebServer } from ${JSON.stringify(mainModule)};
const instanceId = "00000000-0000-4000-8000-000000000002";
writeFileSync(${JSON.stringify(connectionFile)}, JSON.stringify({ instanceId }));
const watcher = watch(${JSON.stringify(workspace.root)}, (_event, name) => {
    if (name !== "sql-worker.pid") return;
    const pid = Number(readFileSync(${JSON.stringify(workerPidFile)}, "utf8"));
    process.send({ pid });
    watcher.close();
});
const server = startWebServer({
    configDirectory: ${JSON.stringify(workspace.root)},
    instanceId,
    port: 0,
    host: "127.0.0.1",
    sessionFile: ${JSON.stringify(sessionFile)},
    sqlCommand: process.execPath,
    sqlArgs: [${JSON.stringify(worker)}],
    sqlTimeoutMs: 30000,
    onStop() { writeFileSync(${JSON.stringify(stoppedFile)}, "disposed"); },
});
server.once("listening", () => process.send({
    origin: "http://127.0.0.1:" + server.address().port,
    session: readFileSync(${JSON.stringify(sessionFile)}, "utf8").split("session=")[1],
}));
server.once("close", () => {
    watcher.close();
    if (process.connected) process.disconnect();
});
`,
	);
	const child = fork(entry, [], {
		execArgv: ["--experimental-strip-types"],
		cwd: workspace.root,
		silent: true,
		env: { ...process.env, SUITECONTAINER_CONNECTION_FILE: connectionFile },
	});
	let diagnostics = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		diagnostics += chunk.toString();
	});
	const exited = once(child, "close") as Promise<
		[number | null, NodeJS.Signals | null]
	>;
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			if (existsSync(workerPidFile)) {
				try {
					process.kill(Number(readFileSync(workerPidFile, "utf8")), "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
			child.kill("SIGKILL");
			await exited;
		}
		workspace.close();
	});
	const [message] = await once(child, "message", {
		signal: AbortSignal.timeout(5000),
	});
	const ready = message as ReadyMessage;
	assert.equal(typeof ready.origin, "string", diagnostics);
	assert.equal(typeof ready.session, "string", diagnostics);
	return {
		child,
		exited,
		origin: ready.origin,
		connectionFile,
		stoppedFile,
		get diagnostics() {
			return diagnostics;
		},
		post(path: string, input: object = {}) {
			return fetch(ready.origin + "/api/" + path, {
				method: "POST",
				headers: {
					Origin: ready.origin,
					"X-Session-Token": ready.session,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(input),
			});
		},
	};
}

test(
	"authenticated stop disposes the instance and lets its process exit",
	{ timeout: 10_000 },
	async (t) => {
		const app = await startProcessFixture(t);
		const response = await app.post("stop");
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { stopped: true });
		assert.deepEqual(await app.exited, [0, null], app.diagnostics);
		assert.equal(readFileSync(app.stoppedFile, "utf8"), "disposed");
		assert.equal(existsSync(app.connectionFile), false);
		await assert.rejects(
			fetch(app.origin + "/health", { signal: AbortSignal.timeout(1000) }),
		);
	},
);

test(
	"SIGTERM shuts down a protected SQL worker and closes the listener",
	{
		timeout: 10_000,
		skip:
			process.platform === "win32" &&
			"The engine handles POSIX signals in Linux.",
	},
	async (t) => {
		const app = await startProcessFixture(t);
		const workerReady = once(app.child, "message", {
			signal: AbortSignal.timeout(5000),
		});
		const config = {
			suiteapps: [],
			vms: [{ account: "000071", url: "shutdown.vm.eng.netsuite.com" }],
		};
		const response = await app.post("sql", {
			config: JSON.stringify(config),
			account: "TEST_USER",
			database: "test.service",
			password: "shutdown-password",
			sql: "SELECT 1 FROM dual;",
		});
		assert.equal(response.status, 202);
		const { operationId } = (await response.json()) as { operationId: string };
		const [message] = await workerReady;
		const { pid } = message as { pid: number };
		assert.equal(typeof pid, "number");
		process.kill(pid, 0);
		const stopped = await app.post("stop");
		assert.equal(stopped.status, 409);
		const failure = (await stopped.json()) as {
			code: string;
			details: { operationId: string };
		};
		assert.equal(failure.code, "operation_conflict");
		assert.equal(failure.details.operationId, operationId);
		assert.equal((await fetch(app.origin + "/health")).status, 200);
		app.child.kill("SIGTERM");
		assert.deepEqual(await app.exited, [0, null], app.diagnostics);
		assert.equal(existsSync(app.connectionFile), false);
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		await assert.rejects(
			fetch(app.origin + "/health", { signal: AbortSignal.timeout(1000) }),
		);
	},
);
