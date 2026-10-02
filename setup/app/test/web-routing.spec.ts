import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../src/web-server.ts";

async function fixture() {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-routing-"));
    mkdirSync(join(root, "credentials"));
    const configPath = join(root, "suitecontainer.config.json");
    const authPath = join(root, "credentials/auth.json");
    writeFileSync(configPath, JSON.stringify({ suiteapps: [], vms: [{ account: "000071", url: "" }] }));
    writeFileSync(authPath, JSON.stringify({ "gitlab-token": "", "suitecloud-certificates": { public: "", private: "", id: "" } }));
    writeFileSync(join(root, "credentials/web-mounts.json"), JSON.stringify({ hostRoot: "/project", platform: "linux", local: {}, certificates: {} }));
    const sessionFile = join(root, "session");
    const server = startWebServer({ configDirectory: root, port: 0, host: "127.0.0.1", sessionFile, onStop: () => {}, signalHandlers: false });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const headers = { "X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1]!, "Content-Type": "application/json", Origin: origin };
    return {
        origin, headers, configPath, authPath,
        async close() {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function rawRequest(url: string, method: string, headers: Record<string, string>, chunks: string[] = []) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(url, { method, headers }, res => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", chunk => body += chunk);
            res.on("end", () => resolve({ status: res.statusCode!, body }));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("Routing request timed out.")));
        for (const chunk of chunks) req.write(chunk);
        req.end();
    });
}

test("public browser assets are local, use classless Pico and retain restrictive CSP", async () => {
    const app = await fixture();
    try {
        const require = createRequire(import.meta.url);
        const assets = [
            ["/alpine.js", "text/javascript", readFileSync(require.resolve("@alpinejs/csp/dist/cdn.min.js"), "utf8")],
            ["/pico.css", "text/css", readFileSync(require.resolve("@picocss/pico/css/pico.classless.min.css"), "utf8")],
        ];
        for (const [path, type, content] of assets) {
            const response = await fetch(app.origin + path);
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), type + "; charset=utf-8");
            assert.equal(await response.text(), content);
        }
        const response = await fetch(app.origin + "/");
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("content-security-policy"), "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const html = await response.text();
        assert.match(html, /href="\/pico\.css"/);
        assert.match(html, /src="\/alpine\.js"/);
        assert.match(html, /x-data=/);
    } finally { await app.close(); }
});

test("invalid JSON, non-object inputs and oversized bodies cannot mutate saved settings", async () => {
    const app = await fixture();
    try {
        const config = readFileSync(app.configPath, "utf8");
        const auth = readFileSync(app.authPath, "utf8");
        for (const body of ["{", "null", "[]", "42", '"text"', JSON.stringify({ config: "null" }), JSON.stringify({ config: "[]" })]) {
            const response = await fetch(app.origin + "/api/settings", { method: "POST", headers: app.headers, body });
            assert.equal(response.status, 400, body);
            assert.equal(typeof (await response.json()).error, "string");
            assert.equal(readFileSync(app.configPath, "utf8"), config);
        }
        const oversized = JSON.stringify({ token: "should-not-save", config, padding: "x".repeat(128 * 1024) });
        for (const headers of [app.headers, { ...app.headers, "Content-Length": String(Buffer.byteLength(oversized)) }]) {
            const response = await rawRequest(app.origin + "/api/credentials", "POST", headers, [oversized.slice(0, 65536), oversized.slice(65536)]);
            assert.equal(response.status, 400);
            assert.match(JSON.parse(response.body).error, /maximum 128 KiB/);
            assert.equal(readFileSync(app.configPath, "utf8"), config);
            assert.equal(readFileSync(app.authPath, "utf8"), auth);
        }
        // The exact byte boundary remains accepted, including multi-byte UTF-8 text.
        const prefix = JSON.stringify({ config, padding: "é" });
        const exact = prefix.slice(0, -2) + "x".repeat(128 * 1024 - Buffer.byteLength(prefix)) + prefix.slice(-2);
        assert.equal(Buffer.byteLength(exact), 128 * 1024);
        const accepted = await fetch(app.origin + "/api/check", { method: "POST", headers: app.headers, body: exact });
        assert.equal(accepted.status, 200);
        assert.equal(readFileSync(app.configPath, "utf8"), config);
    } finally { await app.close(); }
});

test("Hono routing retains session, origin and host guards and rejects unknown operations", async () => {
    const app = await fixture();
    try {
        const config = readFileSync(app.configPath, "utf8");
        for (const token of ["", "wrong", "x".repeat(64)]) {
            const response = await fetch(app.origin + "/api/state", { headers: { "X-Session-Token": token } });
            assert.equal(response.status, 403);
        }
        for (const origin of ["", "https://other.example", app.origin + "/", app.origin.replace("http:", "https:")]) {
            const response = await fetch(app.origin + "/api/settings", { method: "POST", headers: { ...app.headers, Origin: origin }, body: JSON.stringify({ config: "{}" }) });
            assert.equal(response.status, 403);
        }
        for (const host of ["other.example:8080", "localhost.evil:8080", "127.0.0.1", "[::1]:8080"]) {
            const response = await rawRequest(app.origin + "/health", "GET", { Host: host });
            assert.equal(response.status, 403);
        }
        assert.equal((await fetch(app.origin + "/api/state", { headers: app.headers })).status, 200);
        for (const [path, method] of [["/api/settings", "GET"], ["/api/settings", "PUT"], ["/api/state", "POST"], ["/api/missing", "POST"], ["/missing", "GET"]]) {
            const response = await fetch(app.origin + path, { method, headers: app.headers, ...(method === "POST" ? { body: "{}" } : {}) });
            assert.equal(response.status, 404, `${method} ${path}`);
            assert.deepEqual(await response.json(), { error: "Page not found." });
        }
        assert.equal(readFileSync(app.configPath, "utf8"), config);
    } finally { await app.close(); }
});
