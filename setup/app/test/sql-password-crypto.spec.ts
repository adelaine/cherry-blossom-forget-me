import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { encryptSqlPassword, decryptSqlPassword } from "../src/sql-password-crypto.ts";
import { SQL_PASSWORD_SALT } from "../src/sql-settings.ts";

const sqlPassword = "test-only-SQL-password-123!";
const unlockPassword = "test-only-unlock-phrase";

test("encrypted SQL passwords use the configured salt and require the correct unlock password", async () => {
    const encrypted = await encryptSqlPassword(sqlPassword, unlockPassword, SQL_PASSWORD_SALT);
    assert.equal(encrypted.split(":").length, 4);
    assert.ok(!encrypted.includes(sqlPassword));
    assert.ok(!encrypted.includes(unlockPassword));
    const decrypted = await decryptSqlPassword(encrypted, unlockPassword, SQL_PASSWORD_SALT);
    assert.equal(decrypted.toString("utf8"), sqlPassword);
    decrypted.fill(0);
    await assert.rejects(decryptSqlPassword(encrypted, "incorrect unlock password", SQL_PASSWORD_SALT), /Could not unlock/);
    await assert.rejects(decryptSqlPassword(encrypted, unlockPassword, "different-fixed-salt"), /Could not unlock/);
});

test("encryption uses fresh initialization vectors and rejects tampering and malformed strings", async () => {
    const first = await encryptSqlPassword(sqlPassword, unlockPassword, SQL_PASSWORD_SALT);
    const second = await encryptSqlPassword(sqlPassword, unlockPassword, SQL_PASSWORD_SALT);
    assert.notEqual(first.split(":")[1], second.split(":")[1]);
    const parts = first.split(":");
    const tag = Buffer.from(parts[2], "base64url");
    tag[0] ^= 1;
    parts[2] = tag.toString("base64url");
    await assert.rejects(decryptSqlPassword(parts.join(":"), unlockPassword, SQL_PASSWORD_SALT), /Could not unlock/);
    await assert.rejects(decryptSqlPassword("sql-v1:invalid", unlockPassword, SQL_PASSWORD_SALT), /invalid/);
    await assert.rejects(encryptSqlPassword(sqlPassword, "", SQL_PASSWORD_SALT), /Enter a password hint/);
});

test("the one-time generator prints only encrypted data and does not echo invalid input", async () => {
    const command = fileURLToPath(new URL("../src/encrypt-sql-password.ts", import.meta.url));
    const generated = spawnSync(process.execPath, ["--experimental-strip-types", command, "--stdin"], {
        input: JSON.stringify({ sqlPassword, unlockPassword }), encoding: "utf8",
    });
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(generated.stderr, "");
    assert.ok(!generated.stdout.includes(sqlPassword));
    assert.ok(!generated.stdout.includes(unlockPassword));
    const decrypted = await decryptSqlPassword(generated.stdout.trim(), unlockPassword, SQL_PASSWORD_SALT);
    assert.equal(decrypted.toString("utf8"), sqlPassword);
    decrypted.fill(0);
    const invalid = spawnSync(process.execPath, ["--experimental-strip-types", command, "--stdin"], { input: "bad JSON " + sqlPassword, encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.ok(!(invalid.stdout + invalid.stderr).includes(sqlPassword));
});
