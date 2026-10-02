import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("copied runtime packages and compiled code run without the development dependencies", { timeout: 120_000 }, async () => {
    const appDirectory = fileURLToPath(new URL("../", import.meta.url));
    const copy = spawnSync(process.execPath, [join(appDirectory, "copy-runtime.mjs")], {
        cwd: appDirectory, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(copy.error, undefined, copy.error?.message);
    assert.equal(copy.status, 0, copy.stdout + copy.stderr);
    const build = spawnSync(process.execPath, [join(appDirectory, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], {
        cwd: appDirectory, encoding: "utf8", timeout: 90_000,
    });
    assert.equal(build.error, undefined, build.error?.message);
    assert.equal(build.status, 0, build.stdout + build.stderr);

    const root = mkdtempSync(join(tmpdir(), "suitecontainer-standalone-"));
    try {
        const runtime = join(root, "runtime");
        cpSync(join(appDirectory, "dist"), runtime, { recursive: true });
        // Node resolves packages through ancestor directories. Keep the copied app
        // outside the checkout and confirm it cannot inherit an installed package tree.
        for (let directory = dirname(runtime); ; directory = dirname(directory)) {
            assert.equal(existsSync(join(directory, "node_modules")), false, directory);
            if (dirname(directory) === directory) break;
        }
        assert.equal(existsSync(join(runtime, "node_modules/hono/package.json")), true);
        assert.equal(existsSync(join(runtime, "node_modules/@hono/node-server/package.json")), true);
        assert.equal(existsSync(join(runtime, "node_modules/esbuild")), false);
        assert.equal(existsSync(join(runtime, "node_modules/typescript")), false);
        const configDirectory = join(root, "config");
        mkdirSync(join(configDirectory, "credentials"), { recursive: true });
        const configPath = join(configDirectory, "suitecontainer.config.json");
        writeFileSync(configPath, JSON.stringify({ suiteapps: [], vms: [{ account: "000071", url: "" }] }));
        writeFileSync(join(configDirectory, "credentials/auth.json"), JSON.stringify({
            "gitlab-token": "", "suitecloud-certificates": { public: "", private: "", id: "" },
        }));
        writeFileSync(join(configDirectory, "credentials/web-mounts.json"), JSON.stringify({
            hostRoot: "/project", platform: "linux", local: {}, certificates: {},
        }));

        const environment = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "", SUITECONTAINER_AUTH: join(configDirectory, "credentials/auth.json") };
        const cli = spawnSync(process.execPath, [join(runtime, "install.js"), "--validate", configPath], {
            cwd: runtime, env: environment, encoding: "utf8", timeout: 10_000,
        });
        assert.equal(cli.error, undefined, cli.error?.message);
        assert.equal(cli.status, 0, cli.stdout + cli.stderr);
        assert.match(cli.stdout, /There are no SuiteApps to install/);

        const probe = join(root, "probe.mjs");
        writeFileSync(probe, `
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
const { startWebServer } = await import(${JSON.stringify(pathToFileURL(join(runtime, "web-server.js")).href)});
const sessionFile = ${JSON.stringify(join(root, "session"))};
let stop;
const stopped = new Promise(resolve => { stop = resolve; });
const server = startWebServer({ configDirectory: ${JSON.stringify(configDirectory)}, port: 0, host: "127.0.0.1", sessionFile, signalHandlers: false, onStop: stop });
try {
    await once(server, "listening");
    const origin = "http://127.0.0.1:" + server.address().port;
    const health = await fetch(origin + "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ready: true });
    for (const [path, type, file] of [["/alpine.js", "text/javascript", "alpine.js"], ["/pico.css", "text/css", "pico.css"]]) {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), type + "; charset=utf-8");
        assert.equal(await response.text(), readFileSync(${JSON.stringify(join(runtime, "assets"))} + "/" + file, "utf8"));
    }
    const response = await fetch(origin + "/api/stop", { method: "POST", headers: { Origin: origin, "X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1] } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stopped: true });
    await stopped;
    assert.equal(server.listening, false);
} finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
}
`);
        const web = spawnSync(process.execPath, [probe], {
            cwd: runtime, env: environment, encoding: "utf8", timeout: 15_000,
        });
        assert.equal(web.error, undefined, web.error?.message);
        assert.equal(web.status, 0, web.stdout + web.stderr);
        assert.equal(readFileSync(join(runtime, "assets/pico.css"), "utf8").length > 0, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
