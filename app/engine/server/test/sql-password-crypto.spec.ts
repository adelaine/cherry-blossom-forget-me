import test from "node:test";
import assert from "node:assert/strict";
import {
    encryptSqlPassword,
    decryptSqlPassword,
} from "../src/sql-password-crypto.ts";
import { SQL_PASSWORD_SALT } from "../src/sql-settings.ts";

test("round-trips an encrypted SQL password", async () => {
    const password = "test-only-SQL-password",
        unlock = "test-only-unlock-phrase";
    const encrypted = await encryptSqlPassword(
        password,
        unlock,
        SQL_PASSWORD_SALT,
    );
    const decrypted = await decryptSqlPassword(
        encrypted,
        unlock,
        SQL_PASSWORD_SALT,
    );
    try {
        assert.equal(decrypted.toString("utf8"), password);
    } finally {
        decrypted.fill(0);
    }
});
