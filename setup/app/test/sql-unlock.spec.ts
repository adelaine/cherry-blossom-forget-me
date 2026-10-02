import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { startWebServer } from "../src/web-server.ts";
import { encryptSqlPassword } from "../src/sql-password-crypto.ts";
import { SQL_PASSWORD_SALT } from "../src/sql-settings.ts";
import { deploymentPage } from "../src/web-page.ts";

test("SQL unlock seeds .sql-user once, uses VM database defaults, and permits safe retries and manual passwords", async () => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-sql-unlock-"));
    const credentials = join(root, "credentials");
    mkdirSync(credentials);
    const config = { suiteapps: [], vms: [{ account: "000071", url: "runbox.vm.eng.netsuite.com", database: { user: "CONFIG_USER", service: "config.service" } }] };
    const configText = JSON.stringify(config), authText = '{}';
    writeFileSync(join(root, "suitecontainer.config.json"), configText);
    writeFileSync(join(credentials, "auth.json"), authText);
    writeFileSync(join(credentials, "web-mounts.json"), JSON.stringify({ hostRoot: "/project", platform: "linux", local: {}, certificates: {} }));
    const password = "fake-default-SQL-password", unlock = "fake-unlock-string";
    const encrypted = await encryptSqlPassword(password, unlock, SQL_PASSWORD_SALT);
    const defaultFile = join(credentials, ".sql-default");
    const userFile = join(credentials, ".sql-user");
    writeFileSync(defaultFile, encrypted + "\n");
    const stub = join(root, "worker.cjs");
    writeFileSync(stub, `let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => setTimeout(() => {
        console.log('used default: ' + input.includes('/"${password}"@'));
        console.log('${password}');
        console.log(input.match(/^prompt (SUITECONTAINER_SQL_[a-f0-9]+)$/m)[1]);
    }, 100));`);
    const sessionFile = join(root, "session");
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile, sqlCommand: process.execPath, sqlArgs: [stub], signalHandlers: false, onStop() {} });
    try {
        await once(server, "listening");
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const origin = `http://127.0.0.1:${address.port}`;
        const headers = { "X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1], "Content-Type": "application/json", Origin: origin };
        const state = async () => (await fetch(origin + "/api/state", { headers })).json();
        const base = { config: configText, account: "TEST_USER", database: "test.service", sql: "SELECT 1 FROM dual;" };
        const post = (data: unknown) => fetch(origin + "/api/sql", { method: "POST", headers, body: JSON.stringify(data) });
        assert.equal((await state()).sql.hasDefaultPassword, true);
        assert.equal(readFileSync(userFile, "utf8"), encrypted + "\n");
        assert.deepEqual((await state()).sql.defaults, config.vms[0].database);
        const changedConfig = { ...config, vms: [{ ...config.vms[0], database: { user: "EDITED_USER", service: "edited.service" } },
            { account: "000072", url: "other.vm.eng.netsuite.com", database: { user: "OTHER_USER", service: "other.service" } }] };
        const checked = await fetch(origin + "/api/check", { method: "POST", headers, body: JSON.stringify({ config: JSON.stringify(changedConfig) }) });
        assert.equal(checked.status, 200);
        assert.deepEqual((await checked.json()).sql.defaults, changedConfig.vms[0].database);
        assert.equal((await post({ ...base, unlock: "wrong-unlock-string" })).status, 400);
        assert.equal((await state()).sql.preparing, false);
        assert.equal((await state()).sql.state, "idle");
        assert.equal((await post({ ...base, password, unlock })).status, 400);
        const pending = post({ ...base, unlock });
        let preparing = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            if ((await state()).sql.preparing) { preparing = true; break; }
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(preparing, true);
        assert.equal((await post({ ...base, password })).status, 409);
        const response = await pending;
        assert.equal(response.status, 202);
        const responseText = await response.text();
        assert.ok(!responseText.includes(password) && !responseText.includes(unlock) && !responseText.includes(encrypted));
        const finish = async () => {
            for (let attempt = 0; attempt < 100; attempt++) {
                const next = await state();
                if (next.sql.state !== "running") return next;
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            throw new Error("SQL worker did not finish.");
        };
        const finished = await finish();
        assert.equal(finished.sql.state, "succeeded");
        assert.match(finished.sql.output, /used default: true/);
        assert.ok(!JSON.stringify(finished).includes(password));
        assert.equal(readFileSync(defaultFile, "utf8"), encrypted + "\n");
        assert.equal(readFileSync(join(credentials, "auth.json"), "utf8"), authText);
        assert.equal(readFileSync(join(root, "suitecontainer.config.json"), "utf8"), configText);
        // A changed distributed default must never replace the user's encrypted file.
        writeFileSync(defaultFile, "invalid replacement default");
        assert.equal((await post({ ...base, unlock })).status, 202);
        assert.equal((await finish()).sql.state, "succeeded");
        assert.equal(readFileSync(userFile, "utf8"), encrypted + "\n");
        rmSync(defaultFile);
        assert.equal((await state()).sql.hasDefaultPassword, true);
        assert.equal((await post({ ...base, unlock })).status, 202);
        assert.equal((await finish()).sql.state, "succeeded");
        rmSync(userFile);
        assert.equal((await state()).sql.hasDefaultPassword, false);
        assert.equal((await post({ ...base, unlock })).status, 400);
        assert.equal((await post({ ...base, password })).status, 202);
        assert.equal((await finish()).sql.state, "succeeded");
    } finally {
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(root, { recursive: true, force: true });
    }
});

test("the browser offers separate masked manual and unlock fields and sends only the chosen credential", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id)) elements.set(id, { value: "", querySelectorAll: () => [], addEventListener(event: string, handler: Function) { this[event] = handler; } });
        return elements.get(id);
    };
    const state = { config: '{"vms":[{"url":"runbox.vm.eng.netsuite.com"}]}', certificates: {}, run: { state: "idle", log: "" }, ready: false,
        sql: { state: "idle", output: "", defaults: { user: "TEST_USER", service: "test.service" }, passwordHint: "hint", hasDefaultPassword: true } };
    let sent: any;
    const context = { document: { getElementById: element, addEventListener() {} }, location: { hash: "", pathname: "/" }, URLSearchParams, AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} }, history: { replaceState() {} }, setInterval() {}, setTimeout() {}, clearTimeout() {},
        fetch: async (path: string, options: any) => { if (path === "/api/sql") sent = JSON.parse(options.body); return { ok: true, json: async () => state }; } };
    runInNewContext(deploymentPage.script, context);
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
    assert.match(deploymentPage.html, /<div class="sql-connection-row"><div><label for="sql-password">[\s\S]*?<div><label for="sql-unlock">[\s\S]*?<\/div><\/div>/);
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
