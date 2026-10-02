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
import { initializeBrowser } from "./browser-harness.ts";
import { credentialPath, type MountRecord } from "../src/web-mounts.ts";
import type { Auth } from "../src/step-auth.ts";
import { ansiToHtml, ansiStyles, applyAnsiColors } from "../src/ansi.ts";
import { deploymentPage } from "../src/web-page.ts";
import { replaceCertificates } from "../src/step-certificates.ts";
import { ACTIVITY_GRACE_MS, HeartbeatDeadline } from "../src/web-inactivity.ts";
import { startSql, validateSqlRequest } from "../src/sql-runner.ts";
import { SQL_DEFAULTS, SQL_PASSWORD_HINT } from "../src/sql-settings.ts";

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
    const browserApply = new Function(`${deploymentPage.script.split("document.addEventListener('alpine:init'")[0]} return applyAnsiColors;`)();
    browserApply(root);
    assert.ok(deploymentPage.script.includes('applyAnsiColors(log)'));
});

test("ANSI converter is self-contained in the served browser script", () => {
    const browserConverter = new Function(`${deploymentPage.script.split("document.addEventListener('alpine:init'")[0]} return ansiToHtml;`)();
    assert.equal(browserConverter('\x1b[31m<red>'), ansiToHtml('\x1b[31m<red>'));
    assert.ok(deploymentPage.script.includes('log.innerHTML = ansiToHtml(next.run.log)'));
    assert.ok(deploymentPage.style.includes(ansiStyles));
    new Function(deploymentPage.script);
});

test("the page loads local Pico and registers Alpine before its deferred CSP runtime", () => {
    assert.match(deploymentPage.html, /<link rel="stylesheet" href="\/pico.css">/);
    assert.match(deploymentPage.html, /<main class="container" x-data="deployment" x-cloak>/);
    assert.ok(deploymentPage.html.indexOf('src="/page.js"') < deploymentPage.html.indexOf('src="/alpine.js"'));
    assert.match(deploymentPage.html, /<script src="\/alpine.js" defer><\/script>/);
    assert.match(deploymentPage.html, /@click="clickdeploy"/);
    assert.match(deploymentPage.html, /:disabled="view.deploy.disabled"/);
    assert.match(deploymentPage.html, /x-text="view.validation.text"/);
    assert.ok(deploymentPage.html.includes('class="grid"'));
    assert.ok(!deploymentPage.style.includes('button{'));
    assert.ok(!deploymentPage.style.includes('input,textarea{'));
    assert.ok(!/onclick=|oninput=|<script>/.test(deploymentPage.html));
});

const require = createRequire(import.meta.url);
const { tokenIn, run: importToken } = require("../../setup/bootstrap/bootstrap-token.cjs");
const record: MountRecord = { hostRoot: "/project", platform: "linux", local: {}, certificates: {} };
const emptyAuth: Auth = { "gitlab-token": "", "suitecloud-certificates": { public: "", private: "", id: "" } };

test("heartbeat deadline expires at fifteen minutes and gives busy jobs a fresh grace period", () => {
    let now = 0;
    const deadline = new HeartbeatDeadline(() => now);
    now = ACTIVITY_GRACE_MS - 1;
    assert.equal(deadline.expired(false), false);
    now++;
    assert.equal(deadline.expired(false), true);
    deadline.heartbeat();
    now += ACTIVITY_GRACE_MS;
    assert.equal(deadline.expired(true), false);
    now += ACTIVITY_GRACE_MS - 1;
    assert.equal(deadline.expired(false), false);
    now++;
    assert.equal(deadline.expired(false), true);
});

test("only authenticated same-origin heartbeats keep the server alive; polling does not", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-idle-"));
    mkdirSync(join(root, "credentials"));
    const config = JSON.stringify({ suiteapps: [], vms: [] });
    writeFileSync(join(root, "suitecontainer.config.json"), config);
    writeFileSync(join(root, "credentials/auth.json"), JSON.stringify(emptyAuth));
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify(record));
    const sessionFile = join(root, "session");
    let now = 0, stops = 0;
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile,
        inactivityNow: () => now, inactivityCheckMs: 10, signalHandlers: false, onStop() { stops++; } });
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const headers = { Origin: origin, "Content-Type": "application/json", "X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1] };
        const post = (path: string, data = {}) => fetch(origin + "/api/" + path, { method: "POST", headers, body: JSON.stringify(data) });
        now = ACTIVITY_GRACE_MS - 30_000;
        assert.equal((await post("heartbeat")).status, 200);
        const heartbeatAt = now;
        now = ACTIVITY_GRACE_MS;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(server.listening, true);
        now = heartbeatAt + ACTIVITY_GRACE_MS - 1;
        assert.equal((await fetch(origin + "/api/state", { headers })).status, 200);
        assert.equal((await post("check", { config })).status, 200);
        assert.equal((await fetch(origin + "/health")).status, 200);
        assert.equal((await fetch(origin + "/api/heartbeat", { method: "POST", body: "{}" })).status, 403);
        assert.equal((await fetch(origin + "/api/heartbeat", { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: "{}" })).status, 403);
        const closed = once(server, "close");
        now++;
        await closed;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(stops, 1);
        assert.equal(server.listening, false);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});

test("browser heartbeat follows real activity, stops after fifteen minutes, and reports server loss without losing edits", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "", replaceChildren() {}, querySelectorAll: () => [], addEventListener() {} });
        return elements.get(id);
    };
    const events = new Map<string, (event: { isTrusted: boolean }) => void>();
    const intervals: number[] = [], requests: string[] = [], timers: (() => void)[] = [];
    let now = 0, offline = false, closes = 0;
    const next = { config: '{"vms":[]}', certificates: {}, run: { state: "idle", log: "" }, ready: false };
    const context = {
        document: { getElementById: element, createElement: () => ({}), querySelectorAll: () => [...elements.values()], addEventListener(event: string, handler: (event: { isTrusted: boolean }) => void) { events.set(event, handler); } },
        location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal, Date: { now: () => now },
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
        setInterval(_callback: Function, delay: number) { intervals.push(delay); }, setTimeout(callback: () => void) { timers.push(callback); }, clearTimeout() {},
        window: { close() { closes++; } },
        fetch: async (path: string) => { requests.push(path); if (offline) throw new Error("fetch failed"); return { ok: true, json: async () => next }; },
    };
    initializeBrowser(context);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(intervals.includes(30_000));
    const beats = () => requests.filter(path => path === "/api/heartbeat").length;
    assert.equal(beats(), 1);
    now = ACTIVITY_GRACE_MS - 30_000;
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 2);
    now = ACTIVITY_GRACE_MS;
    await runInNewContext("refresh(); heartbeat()", context);
    assert.equal(beats(), 2);
    events.get("scroll")!({ isTrusted: false });
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 2);
    events.get("input")!({ isTrusted: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(beats(), 3);
    now += ACTIVITY_GRACE_MS;
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 3);
    element("config").value = "unsaved edits";
    runInNewContext("editing = true", context);
    offline = true;
    await runInNewContext("refresh()", context);
    assert.equal(element("connection-error").hidden, false);
    assert.match(element("connection-error").textContent, /Start the launcher again/);
    assert.equal(element("config").value, "unsaved edits");
    assert.equal(element("save").disabled, true);
    assert.equal(element("sql-run").disabled, true);
    runInNewContext("render(state)", context);
    assert.equal(element("save").disabled, true);
    assert.equal(closes, 0);
    timers[0]!();
    assert.equal(closes, 1);
    offline = false;
    await runInNewContext("refresh()", context);
    assert.equal(element("connection-error").hidden, true);
    assert.equal(element("config").value, "unsaved edits");
    assert.equal(element("save").disabled, false);
    assert.equal(element("download").disabled, false);
    offline = true;
    events.get("click")!({ isTrusted: true });
    const scheduled = timers.length;
    await runInNewContext("refresh()", context);
    assert.equal(timers.length, scheduled);
    assert.equal(element("connection-error").hidden, false);
});

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
        if (!elements.has(id)) elements.set(id, { value: "", replaceChildren() {}, querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
        return elements.get(id);
    };
    const config = { suiteapps: [], vms: [{ account: "000072", url: "old.vm.eng.netsuite.com" }, { account: "000073", url: "second.vm.eng.netsuite.com" }] };
    let saved: any;
    const next = { config: JSON.stringify(config), certificates: {}, run: { state: "idle", log: "" }, ready: false };
    const context = {
        document: { getElementById: element, createElement: () => ({}), addEventListener() {} }, location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
        setInterval() {}, setTimeout() {}, clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/credentials") { saved = JSON.parse(options.body); next.config = saved.config; }
            return { ok: true, json: async () => next };
        },
    };
    initializeBrowser(context);
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
    runInNewContext("editing = false; credentialEditing = false; render({...state,run:{state:'running',log:''}})", context);
    assert.match(element("validation").textContent, /Deployment is running/);
    runInNewContext("render({...state,run:{state:'idle',log:''},sql:{state:'running',output:'',defaults:{user:'',service:''}}})", context);
    assert.match(element("validation").textContent, /SQL is running/);
    runInNewContext("render({...state,sql:{...state.sql,state:'idle',preparing:true}})", context);
    assert.match(element("validation").textContent, /Unlocking the saved SQL password/);
});

test("Stop app closes after five seconds only on success and explains blocked closure", async () => {
    for (const success of [true, false]) {
        const elements = new Map<string, any>();
        const element = (id: string) => {
            if (!elements.has(id)) elements.set(id, { value: "", replaceChildren() {}, querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
            return elements.get(id);
        };
        const timers: { callback: () => void; delay: number }[] = [];
        let closes = 0;
        let requests = 0;
        const state = { config: '{"vms":[]}', certificates: {}, run: { state: "idle", log: "" }, ready: false };
        const context = {
            document: { getElementById: element, querySelectorAll: () => [element("stop"), element("deploy")], addEventListener() {} },
            location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal,
            sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
            setInterval() {}, clearTimeout() {},
            setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); },
            window: { closed: false, close() { closes++; } },
            fetch: async (path: string) => { requests++; return { ok: path !== "/api/stop" || success, json: async () => path === "/api/stop" ? { error: "Deployment is running." } : state }; },
        };
        initializeBrowser(context);
        await new Promise(resolve => setImmediate(resolve));
        await element("stop").click();
        assert.equal(closes, 0);
        if (success) {
            assert.equal(timers.length, 1);
            assert.equal(timers[0]!.delay, 5000);
            assert.match(element("run-state").textContent, /Attempting to close this page/);
            assert.equal(element("stop").disabled, true);
            const stoppedRequests = requests;
            await runInNewContext("refresh()", context);
            runInNewContext("render({run:{state:'idle'}})", context);
            assert.equal(requests, stoppedRequests);
            assert.match(element("run-state").textContent, /Attempting to close this page/);
            timers[0]!.callback();
            assert.equal(closes, 1);
            assert.match(element("run-state").textContent, /browser kept this page open/);
        } else {
            assert.equal(timers.length, 0);
            assert.equal(element("stop").disabled, false);
            assert.match(element("validation").textContent, /Deployment is running/);
            const activeRequests = requests;
            await runInNewContext("refresh()", context);
            assert.equal(requests, activeRequests + 1);
            assert.match(element("validation").textContent, /Deployment is running/);
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
    let now = 0;
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile, workerScript, onStop: () => {}, signalHandlers: false,
        inactivityNow: () => now, inactivityCheckMs: 10 });
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
        now += ACTIVITY_GRACE_MS + 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(server.listening, true);
        assert.equal((await state()).run.state, "running");
        assert.equal((await post("heartbeat")).status, 200);
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
        now += ACTIVITY_GRACE_MS - 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(server.listening, true);
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

const sqlConfig = { suiteapps: [], vms: [{ account: "000071", url: "first.vm.eng.netsuite.com" }, { account: "000072", url: "second.vm.eng.netsuite.com" }] };
const sqlInput = { host: sqlConfig.vms[1].url, account: "TEST_ACCOUNT", database: "test.service", password: "test/$& secret", sql: "select 'hello' from dual;" };

function sqlStub(root: string): string {
    const script = join(root, "sqlplus.cjs");
    writeFileSync(script, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
    const mode = process.argv[2];
    const marker = input.match(/^prompt (SUITECONTAINER_SQL_[a-f0-9]+)$/m)?.[1];
    if (mode === 'hang') { setInterval(() => {}, 1000); return; }
    if (mode === 'missing-end') return;
    if (mode === 'sql-error') { console.log('ORA-00942: table or view does not exist'); process.exitCode = 1; return; }
    if (mode === 'command-error') { console.log('SP2-0734: unknown command'); console.log(marker); return; }
    if (mode === 'large-error') { console.log('SP2-0734: unknown command'); console.log('x'.repeat(600000)); console.log(marker); return; }
    setTimeout(() => {
        console.log(JSON.stringify(process.argv.slice(3)));
        process.stdout.write(input.slice(0, input.indexOf(' secret')));
        setTimeout(() => { console.log(input.slice(input.indexOf(' secret'))); console.log('hello'); console.log(marker); }, 20);
    }, mode === 'delay' ? 300 : 0);
});
`);
    return script;
}

test("SQL validates configured targets and connection fields without SuiteCloud credentials", () => {
    assert.deepEqual(validateSqlRequest(sqlInput, sqlConfig), sqlInput);
    for (const override of [
        { host: "other.vm.eng.netsuite.com" }, { host: "localhost" }, { account: 'user\nHOST command' },
        { database: 'db"/bad' }, { password: 'bad"password' }, { password: "line\nbreak" },
        { password: "" }, { sql: "" }, { sql: "select 1 from dual" }, { sql: "x".repeat(65537) },
    ]) assert.throws(() => validateSqlRequest({ ...sqlInput, ...override }, sqlConfig));
    assert.throws(() => validateSqlRequest(sqlInput, { vms: [] }));
    assert.throws(() => validateSqlRequest(sqlInput, null));
});

test("SQL worker keeps credentials off arguments, redacts split output, and rolls back on exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-sql-"));
    try {
        const worker = startSql(sqlInput, { command: process.execPath, args: [sqlStub(root), "success"] });
        const result = await worker.result;
        assert.equal(result.state, "succeeded");
        assert.match(result.output, /\["-L","-S","-R","3","\/nolog"\]/);
        assert.match(result.output, /second.vm.eng.netsuite.com:1521\/test.service/);
        assert.match(result.output, /set autocommit off/);
        assert.match(result.output, /whenever sqlerror exit failure rollback/);
        assert.match(result.output, /exit success rollback/);
        assert.match(result.output, /\[redacted\]/);
        assert.ok(!result.output.includes(sqlInput.password));
        assert.ok(!result.output.includes("SUITECONTAINER_SQL_"));
        assert.ok(!worker.child.spawnargs.join(" ").includes(sqlInput.password));
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SQL worker reports Oracle errors, SQL*Plus errors, incomplete input, timeout, and missing executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-sql-errors-"));
    try {
        const stub = sqlStub(root);
        for (const [mode, expected] of [
            ["sql-error", /ORA-00942/], ["command-error", /SP2-0734/],
            ["missing-end", /did not finish/], ["hang", /timed out/], ["large-error", /Earlier output omitted/],
        ] as const) {
            const result = await startSql(sqlInput, { command: process.execPath, args: [stub, mode], timeoutMs: mode === "hang" ? 150 : 5000 }).result;
            assert.equal(result.state, "failed", mode);
            assert.match(result.output, expected);
            assert.ok(result.output.length < 530000);
        }
        const missing = await startSql(sqlInput, { command: join(root, "missing-sqlplus") }).result;
        assert.equal(missing.state, "failed");
        assert.match(missing.output, /Rebuild the container/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SQL endpoint requires authorization, preserves settings, blocks concurrent actions, and permits retry", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-sql-web-"));
    mkdirSync(join(root, "credentials"));
    const configFile = join(root, "suitecontainer.config.json");
    const authFile = join(root, "credentials/auth.json");
    writeFileSync(configFile, JSON.stringify(sqlConfig));
    writeFileSync(authFile, JSON.stringify(emptyAuth));
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify(record));
    const sessionFile = join(root, "session");
    let now = 0;
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile,
        sqlCommand: process.execPath, sqlArgs: [sqlStub(root), "delay"], onStop() {}, signalHandlers: false,
        inactivityNow: () => now, inactivityCheckMs: 10 });
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const token = readFileSync(sessionFile, "utf8").split("session=")[1];
        const headers = { "X-Session-Token": token, "Content-Type": "application/json", Origin: origin };
        const request = { ...sqlInput, config: JSON.stringify(sqlConfig) };
        const post = (path: string, value: unknown = request) => fetch(origin + "/api/" + path, { method: "POST", headers, body: JSON.stringify(value) });
        assert.equal((await fetch(origin + "/api/sql", { method: "POST", body: JSON.stringify(request) })).status, 403);
        assert.equal((await fetch(origin + "/api/sql", { method: "POST", headers: { ...headers, Origin: "https://other.example" }, body: JSON.stringify(request) })).status, 403);
        assert.equal((await post("sql", { ...request, config: JSON.stringify({ ...sqlConfig, vms: [{ ...sqlConfig.vms[0], url: "" }, sqlConfig.vms[1]] }) })).status, 400);
        const first = await post("sql");
        assert.equal(first.status, 202);
        const running = await first.json();
        assert.equal(running.sql.state, "running");
        now += ACTIVITY_GRACE_MS + 1;
        await new Promise(resolve => setTimeout(resolve, 25));
        assert.equal(server.listening, true);
        assert.equal((await post("heartbeat", {})).status, 200);
        assert.equal(running.sql.host, sqlConfig.vms[0].url);
        assert.deepEqual(running.sql.defaults, SQL_DEFAULTS);
        assert.equal(running.sql.passwordHint, SQL_PASSWORD_HINT);
        assert.ok(!JSON.stringify(running).includes(sqlInput.password));
        for (const path of ["sql", "deploy", "credentials", "settings", "generate", "stop"]) assert.equal((await post(path)).status, 409);
        assert.equal((await post("check", { config: JSON.stringify(sqlConfig) })).status, 200);
        let finished: any;
        for (let attempt = 0; attempt < 60; attempt++) {
            finished = await (await fetch(origin + "/api/state", { headers })).json();
            if (finished.sql.state !== "running") break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.equal(finished.sql.state, "succeeded");
        assert.match(finished.sql.output, /hello/);
        assert.ok(!JSON.stringify(finished).includes(sqlInput.password));
        assert.equal(readFileSync(configFile, "utf8"), JSON.stringify(sqlConfig));
        assert.equal(readFileSync(authFile, "utf8"), JSON.stringify(emptyAuth));
        assert.equal((await post("sql")).status, 202);
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        // The server close hook terminates any last SQL worker; wait for its close event.
        await new Promise(resolve => setTimeout(resolve, 100));
        rmSync(root, { recursive: true, force: true });
    }
});

test("SQL browser fields preserve edits, use Current VM, render output as text, and retain request errors", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "", children: [], replaceChildren(...children: any[]) { this.children = children; },
            querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
        return elements.get(id);
    };
    const idle = { config: JSON.stringify(sqlConfig), certificates: {}, run: { state: "idle", log: "" }, ready: false,
        sql: { state: "idle", output: "", defaults: { user: "TEST_ACCOUNT", service: "test.service" }, passwordHint: '<a riddle & hint>' } };
    let response: any = idle, sent: any, reject = false;
    const context = {
        document: { getElementById: element, createElement: () => ({}), addEventListener() {} }, location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} },
        setInterval() {}, setTimeout() {}, clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/sql") {
                sent = JSON.parse(options.body);
                if (reject) return { ok: false, json: async () => ({ error: "Connection input is invalid." }) };
                response = { ...idle, sql: { ...idle.sql, state: "running", host: JSON.parse(sent.config).vms[0].url, database: sent.database } };
            }
            return { ok: true, json: async () => response };
        },
    };
    initializeBrowser(context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(element("sql-account").value, "TEST_ACCOUNT");
    assert.equal(element("sql-password").value, "");
    assert.equal(element("sql-password-hint").textContent, '<a riddle & hint>');
    element("sql-account").value = "OTHER_ACCOUNT";
    element("sql-account").input();
    element("sql-password").value = sqlInput.password;
    element("sql-statement").value = sqlInput.sql;
    element("sql-statement").input();
    assert.equal(element("sql-run").disabled, false);
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-account").value, "OTHER_ACCOUNT");
    await element("sql-run").click();
    assert.equal(sent.host, undefined);
    assert.equal(JSON.parse(sent.config).vms[0].url, sqlConfig.vms[0].url);
    assert.equal(sent.account, "OTHER_ACCOUNT");
    assert.equal(sent.password, sqlInput.password);
    assert.equal(element("sql-run").disabled, true);
    assert.equal(element("sql-password").disabled, true);
    assert.equal(element("stop").disabled, true);
    response = { ...idle, sql: { ...response.sql, state: "succeeded", output: '<script>query data</script>' } };
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-output").textContent, '<script>query data</script>');
    assert.equal(element("sql-output").innerHTML, undefined);
    assert.equal(element("sql-run").disabled, false);
    assert.equal(element("sql-password").value, sqlInput.password);
    const changed = { ...sqlConfig, vms: [{ ...sqlConfig.vms[0], url: "" }, sqlConfig.vms[1]] };
    element("config").value = JSON.stringify(changed);
    element("config").input();
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-run").disabled, true);
    element("vm").value = "changed.vm.eng.netsuite.com";
    element("vm").input();
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-run").disabled, false);
    reject = true;
    await element("sql-run").click();
    assert.equal(JSON.parse(sent.config).vms[0].url, "changed.vm.eng.netsuite.com");
    await runInNewContext("refresh()", context);
    assert.match(element("sql-message").textContent, /Connection input is invalid/);
    assert.ok(deploymentPage.html.indexOf('<h2>SQL</h2>') > deploymentPage.html.indexOf('Configuration JSON'));
    assert.ok(deploymentPage.html.indexOf('<h2>SQL</h2>') < deploymentPage.html.indexOf('<h2>Deployment</h2>'));
    assert.match(deploymentPage.html, /<h2>SQL<\/h2><details id="sql-details"[^>]*><summary>Connection and SQL statement<\/summary>/);
    assert.ok(!deploymentPage.html.includes('id="sql-target"'));
});
