/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import childProcess, {
	type ChildProcess,
	type SpawnOptions,
	type SpawnSyncOptions,
} from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import { createApplicationFixture } from "../api/application.fixture.ts";

interface Invocation {
	args: readonly string[];
	options: SpawnOptions;
	child: ChildProcess;
	closed: Promise<unknown[]>;
}

/** Keep the real login service and file handoff while replacing the installed Java SDK process. */
export function createBrowserLoginFixture(t: TestContext) {
	const config = {
		suiteapps: [],
		vms: [
			{ account: "000071", url: "first.vm.eng.netsuite.com" },
			{ account: "000072", url: "second.vm.eng.netsuite.com" },
		],
	};
	const app = createApplicationFixture(config);
	const sdkHome = join(app.root, "sdk-home");
	const sdk = join(sdkHome, ".suitecloud-sdk/cli/suitecloud-test.jar");
	fs.mkdirSync(dirname(sdk), { recursive: true });
	fs.writeFileSync(sdk, "controlled SDK fixture");
	const resultFile = join(app.root, "login-result");
	fs.writeFileSync(resultFile, "");
	const worker = join(app.root, "login-worker.cjs");
	const loginUrl = `https://${config.vms[1]!.url}/login?code=private-login-code`;
	fs.writeFileSync(
		worker,
		`const { readFileSync, watch, writeFileSync } = require("node:fs");
const watcher = watch(process.env.TEST_LOGIN_RESULT, () => {
    const result = readFileSync(process.env.TEST_LOGIN_RESULT, "utf8");
    if (!result) return;
    watcher.close();
    process.stdout.write(result, () => process.exit(0));
});
writeFileSync(process.env.SUITECONTAINER_BROWSER_URL_FILE, process.env.TEST_LOGIN_URL);
`,
	);
	let invocation: Invocation | undefined;
	let availableAuthIds: string[] | undefined;
	const spawn = childProcess.spawn;
	const spawnSync = childProcess.spawnSync;
	const exists = fs.existsSync;
	t.mock.method(os, "homedir", () => sdkHome);
	t.mock.method(childProcess, "spawnSync", ((
		command: string,
		args: readonly string[],
		options: SpawnSyncOptions,
	) => {
		if (command === "java" && args?.includes("manageauth")) {
			const ids =
				availableAuthIds ??
				Object.values(
					app.lifecycle.services.credentials.read()["suitecloud-authentication"]
						?.accounts ?? {},
				).map((account) => account.authId);
			return {
				status: 0,
				stdout: JSON.stringify({
					status: "SUCCESS",
					data: Object.fromEntries(ids.map((id) => [id, {}])),
				}),
			};
		}
		return spawnSync(command, args, options);
	}) as typeof childProcess.spawnSync);
	t.mock.method(
		fs,
		"existsSync",
		(path: fs.PathLike) =>
			path === "/opt/suitecontainer/browser-handoff.jar" || exists(path),
	);
	t.mock.method(childProcess, "spawn", ((
		command: string,
		args: readonly string[],
		options: SpawnOptions,
	) => {
		assert.equal(command, "java");
		const child = spawn(process.execPath, [worker], {
			...options,
			env: {
				...options.env,
				TEST_LOGIN_RESULT: resultFile,
				TEST_LOGIN_URL: loginUrl,
			},
		});
		invocation = { args, options, child, closed: once(child, "close") };
		return child;
	}) as typeof childProcess.spawn);
	syncBuiltinESMExports();
	t.after(async () => {
		try {
			await app.close();
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
	function started() {
		assert.ok(invocation, "The login must start its SDK worker.");
		return invocation;
	}
	return {
		app,
		config,
		sdk,
		loginUrl,
		started,
		setAuthentications(ids: string[]) {
			availableAuthIds = ids;
		},
		async complete(result: object) {
			fs.writeFileSync(resultFile, JSON.stringify(result));
			await started().closed;
		},
		handoffDirectory() {
			const path = started().options.env?.SUITECONTAINER_BROWSER_URL_FILE;
			assert.ok(path);
			return dirname(path);
		},
	};
}
