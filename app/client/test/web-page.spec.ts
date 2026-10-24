import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { ACTIVITY_GRACE_MS } from "../../src/web-inactivity.ts";
import { ansiToHtml, ansiStyles } from "../src/ansi.ts";
import { deploymentPage } from "../src/web-page.ts";
import { initializeBrowser } from "./browser-harness.ts";

const sqlConfig = { suiteapps: [], vms: [{ account: "000071", url: "first.vm.eng.netsuite.com" }, { account: "000072", url: "second.vm.eng.netsuite.com" }] };
const sqlInput = { host: sqlConfig.vms[1].url, account: "TEST_ACCOUNT", database: "test.service", password: "test/$& secret", sql: "select 'hello' from dual;" };

test("ANSI converter is self-contained in the served browser script", () => {
    const browserConverter = new Function(`${deploymentPage.script.split("document.addEventListener('alpine:init'")[0]} return ansiToHtml;`)();
    assert.equal(browserConverter('\x1b[31m<red>'), ansiToHtml('\x1b[31m<red>'));
    assert.ok(deploymentPage.script.includes('log.innerHTML = ansiToHtml(next.run.log)'));
    assert.ok(deploymentPage.style.includes(ansiStyles));
    new Function(deploymentPage.script);
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

test("Current VM preserves accounts and other scrumboxes, synchronizes JSON edits, and saves with credentials", async () => {
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
    assert.ok(deploymentPage.html.indexOf('<h2>SQL queries</h2>') > deploymentPage.html.indexOf('Configuration JSON'));
    assert.ok(deploymentPage.html.indexOf('<h2>SQL queries</h2>') < deploymentPage.html.indexOf('<h2>Deploy SuiteApps</h2>'));
    assert.ok(!deploymentPage.html.includes('id="sql-target"'));
});

test("the browser offers separate masked manual and unlock fields and sends only the chosen credential", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "", querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
        return elements.get(id);
    };
    const state = { config: '{"vms":[{"url":"scrumbox.vm.eng.netsuite.com"}]}', certificates: {}, run: { state: "idle", log: "" }, ready: false,
        sql: { state: "idle", output: "", defaults: { user: "TEST_USER", service: "test.service" }, passwordHint: "hint", hasDefaultPassword: true } };
    let sent: any;
    const context = { document: { getElementById: element, addEventListener() {} }, location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {},
        fetch: async (path: string, options: any) => { if (path === "/api/sql") sent = JSON.parse(options.body); return { ok: true, json: async () => state }; } };
    initializeBrowser(context);
    await new Promise(resolve => setImmediate(resolve));
    element("sql-statement").value = "SELECT 1 FROM dual;";
    element("sql-password").value = "manual-password";
    element("sql-password").input();
    assert.equal(element("sql-run").disabled, false);
    await element("sql-run").click();
    assert.equal(sent.password, "manual-password");
    assert.equal(sent.unlock, undefined);
    element("sql-unlock").value = "unlock-string";
    element("sql-unlock").input();
    assert.equal(element("sql-password").value, "");
    assert.equal(element("sql-run").disabled, false);
    await element("sql-run").click();
    assert.equal(sent.unlock, "unlock-string");
    assert.equal(sent.password, undefined);
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-unlock").value, "unlock-string");
    element("sql-password").value = "another-manual-password";
    element("sql-password").input();
    assert.equal(element("sql-unlock").value, "");
    state.sql.hasDefaultPassword = false;
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-unlock").disabled, true);
    assert.equal(element("sql-run").disabled, false);
    assert.match(deploymentPage.html, /id="sql-unlock" type="password"/);
    assert.match(deploymentPage.html, /<div class="grid"><div><label for="sql-password">[\s\S]*?<div><label for="sql-unlock">[\s\S]*?<\/div><\/div>/);
    element("sql-account").value = "MANUAL_USER";
    element("sql-account").input();
    state.sql.defaults = { user: "UPDATED_USER", service: "updated.service" };
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-account").value, "MANUAL_USER");
    assert.equal(element("sql-database").value, "updated.service");
    state.config = '{"vms":[{"url":"other.vm.eng.netsuite.com"}]}';
    state.sql.defaults = { user: "OTHER_USER", service: "other.service" };
    await runInNewContext("refresh()", context);
    assert.equal(element("sql-account").value, "OTHER_USER");
    assert.equal(element("sql-database").value, "other.service");
});
