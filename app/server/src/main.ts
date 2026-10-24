import { type Server } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import { deploymentPage } from "../../src/web-page.ts";
import { HeartbeatDeadline } from "../../src/web-inactivity.ts";
import { createServices, type ServiceOptions, type Services, type SharedServiceState } from "./services/system.ts";
import { OperationsService } from "./services/operations.ts";
import { ServiceError, message, structuredError, errorStatus } from "./services/errors.ts";
import { credentialsApi } from "./api/credentials.ts";
import { suiteappsApi } from "./api/suiteapps.ts";
import { deploymentApi } from "./api/deployment.ts";
import { sqlApi } from "./api/sql.ts";
import { sftpApi } from "./api/sftp.ts";
import { playwrightApi } from "./api/playwright.ts";
import { operationsApi, type ApiApp } from "./api/operations.ts";
import { systemApi } from "./api/system.ts";

export type ServerOptions = ServiceOptions & {
    port?: number; host?: string; sessionFile?: string; onStop?: () => void; signalHandlers?: boolean;
    inactivityNow?: () => number; inactivityCheckMs?: number; mode?: "production" | "development";
    accessToken?: string; accessTokenFile?: string; instanceId?: string;
};

export class ServerLifecycle {
    readonly instanceId: string;
    readonly session = randomBytes(32).toString("hex");
    readonly token: string;
    readonly runnerToken: string;
    readonly passkey = randomBytes(32).toString("hex");
    readonly heartbeat: HeartbeatDeadline;
    readonly operations: OperationsService;
    readonly shared: SharedServiceState;
    services: Services;
    stopping = false;
    stopHandler?: () => void;
    private timer?: ReturnType<typeof setInterval>;
    private disposing?: Promise<void>;
    private restarting?: Promise<boolean>;
    readonly options: ServerOptions;
    constructor(options: ServerOptions = {}) { this.options = options;
        this.options.mode ??= process.env.SUITECONTAINER_MODE === "development" ? "development" : "production";
        this.instanceId = options.instanceId ?? process.env.SUITECONTAINER_INSTANCE_ID ?? randomUUID();
        const tokenFile = options.accessTokenFile ?? process.env.SUITECONTAINER_ACCESS_TOKEN_FILE;
        this.token = options.accessToken ?? (tokenFile ? readFileSync(tokenFile, "utf8").trim() : randomBytes(32).toString("hex"));
        if (Buffer.byteLength(this.token) < 32 || /[\r\n\0]/.test(this.token)) throw new Error("The access-token file must contain a securely generated token of at least 256 bits.");
        this.runnerToken = options.playwrightToken ?? process.env.SUITECONTAINER_PLAYWRIGHT_TOKEN ?? "";
        this.heartbeat = new HeartbeatDeadline(options.inactivityNow);
        this.shared = { secrets: new Set([this.session, this.token, this.passkey, this.runnerToken]), generatedCertificates: false, passkey: this.passkey, runnerToken: this.runnerToken };
        this.operations = new OperationsService(this.instanceId, (text, active) => this.services.credentials.redact(text, active), () => this.heartbeat.heartbeat(), (state, text, final) => this.services.credentials.redactChunk(state, text, final));
        this.services = createServices(options, this.operations, this.shared);
        if (this.options.mode !== "development") {
            this.timer = setInterval(() => { if (!this.stopping && this.heartbeat.expired(this.busy() || this.managedActive())) this.stop(); }, options.inactivityCheckMs ?? 1000); this.timer.unref();
        }
    }
    createApp(): ApiApp { return createApplication(this); }
    busy(): boolean { return this.operations.busy() || this.services.playwright.active; }
    managedActive(): boolean { return this.services.sftp.active; }
    setRestartPending(reason = ""): void { this.operations.restartPending = reason; }
    async restartServices(loader: () => Promise<{ createServices: typeof createServices }>): Promise<boolean> {
        if (this.restarting) return this.restarting;
        if (this.stopping || this.busy() || this.managedActive()) return false;
        this.restarting = (async () => {
            try {
                const fresh = await loader();
                if (this.stopping || this.busy() || this.managedActive()) return false;
                await this.services.dispose({ preserveRunner: true });
                this.services = fresh.createServices(this.options, this.operations, this.shared);
                this.operations.restartPending = ""; return true;
            } catch (error) { this.operations.restartPending = `Service restart failed: ${this.services.credentials.redact(message(error))}. Relaunch SuiteContainer.`; return false; }
            finally { this.restarting = undefined; }
        })();
        return this.restarting;
    }
    stop(): void {
        if (this.stopping) return;
        const protectedOperation = this.operations.list().find(op => ["preparing", "running"].includes(op.state) && op.kind !== "playwright");
        if (protectedOperation) throw new ServiceError("operation_conflict", `${protectedOperation.kind === "sql" ? "SQL is" : "Deployment is"} running. Wait for its results before stopping.`, 409, true, { operationId: protectedOperation.id });
        this.stopping = true;
        if (this.stopHandler) this.stopHandler(); else void this.dispose().finally(this.options.onStop);
    }
    dispose(): Promise<void> {
        if (this.disposing) return this.disposing;
        this.stopping = true; clearInterval(this.timer);
        this.disposing = (async () => {
            await this.services.dispose();
            const descriptor = process.env.SUITECONTAINER_CONNECTION_FILE;
            if (descriptor) { try { if (JSON.parse(readFileSync(descriptor, "utf8")).instanceId === this.instanceId) rmSync(descriptor, { force: true }); } catch { /* A stale host descriptor is rejected during discovery. */ } }
        })();
        return this.disposing;
    }
}
export function createServerLifecycle(options: ServerOptions = {}): ServerLifecycle { return new ServerLifecycle(options); }

function equal(supplied: string, expected: string): boolean { const left = Buffer.from(supplied); const right = Buffer.from(expected); return !!expected && left.length === right.length && timingSafeEqual(left, right); }

export function createApplication(lifecycle: ServerLifecycle): ApiApp {
    const app: ApiApp = new Hono();
    const failure = (error: unknown) => structuredError(error, text => lifecycle.services.credentials.redact(text));
    app.use("*", async (c, next) => {
        c.header("X-Content-Type-Options", "nosniff"); c.header("Referrer-Policy", "no-referrer"); c.header("Cache-Control", "no-store");
        c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " + (lifecycle.options.mode === "development" ? "connect-src 'self' ws:; " : "") + "frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const internalHealth = c.req.path === "/health" && equal(c.req.header("authorization")?.replace(/^Bearer /, "") ?? "", lifecycle.runnerToken);
        if (!internalHealth && !/^(?:localhost|127\.0\.0\.1):\d+$/.test(c.req.header("host") ?? "")) return c.json(failure(new ServiceError("invalid_host", "Open the app through its localhost address.", 403)), 403);
        await next();
    });
    const require = createRequire(import.meta.url); const sourceMode = import.meta.url.endsWith(".ts");
    const alpine = readFileSync(sourceMode ? require.resolve("@alpinejs/csp/dist/cdn.min.js") : new URL("../../src/assets/alpine.js", import.meta.url), "utf8");
    const pico = readFileSync(sourceMode ? require.resolve("@picocss/pico/css/pico.min.css") : new URL("../../src/assets/pico.css", import.meta.url), "utf8");
    for (const [path, contentType, content] of [["/", "text/html", deploymentPage.html], ["/page.js", "text/javascript", deploymentPage.script], ["/page.css", "text/css", deploymentPage.style], ["/alpine.js", "text/javascript", alpine], ["/pico.css", "text/css", pico]]) app.get(path!, c => { c.header("Content-Type", contentType + "; charset=utf-8"); return c.body(content!); });
    for (const name of ["netsuite-2026.css", "oracle-corporate-2026.css"]) {
        const content = readFileSync(new URL(sourceMode ? "../../src/themes/" + name : "../../src/assets/" + name, import.meta.url), "utf8");
        app.get("/themes/" + name, c => { c.header("Content-Type", "text/css; charset=utf-8"); return c.body(content); });
    }
    for (const name of ["favicon.png", "advanced-configuration.png"]) { const content = readFileSync(new URL("../../src/assets/" + name, import.meta.url)); app.get("/" + name, c => { c.header("Content-Type", "image/png"); return c.body(new Uint8Array(content)); }); }
    for (const name of ["oracle-cover-dark.jpg", "oracle-cover-light.jpg", "netsuite-divider-dark.jpg"]) { const content = readFileSync(new URL(sourceMode ? "../../src/themes/" + name : "../../src/assets/" + name, import.meta.url)); app.get("/themes/" + name, c => { c.header("Content-Type", "image/jpeg"); return c.body(new Uint8Array(content)); }); }
    for (const name of ["Ubuntu-Light.ttf", "Ubuntu-Regular.ttf", "Ubuntu-Medium.ttf", "Ubuntu-Bold.ttf"]) { const content = readFileSync(new URL("../../src/assets/fonts/" + name, import.meta.url)); app.get("/fonts/" + name, c => { c.header("Content-Type", "font/ttf"); return c.body(new Uint8Array(content)); }); }
    app.get("/health", c => c.json(c.req.query("activity") === "1" ? { ready: true, instanceId: lifecycle.instanceId, busy: lifecycle.busy(), localBusy: lifecycle.operations.list().some(op => ["preparing", "running"].includes(op.state) && op.kind !== "playwright") || lifecycle.services.playwright.starting } : { ready: true }));
    app.use("*", async (c, next) => {
        const browser = c.req.header("x-session-token"); const authorization = c.req.header("authorization"); const origin = c.req.header("origin");
        if (browser !== undefined && authorization !== undefined) return c.json(failure(new ServiceError("conflicting_credentials", "Supply only one authentication mechanism.", 401)), 401);
        const bearer = authorization !== undefined;
        const authenticated = bearer ? /^Bearer [^\s]+$/.test(authorization) && equal(authorization.slice(7), lifecycle.token) : equal(browser ?? "", lifecycle.session);
        if (!authenticated) { const status = bearer ? 401 : 403; return c.json(failure(new ServiceError("authentication_required", bearer ? "Read the current instance descriptor and access-token file, then authenticate with Bearer." : "Reopen the page using the launcher URL.", status)), status); }
        if ((origin !== undefined && origin !== "http://" + c.req.header("host")) || (!bearer && c.req.method !== "GET" && origin === undefined)) return c.json(failure(new ServiceError("invalid_origin", "Use the same origin as the application.", 403)), 403);
        await next();
        if (c.res.status < 400) lifecycle.heartbeat.heartbeat();
    });
    app.use("/api/*", async (c, next) => {
        if (c.req.method === "POST") {
            if (lifecycle.stopping) throw new ServiceError("instance_stopping", "The app is stopping. Relaunch to continue.", 409, true);
            const chunks: Uint8Array[] = []; let length = 0; const reader = c.req.raw.body?.getReader();
            if (reader) { try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 128 * 1024) { await reader.cancel(); throw new ServiceError("request_too_large", "Settings are too large (maximum 128 KiB)."); } chunks.push(value); } } finally { reader.releaseLock(); } }
            const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected settings as an object.");
            if (lifecycle.stopping) throw new ServiceError("instance_stopping", "The app is stopping.", 409, true);
            c.set("input", input as Record<string, unknown>);
        }
        await next();
    });
    systemApi(app, lifecycle); credentialsApi(app, lifecycle); suiteappsApi(app, lifecycle); deploymentApi(app, lifecycle); sqlApi(app, lifecycle); sftpApi(app, lifecycle); playwrightApi(app, lifecycle); operationsApi(app, lifecycle);
    app.notFound(c => c.json(failure(new ServiceError("not_found", "Page not found.", 404)), 404));
    app.onError((error, c) => {
        const status = errorStatus(error);
        return c.json(failure(error), status as 400);
    });
    return app;
}

export function startWebServer(options: ServerOptions = {}): Server {
    const lifecycle = createServerLifecycle(options); const app = createApplication(lifecycle);
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    lifecycle.stopHandler = () => server.close(() => { void lifecycle.dispose().finally(options.onStop ?? (() => process.exit(0))); });
    server.once("close", () => { void lifecycle.dispose(); }); server.requestTimeout = 15_000;
    server.on("error", error => { console.error(message(error)); void lifecycle.dispose(); process.exitCode = 1; });
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => { writeFileSync(options.sessionFile ?? "/tmp/suitecontainer-web-url", `/#session=${lifecycle.session}`, { mode: 0o600 }); console.log("SuiteCloud deployment page is ready."); });
    const shutdown = () => { void lifecycle.dispose().finally(() => { server.closeAllConnections(); server.close(); }); };
    if (options.signalHandlers !== false) { process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown); server.once("close", () => { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); }); }
    return server;
}

export default {
    fetch(request: Request, env: { lifecycle: ServerLifecycle }, executionCtx?: unknown) {
        if (!env?.lifecycle) throw new Error("The outer server lifecycle must be injected before handling requests.");
        return createApplication(env.lifecycle).fetch(request, env, executionCtx as never);
    },
};
