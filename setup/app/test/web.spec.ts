import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountChanges, startWebServer } from "../src/web-server.ts";
import { runInNewContext } from "node:vm";
import { credentialPath, type MountRecord } from "../src/web-mounts.ts";
import type { Auth } from "../src/step-auth.ts";
import { ansiToHtml, ansiStyles, applyAnsiColors } from "../src/ansi.ts";
import { deploymentPage } from "../src/web-page.ts";
import { replaceCertificates } from "../src/step-certificates.ts";

test("ANSI log rendering escapes HTML and uses fixed CSS classes", () => {
    assert.equal(ansiToHtml('<script>&"\'</script>'), "&lt;script&gt;&amp;&quot;&#39;&lt;/script&gt;");
    assert.equal(ansiToHtml('\x1b[1;31m<img src=x onerror=alert(1)>\x1b[0m plain'), '<span class="ansi-bold ansi-fg-1">&lt;img src=x onerror=alert(1)&gt;</span> plain');
    for (let index = 0; index < 16; index++) {
        const fg = index < 8 ? 30 + index : 90 + index - 8;
        const bg = index < 8 ? 40 + index : 100 + index - 8;
        assert.equal(ansiToHtml(`\x1b[${fg};${bg}mcolor`), `<span class="ansi-fg-${index} ansi-bg-${index}">color</span>`);
        assert.ok(ansiStyles.includes(`.ansi-fg-${index}{`));
        assert.ok(ansiStyles.includes(`.ansi-bg-${index}{`));
    }
});

test("ANSI log rendering handles selective resets and incomplete snapshots", () => {
    assert.equal(ansiToHtml('\x1b[1;31;44mA\x1b[22;39mB\x1b[49mC'), '<span class="ansi-bold ansi-fg-1 ansi-bg-4">A</span><span class="ansi-bg-4">B</span>C');
    assert.equal(ansiToHtml('start\x1b[3'), 'start');
    assert.equal(ansiToHtml('start\x1b[31mred\x1b['), 'start<span class="ansi-fg-1">red</span>');
    assert.equal(ansiToHtml('start\x1b[31mred\x1b[mend'), 'start<span class="ansi-fg-1">red</span>end');
});

test("ANSI log rendering discards unsupported controls", () => {
    assert.equal(ansiToHtml('\x1b[2Jtext\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x07'), 'textlink');
    assert.equal(ansiToHtml('text\x1b]unfinished title'), 'text');
    assert.equal(ansiToHtml('\x1b[38;2;0;0;0;1;32mgreen'), '<span class="ansi-bold ansi-fg-2">green</span>');
});

test("ANSI extended colors cover all 256 palette entries and exact RGB", () => {
    for (let index = 0; index < 256; index++) {
        const output = ansiToHtml(`\x1b[38;5;${index};48;5;${index}mcolor`);
        if (index < 16) assert.equal(output, `<span class="ansi-fg-${index} ansi-bg-${index}">color</span>`);
        else {
            const levels = [0, 95, 135, 175, 215, 255];
            const offset = index - 16;
            const channels = index >= 232 ? Array(3).fill(8 + (index - 232) * 10) : [levels[Math.floor(offset / 36)], levels[Math.floor(offset / 6) % 6], levels[offset % 6]];
            const hex = '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
            assert.equal(output, `<span data-ansi-fg="${hex}" data-ansi-bg="${hex}">color</span>`);
        }
    }
    assert.equal(ansiToHtml('\x1b[1;38;2;12;34;56;48;2;255;0;128mRGB\x1b[39;49;22m plain'), '<span class="ansi-bold" data-ansi-fg="#0c2238" data-ansi-bg="#ff0080">RGB</span> plain');
});

test("ANSI extended colors accept colon forms and reject malformed values safely", () => {
    for (const code of ['38:2:12:34:56', '38:2::12:34:56', '38:2:0:12:34:56', '38;2;12;34;56']) {
        assert.equal(ansiToHtml(`\x1b[${code}m<text>`), '<span data-ansi-fg="#0c2238">&lt;text&gt;</span>');
    }
    assert.equal(ansiToHtml('\x1b[38:5:196;48:2::0:1:2mtext'), '<span data-ansi-fg="#ff0000" data-ansi-bg="#000102">text</span>');
    for (const code of ['38;5;256', '38;5;', '38;2;256;0;0', '38;2;1;2', '38;2;;1;2', '38:2:1:12:34:56', '38:5:999', '58;2;0;255;0']) {
        assert.equal(ansiToHtml(`\x1b[${code}mtext`), 'text');
    }
    assert.equal(ansiToHtml('\x1b[31mred\x1b[38;5;999mstill red'), '<span class="ansi-fg-1">red</span><span class="ansi-fg-1">still red</span>');
    assert.equal(ansiToHtml('text\x1b[38;2;12;'), 'text');
});

test("ANSI RGB rendering assigns only validated CSS properties", () => {
    const spans = [
        { dataset: { ansiFg: '#0c2238', ansiBg: '#ff0080' }, style: {} as Record<string, string> },
        { dataset: { ansiFg: 'url(evil)', ansiBg: '#fff; color:red' }, style: {} as Record<string, string> },
    ];
    const root = { querySelectorAll: () => spans } as unknown as HTMLElement;
    applyAnsiColors(root);
    assert.deepEqual(spans[0]!.style, { color: '#0c2238', backgroundColor: '#ff0080' });
    assert.deepEqual(spans[1]!.style, {});
    const browserApply = new Function(`${deploymentPage.script.split('const $ =')[0]} return applyAnsiColors;`)();
    browserApply(root);
    assert.ok(deploymentPage.script.includes('applyAnsiColors(log)'));
});

test("ANSI converter is self-contained in the served browser script", () => {
    const browserConverter = new Function(`${deploymentPage.script.split('const $ =')[0]} return ansiToHtml;`)();
    assert.equal(browserConverter('\x1b[31m<red>'), ansiToHtml('\x1b[31m<red>'));
    assert.ok(deploymentPage.script.includes('log.innerHTML = ansiToHtml(next.run.log)'));
    assert.ok(deploymentPage.style.includes(ansiStyles));
    new Function(deploymentPage.script);
});

const require = createRequire(import.meta.url);
const { tokenIn, run: importToken } = require("../../bootstrap-token.cjs");
const record: MountRecord = { hostRoot: "/project", platform: "linux", local: {}, certificates: {} };
const emptyAuth: Auth = { "gitlab-token": "", "suitecloud-certificates": { public: "", private: "", id: "" } };

test("failed regeneration preserves the active pair and credentials", () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-replacement-"));
    const authPath = join(root, "auth.json");
    const auth = { ...emptyAuth, "suitecloud-certificates": { public: "credentials/public.pem", private: "credentials/private.pem", id: "existing-id" } };
    writeFileSync(authPath, JSON.stringify(auth));
    writeFileSync(join(root, "public.pem"), "old public");
    writeFileSync(join(root, "private.pem"), "old private");
    const originalPath = process.env.PATH;
    try {
        process.env.PATH = root;
        assert.throws(() => replaceCertificates(root, authPath));
        assert.equal(readFileSync(join(root, "public.pem"), "utf8"), "old public");
        assert.equal(readFileSync(join(root, "private.pem"), "utf8"), "old private");
        assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), auth);
    } finally {
        process.env.PATH = originalPath;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Current VM preserves accounts and other runboxes, synchronizes JSON edits, and saves with credentials", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "", querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
        return elements.get(id);
    };
    const config = { suiteapps: [], vms: [{ account: "000072", url: "old.vm.eng.netsuite.com" }, { account: "000073", url: "second.vm.eng.netsuite.com" }] };
    let saved: any;
    const next = { config: JSON.stringify(config), certificates: {}, run: { state: "idle", log: "" }, ready: false };
    const context = {
        document: { getElementById: element }, location: { hash: "", pathname: "/" }, URLSearchParams,
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
        setInterval() {}, setTimeout() {}, clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/credentials") { saved = JSON.parse(options.body); next.config = saved.config; }
            return { ok: true, json: async () => next };
        },
    };
    runInNewContext(deploymentPage.script, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(element("vm").value, config.vms[0].url);
    element("vm").value = "new.vm.eng.netsuite.com";
    element("vm").input();
    const edited = JSON.parse(element("config").value);
    assert.equal(edited.vms[0].url, "new.vm.eng.netsuite.com");
    assert.equal(edited.vms[0].account, "000072");
    assert.deepEqual(edited.vms[1], config.vms[1]);
    await element("credentials").click();
    assert.deepEqual(JSON.parse(saved.config), edited);
    edited.vms[0].url = "json.vm.eng.netsuite.com";
    element("config").value = JSON.stringify(edited);
    element("config").input();
    runInNewContext("render(state)", context);
    assert.equal(element("vm").value, edited.vms[0].url);
    element("config").value = "invalid JSON";
    element("vm").input();
    assert.equal(element("config").value, "invalid JSON");
    assert.match(element("credential-message").textContent, /Fix the configuration JSON/);
});

test("Stop app closes after five seconds only on success and explains blocked closure", async () => {
    for (const success of [true, false]) {
        const elements = new Map<string, any>();
        const element = (id: string) => {
            if (!elements.has(id)) elements.set(id, { value: "", querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
            return elements.get(id);
        };
        const timers: { callback: () => void; delay: number }[] = [];
        let closes = 0;
        let requests = 0;
        const state = { config: '{"vms":[]}', certificates: {}, run: { state: "idle", log: "" }, ready: false };
        const context = {
            document: { getElementById: element, querySelectorAll: () => [element("stop"), element("deploy")] },
            location: { hash: "", pathname: "/" }, URLSearchParams,
            sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
            setInterval() {}, clearTimeout() {},
            setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); },
            window: { closed: false, close() { closes++; } },
            fetch: async (path: string) => { requests++; return { ok: path !== "/api/stop" || success, json: async () => path === "/api/stop" ? { error: "Deployment is running." } : state }; },
        };
        runInNewContext(deploymentPage.script, context);
        await new Promise(resolve => setImmediate(resolve));
        await element("stop").click();
        assert.equal(closes, 0);
        if (success) {
            assert.equal(timers.length, 1);
            assert.equal(timers[0]!.delay, 5000);
            assert.match(element("run-state").textContent, /close in 5 seconds/);
            assert.equal(element("stop").disabled, true);
            const stoppedRequests = requests;
            await runInNewContext("refresh()", context);
            runInNewContext("render({run:{state:'idle'}})", context);
            assert.equal(requests, stoppedRequests);
            assert.match(element("run-state").textContent, /close in 5 seconds/);
            timers[0]!.callback();
            assert.equal(closes, 1);
            assert.match(element("run-state").textContent, /browser kept this page open/);
        } else {
            assert.equal(timers.length, 0);
            assert.equal(element("stop").disabled, false);
            const activeRequests = requests;
            await runInNewContext("refresh()", context);
            assert.equal(requests, activeRequests + 1);
        }
    }
});

test("certificate generation is explicit, deployment uses snapshots, and a failed run can be retried", async t => {
    if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) { t.skip("OpenSSL is unavailable"); return; }
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-lifecycle-"));
    mkdirSync(join(root, "credentials"));
    const config = { suiteapps: [{ directory: "app", url: "https://gitlab.eng.netsuite.com/team/app.git" }], vms: [{ account: "000071", url: "runbox.vm.eng.netsuite.com" }] };
    const configFile = join(root, "suitecontainer.config.json");
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(join(root, "credentials/auth.json"), JSON.stringify(emptyAuth));
    const outsidePublic = join(root, "external-public.pem");
    const outsidePrivate = join(root, "external-private.pem");
    writeFileSync(outsidePublic, "external public");
    writeFileSync(outsidePrivate, "external private");
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify({ ...record, certificates: { "/outside/public.pem": outsidePublic, "/outside/private.pem": outsidePrivate } }));
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
        assert.equal((await post("generate")).status, 400);
        assert.equal((await post("generate", { replace: true })).status, 200);
        assert.equal((await state()).relaunch, false);
        assert.equal(readFileSync(outsidePublic, "utf8"), "external public");
        assert.equal(readFileSync(outsidePrivate, "utf8"), "external private");
        assert.equal((await state()).certificates.canGenerate, true);
        assert.equal((await state()).ready, false);
        assert.equal((await fetch(origin + "/api/certificate", { headers })).status, 200);
        assert.equal((await post("credentials", { id: "certificate-id", token: "worker-secret" })).status, 200);
        assert.equal((await state()).ready, true);
        const oldPublic = readFileSync(join(root, "credentials/public.pem"), "utf8");
        assert.equal((await post("generate")).status, 400);
        assert.equal(readFileSync(join(root, "credentials/public.pem"), "utf8"), oldPublic);
        assert.equal((await post("generate", { replace: true })).status, 200);
        assert.notEqual(readFileSync(join(root, "credentials/public.pem"), "utf8"), oldPublic);
        assert.equal((await state()).certificates.id, "");
        assert.equal((await state()).ready, false);
        assert.equal((await post("credentials", { id: "replacement-id" })).status, 200);
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
    assert.equal(mountChanges(config, emptyAuth, mounted, true), false);
    assert.equal(mountChanges({ ...config, suiteapps: [] }, emptyAuth, mounted, true), true);
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
        const completedConfig = { ...config, vms: [{ ...config.vms[0], url: "current.vm.eng.netsuite.com" }] };
        const credentialResponse = await fetch(origin + "/api/credentials", { method: "POST", headers, body: JSON.stringify({ token: "hidden-secret", config: JSON.stringify(completedConfig) }) });
        assert.equal(credentialResponse.status, 200);
        assert.ok(!(await credentialResponse.text()).includes("hidden-secret"));
        assert.equal(JSON.parse(readFileSync(join(root, "credentials/auth.json"), "utf8"))["gitlab-token"], "hidden-secret");
        assert.deepEqual(JSON.parse(readFileSync(join(root, "suitecontainer.config.json"), "utf8")), completedConfig);
        assert.equal((await fetch(origin + "/api/credentials", { method: "POST", headers, body: JSON.stringify({ token: "should-not-save", config: "invalid JSON" }) })).status, 400);
        assert.equal(JSON.parse(readFileSync(join(root, "credentials/auth.json"), "utf8"))["gitlab-token"], "hidden-secret");
        writeFileSync(join(root, "credentials/private.pem"), "existing file");
        const partial = await (await fetch(origin + "/api/state", { headers })).json();
        assert.equal(partial.certificates.canGenerate, true);
        assert.equal(partial.certificates.hasExisting, true);
        assert.equal((await fetch(origin + "/api/generate", { method: "POST", headers, body: '{}' })).status, 400);
        assert.equal(readFileSync(join(root, "credentials/private.pem"), "utf8"), "existing file");
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});
