import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL_PASSWORD_SALT } from "../../src/sql-settings.ts";
import { encryptSqlPassword } from "../../src/sql-password-crypto.ts";
import { fixture } from "../main.fixture.ts";

test("runs SQL using the saved password", async () => {
    const workers = mkdtempSync(join(tmpdir(), "suitecontainer-sql-worker-"));
    const stub = join(workers, "worker.cjs");
    const password = "fake-default-SQL-password",
        unlock = "fake-unlock-string";
    writeFileSync(
        stub,
        `let input=''; process.stdin.on('data', chunk => input+=chunk); process.stdin.on('end', () => {
        console.log('used default: ' + input.includes('/"${password}"@'));
        console.log(input.match(/^prompt (SUITECONTAINER_SQL_[a-f0-9]+)$/m)[1]);
    });`,
    );
    const config = {
        suiteapps: [],
        vms: [{ account: "000071", url: "scrumbox.vm.eng.netsuite.com" }],
    };
    const app = await fixture(config, {
        sqlCommand: process.execPath,
        sqlArgs: [stub],
    });
    try {
        const encrypted = await encryptSqlPassword(
            password,
            unlock,
            SQL_PASSWORD_SALT,
        );
        writeFileSync(
            join(app.credentials, ".sql-default.enc"),
            encrypted + "\n",
        );
        await app.post("sql", {
            config: JSON.stringify(config),
            account: "TEST_USER",
            database: "test.service",
            sql: "SELECT 1 FROM dual;",
            unlock,
        });
        assert.match((await app.finish("sql")).output, /used default: true/);
    } finally {
        await app.close();
        rmSync(workers, { recursive: true, force: true });
    }
});
