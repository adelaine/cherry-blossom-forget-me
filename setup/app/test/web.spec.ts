import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAllowed, mountChanges, startWebServer } from "../src/web-server.ts";
import { credentialPath, type MountRecord } from "../src/web-mounts.ts";
import type { Auth } from "../src/step-auth.ts";

const require = createRequire(import.meta.url);
const { tokenIn, run: importToken } = require("../../bootstrap-token.cjs");
const record: MountRecord = { hostRoot: "/project", platform: "linux", local: {}, certificates: {} };
const emptyAuth: Auth = { "gitlab-token": "", "suitecloud-certificates": { public: "", private: "", id: "" } };

test("generation requires two explicitly empty paths and no mounted certificates", () => {
    assert.equal(generateAllowed(emptyAuth, false), true);
    assert.equal(generateAllowed(emptyAuth, true), false);
    assert.equal(generateAllowed({}, false), false);
    assert.equal(generateAllowed({ "suitecloud-certificates": { public: "credentials/public.pem", private: "", id: "" } }, false), false);
});

test("certificate generation is explicit, deployment uses snapshots, and a failed run can be retried", async t => {
    if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) { t.skip("OpenSSL is unavailable"); return; }
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-lifecycle-"));
    mkdirSync(join(root, "credentials"));
    const config = { suiteapps: [{ directory: "app", url: "https://gitlab.eng.netsuite.com/team/app.git" }], vms: [{ account: "000071", url: "runbox.vm.eng.netsuite.com" }] };
    const configFile = join(root, "suitecontainer.config.json");
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(join(root, "credentials/auth.json"), JSON.stringify(emptyAuth));
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify(record));
    const sessionFile = join(root, "session");
    const workerScript = join(root, "worker.cjs");
    writeFileSync(workerScript, `const fs = require('node:fs'); setTimeout(() => { console.log(JSON.parse(fs.readFileSync(process.env.SUITECONTAINER_CONFIG, 'utf8')).vms[0].account); console.log(JSON.parse(fs.readFileSync(process.env.SUITECONTAINER_AUTH, 'utf8'))['gitlab-token']); console.log(process.env.SUITECONTAINER_DEPLOY_PASSKEY); process.exit(1); }, 2000);`);
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile, workerScript, onStop: () => {}, signalHandlers: false });
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const token = readFileSync(sessionFile, "utf8").split("session=")[1];
        const headers = { "X-Session-Token": token, "Content-Type": "application/json", Origin: origin };
        const post = (path: string, value = {}) => fetch(origin + "/api/" + path, { method: "POST", headers, body: JSON.stringify(value) });
        const state = async () => (await fetch(origin + "/api/state", { headers })).json();
        assert.equal((await state()).certificates.canGenerate, true);
        assert.equal((await post("generate")).status, 200);
        assert.equal((await state()).certificates.canGenerate, false);
        assert.equal((await state()).ready, false);
        assert.equal((await fetch(origin + "/api/certificate", { headers })).status, 200);
        assert.equal((await post("credentials", { id: "certificate-id", token: "worker-secret" })).status, 200);
        assert.equal((await state()).ready, true);
        assert.equal((await post("deploy", { config: JSON.stringify(config) })).status, 202);
        for (const path of ["deploy", "credentials", "settings", "generate", "stop"]) assert.equal((await post(path, { config: JSON.stringify(config) })).status, 409);
        writeFileSync(configFile, JSON.stringify({ ...config, vms: [{ account: "000072", url: config.vms[0].url }] }));
        const finished = async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
                const next = await state();
                if (next.run.state !== "running") return next;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            throw new Error("Worker did not finish.");
        };
        const failed = await finished();
        assert.equal(failed.run.state, "failed");
        assert.match(failed.run.log, /000071/);
        assert.ok(!failed.run.log.includes("worker-secret"));
        assert.match(failed.run.log, /\[redacted\]/);
        assert.equal((await state()).run.state, "failed");
        writeFileSync(workerScript, "console.log('All SuiteApps were deployed.');");
        assert.equal((await post("deploy", { config: JSON.stringify(config) })).status, 202);
        assert.equal((await finished()).run.state, "succeeded");
        assert.equal((await post("stop")).status, 200);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});

test("local mount edits and removed external certificate mounts require relaunch", () => {
    const config = { suiteapps: [{ directory: "app", localPath: "../checkout" }], vms: [] };
    const mounted: MountRecord = { ...record, local: { app: "/checkout" }, certificates: { "/outside/public.pem": "/config/certs/public.pem" } };
    const auth: Auth = { "suitecloud-certificates": { public: "/outside/public.pem", private: "credentials/private.pem", id: "" } };
    assert.equal(mountChanges(config, auth, mounted), false);
    assert.equal(mountChanges({ ...config, suiteapps: [] }, auth, mounted), true);
    assert.equal(mountChanges(config, emptyAuth, mounted), true);
    assert.equal(mountChanges({ ...config, suiteapps: [{ directory: "app", localPath: "../different" }] }, auth, mounted), true);
    assert.equal(credentialPath(record, "credentials/../outside.pem"), null);
    const windows: MountRecord = { hostRoot: "C:\\Project", platform: "win32", local: {}, certificates: {} };
    assert.equal(credentialPath(windows, "C:\\PROJECT\\credentials\\private.pem"), "/config/credentials/private.pem");
});

test("token discovery reads data rather than executing shell values and preserves existing credentials", () => {
    assert.equal(tokenIn('[gitlab]\naccess_token = "example-token"'), "example-token");
    assert.equal(tokenIn('env = { NEMS_GITLAB_TOKEN = "inline-token" }'), "inline-token");
    assert.equal(tokenIn('env = { "GITLAB_PERSONAL_ACCESS_TOKEN" = "personal-token" }'), "personal-token");
    assert.equal(tokenIn('env = { GITLAB_PAT = "pat-token" }'), "pat-token");
    assert.equal(tokenIn('export GITLAB_TOKEN=literal-value # comment'), "literal-value");
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-token-"));
    try {
        const auth = join(root, "auth.json");
        const toml = join(root, "config.toml");
        const env = join(root, ".nems.env");
        writeFileSync(auth, JSON.stringify(emptyAuth));
        writeFileSync(toml, '[gitlab]\ntoken="preferred"');
        writeFileSync(env, 'GITLAB_TOKEN=other');
        importToken([auth, toml, env]);
        assert.equal(JSON.parse(readFileSync(auth, "utf8"))["gitlab-token"], "preferred");
        importToken([auth, env]);
        assert.equal(JSON.parse(readFileSync(auth, "utf8"))["gitlab-token"], "preferred");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unfinished settings reach the page; requests require session and same-origin credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-web-"));
    mkdirSync(join(root, "credentials"));
    const config = { suiteapps: [{ directory: "app", url: "https://gitlab.eng.netsuite.com/team/app.git" }], vms: [{ account: "000071", url: "" }] };
    writeFileSync(join(root, "suitecontainer.config.json"), JSON.stringify(config));
    writeFileSync(join(root, "credentials/auth.json"), JSON.stringify(emptyAuth));
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify(record));
    const sessionFile = join(root, "session");
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile, onStop: () => {}, signalHandlers: false });
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const token = readFileSync(sessionFile, "utf8").split("session=")[1];
        const headers = { "X-Session-Token": token, "Content-Type": "application/json", Origin: origin };
        assert.equal((await fetch(origin + "/api/state")).status, 403);
        const state = await (await fetch(origin + "/api/state", { headers })).json();
        assert.equal(state.ready, false);
        assert.equal(state.certificates.canGenerate, true);
        assert.equal(state.config, JSON.stringify(config));
        assert.equal((await fetch(origin + "/api/credentials", { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: '{}' })).status, 403);
        const saved = await fetch(origin + "/api/settings", { method: "POST", headers, body: JSON.stringify({ config: JSON.stringify(config) }) });
        assert.equal(saved.status, 200);
        assert.equal(JSON.parse(readFileSync(join(root, "suitecontainer.config.json"), "utf8")).vms[0].url, "");
        assert.equal((await fetch(origin + "/api/deploy", { method: "POST", headers, body: JSON.stringify({ config: JSON.stringify(config) }) })).status, 400);
        const credentialResponse = await fetch(origin + "/api/credentials", { method: "POST", headers, body: JSON.stringify({ token: "hidden-secret" }) });
        assert.equal(credentialResponse.status, 200);
        assert.ok(!(await credentialResponse.text()).includes("hidden-secret"));
        assert.equal(JSON.parse(readFileSync(join(root, "credentials/auth.json"), "utf8"))["gitlab-token"], "hidden-secret");
        writeFileSync(join(root, "credentials/private.pem"), "existing file");
        const partial = await (await fetch(origin + "/api/state", { headers })).json();
        assert.equal(partial.certificates.canGenerate, false);
        assert.equal((await fetch(origin + "/api/generate", { method: "POST", headers, body: '{}' })).status, 400);
        assert.equal(readFileSync(join(root, "credentials/private.pem"), "utf8"), "existing file");
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});
