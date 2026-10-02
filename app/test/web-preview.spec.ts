import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { startWebPreview } from "../dev/web-preview.ts";

test("web preview serves local assets and simulates actions in memory", async () => {
    const server = startWebPreview({ port: 0, delayMs: 100, quiet: true });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    assert.equal(address.address, "127.0.0.1");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (action: string, body: Record<string, unknown> = {}) =>
        fetch(`${origin}/api/${action}`, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    const state = async () => (await fetch(`${origin}/api/state`)).json();
    try {
        const page = await fetch(origin);
        assert.match(await page.text(), /Local preview:/);
        assert.match(
            page.headers.get("Content-Security-Policy")!,
            /script-src 'self'/,
        );
        const require = createRequire(import.meta.url);
        for (const [route, asset] of [
            ["/alpine.js", "@alpinejs/csp/dist/cdn.min.js"],
            ["/pico.css", "@picocss/pico/css/pico.classless.zinc.min.css"],
        ])
            assert.equal(
                await (await fetch(origin + route)).text(),
                readFileSync(require.resolve(asset!), "utf8"),
            );
        assert.equal(
            (
                await fetch(`${origin}/api/settings`, {
                    method: "POST",
                    body: "{}",
                })
            ).status,
            403,
        );
        const initial = await state();
        const config = JSON.stringify({
            suiteapps: [],
            vms: [{ account: "123", url: "example.test" }],
        });
        assert.equal((await post("check", { config })).status, 200);
        assert.equal((await state()).config, initial.config);
        assert.equal((await post("settings", { config })).status, 200);
        const credentials = await post("credentials", {
            token: "secret-preview-token",
            public: "example.pem",
        });
        const saved = await credentials.json();
        assert.equal(saved.tokenPresent, true);
        assert.equal(saved.certificates.public, "example.pem");
        assert.doesNotMatch(JSON.stringify(saved), /secret-preview-token/);
        assert.equal((await post("deploy", { config })).status, 202);
        assert.equal((await state()).run.state, "running");
        assert.equal((await post("settings", { config })).status, 409);
        assert.equal((await post("heartbeat")).status, 200);
        await delay(150);
        assert.equal((await state()).run.state, "succeeded");
        assert.match((await state()).run.log, /No files deployed/);
        assert.equal(
            (
                await post("sql", {
                    password: "secret-password",
                    statement: "select 1",
                })
            ).status,
            202,
        );
        await delay(150);
        const sql = await state();
        assert.equal(sql.sql.state, "succeeded");
        assert.match(sql.sql.output, /Sample row/);
        assert.equal(sql.config, config);
        assert.doesNotMatch(JSON.stringify(sql), /secret-password/);
        assert.equal((await post("generate")).status, 400);
        assert.equal((await fetch(`${origin}/api/certificate`)).status, 400);
        assert.equal((await post("settings", { config: "[1]" })).status, 400);
        assert.equal((await state()).config, config);
        const closed = once(server, "close");
        assert.equal((await post("stop")).status, 200);
        await closed;
    } finally {
        if (server.listening) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    }
});
