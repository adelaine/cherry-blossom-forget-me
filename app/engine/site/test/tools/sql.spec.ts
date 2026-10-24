import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { browserHtml, initializeBrowser } from "../browser-harness.ts";

const sqlConfig = {
    suiteapps: [],
    vms: [
        { account: "000071", url: "first.vm.eng.netsuite.com" },
        { account: "000072", url: "second.vm.eng.netsuite.com" },
    ],
};
const sqlInput = {
    host: sqlConfig.vms[1].url,
    account: "TEST_ACCOUNT",
    database: "test.service",
    password: "test/$& secret",
    sql: "select 'hello' from dual;",
};

test("SQL browser fields preserve edits, use Current VM, render output as text, and retain request errors", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id))
            elements.set(id, {
                value: "",
                children: [],
                replaceChildren(...children: any[]) {
                    this.children = children;
                },
                querySelectorAll: () => [],
                addEventListener(event: string, handler: Function) {
                    this[event] = handler;
                },
            });
        return elements.get(id);
    };
    const idle = {
        config: JSON.stringify(sqlConfig),
        certificates: {},
        run: { state: "idle", log: "" },
        ready: false,
        sql: {
            state: "idle",
            output: "",
            defaults: { user: "TEST_ACCOUNT", service: "test.service" },
            passwordHint: "<a riddle & hint>",
        },
    };
    let response: any = idle,
        sent: any,
        reject = false;
    const context = {
        document: {
            getElementById: element,
            createElement: () => ({}),
            addEventListener() {},
        },
        location: { hash: "", pathname: "/" },
        URLSearchParams,
        AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} },
        history: { replaceState() {} },
        setInterval() {},
        setTimeout() {},
        clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/sql") {
                sent = JSON.parse(options.body);
                if (reject)
                    return {
                        ok: false,
                        json: async () => ({
                            error: "Connection input is invalid.",
                        }),
                    };
                response = {
                    ...idle,
                    sql: {
                        ...idle.sql,
                        state: "running",
                        host: JSON.parse(sent.config).vms[0].url,
                        database: sent.database,
                    },
                };
            }
            return { ok: true, json: async () => response };
        },
    };
    initializeBrowser(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(element("sql-account").value, "TEST_ACCOUNT");
    assert.equal(element("sql-password").value, "");
    assert.equal(element("sql-password-hint").textContent, "<a riddle & hint>");
    element("sql-account").value = "OTHER_ACCOUNT";
    element("sql-account").input();
    element("sql-password").value = sqlInput.password;
    element("sql-password").input();
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
    response = {
        ...idle,
        sql: {
            ...response.sql,
            state: "succeeded",
            output: "<script>query data</script>",
        },
    };
    await runInNewContext("refresh()", context);
    assert.equal(
        element("sql-output").textContent,
        "<script>query data</script>",
    );
    assert.equal(
        element("sql-output").innerHTML,
        "&lt;script&gt;query data&lt;/script&gt;",
    );
    assert.equal(element("sql-run").disabled, false);
    assert.equal(element("sql-password").value, sqlInput.password);
    const changed = {
        ...sqlConfig,
        vms: [{ ...sqlConfig.vms[0], url: "" }, sqlConfig.vms[1]],
    };
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
    assert.equal(
        JSON.parse(sent.config).vms[0].url,
        "changed.vm.eng.netsuite.com",
    );
    await runInNewContext("refresh()", context);
    assert.match(
        element("sql-message").textContent,
        /Connection input is invalid/,
    );
    assert.ok(
        browserHtml(context).indexOf("<h2>SQL queries</h2>") >
            browserHtml(context).indexOf("Configuration JSON"),
    );
    assert.ok(
        browserHtml(context).indexOf("<h2>SQL queries</h2>") <
            browserHtml(context).indexOf("<h2>Deploy SuiteApps</h2>"),
    );
    assert.ok(!browserHtml(context).includes('id="sql-target"'));
});

test("the browser offers separate masked manual and unlock fields and sends only the chosen credential", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id))
            elements.set(id, {
                value: "",
                querySelectorAll: () => [],
                addEventListener(event: string, handler: Function) {
                    this[event] = handler;
                },
            });
        return elements.get(id);
    };
    const state = {
        config: '{"vms":[{"url":"scrumbox.vm.eng.netsuite.com"}]}',
        certificates: {},
        run: { state: "idle", log: "" },
        ready: false,
        sql: {
            state: "idle",
            output: "",
            defaults: { user: "TEST_USER", service: "test.service" },
            passwordHint: "hint",
            hasDefaultPassword: true,
        },
    };
    let sent: any;
    const context = {
        document: { getElementById: element, addEventListener() {} },
        location: { hash: "", pathname: "/" },
        URLSearchParams,
        AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} },
        history: { replaceState() {} },
        setInterval() {},
        setTimeout() {},
        clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/sql") sent = JSON.parse(options.body);
            return { ok: true, json: async () => state };
        },
    };
    initializeBrowser(context);
    await new Promise((resolve) => setImmediate(resolve));
    element("sql-statement").value = "SELECT 1 FROM dual;";
    element("sql-statement").input();
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
    assert.match(browserHtml(context), /id="sql-unlock" type="password"/);
    assert.match(
        browserHtml(context),
        /<div class="grid"><div><label for="sql-password">[\s\S]*?<div><label for="sql-unlock">[\s\S]*?<\/div><\/div>/,
    );
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
