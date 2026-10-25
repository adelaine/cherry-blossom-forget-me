import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL_PASSWORD_SALT } from "../../src/tools/sql/settings.ts";
import { encryptSqlPassword } from "../../src/tools/sql/password-crypto.ts";
import { createApplicationFixture } from "./application.fixture.ts";

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
	const app = createApplicationFixture(config, {
		sqlCommand: process.execPath,
		sqlArgs: [stub],
	});
	try {
		const encrypted = await encryptSqlPassword(
			password,
			unlock,
			SQL_PASSWORD_SALT,
		);
		writeFileSync(join(app.credentials, ".sql-default.enc"), encrypted + "\n");
		const response = await app.post("sql", {
			config: JSON.stringify(config),
			account: "TEST_USER",
			database: "test.service",
			sql: "SELECT 1 FROM dual;",
			unlock,
		});
		assert.equal(response.status, 202);
		assert.match((await app.finish("sql")).output, /used default: true/);
	} finally {
		await app.close();
		rmSync(workers, { recursive: true, force: true });
	}
});
