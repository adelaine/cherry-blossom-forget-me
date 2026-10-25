/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { ansiToHtml, ansiStyles } from "../../site/src/common/ansi.ts";
import { deploymentPage } from "../../site/src/web-page.ts";

const appDirectory = fileURLToPath(new URL("../../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "suitecontainer-build-test-"));
const buildDirectory = join(root, "engine");

after(() => rmSync(root, { recursive: true, force: true }));

before(
	() => {
		// A private source tree prevents stale dist files and concurrent builds from affecting the smoke tests.
		mkdirSync(buildDirectory);
		for (const path of ["server/src", "site/src", "site/public"])
			cpSync(join(appDirectory, path), join(buildDirectory, path), {
				recursive: true,
			});
		for (const path of [
			"package.json",
			"tsconfig.json",
			"tsconfig.build.json",
			"site/vite.config.ts",
			"site/tsconfig.json",
		])
			cpSync(join(appDirectory, path), join(buildDirectory, path));
		symlinkSync(
			join(appDirectory, "node_modules"),
			join(buildDirectory, "node_modules"),
			"junction",
		);
		for (const args of [
			[
				join(appDirectory, "node_modules/vite/bin/vite.js"),
				"build",
				"--config",
				"site/vite.config.ts",
			],
			[
				join(appDirectory, "../container-setup/node/copy-runtime.mjs"),
				buildDirectory,
			],
			[
				join(appDirectory, "node_modules/typescript/bin/tsc"),
				"-p",
				"tsconfig.build.json",
			],
		])
			execFileSync(process.execPath, args, {
				cwd: buildDirectory,
				encoding: "utf8",
				timeout: 90_000,
			});
	},
	{ timeout: 120_000 },
);

test("ANSI converter and styles are included in the compiled browser assets", () => {
	const script = readFileSync(
		join(buildDirectory, "dist/site/public/assets/page.js"),
		"utf8",
	);
	assert.equal(
		ansiToHtml("\x1b[31m<red>"),
		'<span class="ansi-fg-1">&lt;red&gt;</span>',
	);
	assert.ok(script.includes("data-ansi-fg"));
	const styles = readFileSync(
		join(buildDirectory, "dist/site/public/styles.css"),
		"utf8",
	);
	assert.ok(
		styles.replace(/\s+/g, "").replace(/;}/g, "}").includes(ansiStyles),
	);
	assert.ok(deploymentPage.html.includes('type="module" src="/page.js"'));
});

test(
	"copied runtime packages and compiled code run without the development dependencies",
	{ timeout: 30_000 },
	() => {
		const runtime = join(root, "runtime");
		cpSync(join(buildDirectory, "dist"), runtime, { recursive: true });
		const configDirectory = join(root, "config");
		mkdirSync(join(configDirectory, "credentials"), { recursive: true });
		const configPath = join(configDirectory, "suitecontainer.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				suiteapps: [],
				vms: [{ account: "000071", url: "" }],
			}),
		);
		writeFileSync(
			join(configDirectory, "credentials/auth.json"),
			JSON.stringify({
				"gitlab-token": "",
				"suitecloud-authentication": { method: "browser" },
				"suitecloud-certificates": { public: "", private: "", id: "" },
			}),
		);
		writeFileSync(
			join(configDirectory, "credentials/web-mounts.json"),
			JSON.stringify({
				hostRoot: "/project",
				platform: "linux",
				local: {},
				certificates: {},
			}),
		);
		const environment = {
			...process.env,
			NODE_PATH: "",
			NODE_OPTIONS: "",
			SUITECONTAINER_AUTH: join(configDirectory, "credentials/auth.json"),
		};
		execFileSync(
			process.execPath,
			[join(runtime, "install.js"), "--validate", configPath],
			{ cwd: runtime, env: environment, encoding: "utf8", timeout: 10_000 },
		);
		const probe = join(root, "probe.mjs");
		writeFileSync(
			probe,
			`
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
const serverModule = ${JSON.stringify(pathToFileURL(join(runtime, "web-server.js")).href)};
const { startWebServer } = await import(serverModule);
let finishDisposal;
const disposed = new Promise(resolve => { finishDisposal = resolve; });
const server = startWebServer({
    configDirectory: ${JSON.stringify(configDirectory)},
    port: 0,
    host: "127.0.0.1",
    sessionFile: ${JSON.stringify(join(root, "session"))},
    signalHandlers: false,
    onStop() { finishDisposal(); },
});
try {
    await once(server, "listening");
    const health = await fetch("http://127.0.0.1:" + server.address().port + "/health");
    assert.deepEqual(await health.json(), { ready: true });
} finally {
    if (server.listening) {
        const base = "http://127.0.0.1:" + server.address().port;
        const session = readFileSync(${JSON.stringify(join(root, "session"))}, "utf8").split("session=")[1];
        const stopped = await fetch(base + "/api/stop", {
            method: "POST",
            headers: { Origin: base, "X-Session-Token": session, "Content-Type": "application/json" },
            body: "{}",
        });
        assert.equal(stopped.status, 200);
        server.closeAllConnections();
        await disposed;
    }
}
`,
		);
		execFileSync(process.execPath, [probe], {
			cwd: runtime,
			env: environment,
			encoding: "utf8",
			timeout: 15_000,
		});
	},
);
