import { type Server } from "node:http";
import { createRequire } from "node:module";
import { Hono, type Context } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, chmodSync, copyFileSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readAuth, type Auth } from "./step-auth.ts";
import { validateConfig, type Config } from "./step-config.ts";
import { replaceCertificates, verifyCertificates } from "./step-certificates.ts";
import { credentialPath, hostPath, type MountRecord } from "./web-mounts.ts";
import { deploymentPage } from "./web-page.ts";
import { startSql, validateSqlRequest } from "./sql-runner.ts";
import { SQL_DEFAULTS, SQL_PASSWORD_HINT, SQL_PASSWORD_SALT } from "./sql-settings.ts";
import { decryptSqlPassword } from "./sql-password-crypto.ts";
import { HeartbeatDeadline } from "./web-inactivity.ts";
import { SftpService } from "./sftp-server.ts";

type Run = { state: "idle" | "running" | "succeeded" | "failed"; log: string; started?: string; finished?: string };

export function mountChanges(config: Config, auth: Auth, record: MountRecord, allowUnusedExternal = false): boolean {
    const local = Object.fromEntries(config.suiteapps.filter(repo => repo.localPath).map(repo => [repo.directory, hostPath(record, repo.localPath!)]));
    const names = new Set([...Object.keys(local), ...Object.keys(record.local)]);
    if ([...names].some(name => local[name] !== record.local[name])) return true;
    const usedExternal = new Set<string>();
    const missing = ["public", "private"].some(key => {
        const path = auth["suitecloud-certificates"]?.[key as "public" | "private"];
        if (typeof path === "string" && record.certificates[hostPath(record, path)]) usedExternal.add(hostPath(record, path));
        return typeof path === "string" && !!path.trim() && !credentialPath(record, path);
    });
    return missing || (!allowUnusedExternal && Object.keys(record.certificates).some(path => !usedExternal.has(path)));
}

function message(error: unknown): string {
    const text = (error instanceof Error ? error.message : String(error))
        .replace(/ Update .* and run the start script again\.$/, "");
    if (text === "credentials/auth.json needs the NetSuite certificate ID.") return "Enter a valid Certificate ID assigned by NetSuite in Credentials and click Save credentials.";
    if (text === "VM 1 needs an account ID and a NetSuite domain.") return "Enter your runbox domain in Current VM, without https:// or /devhome. Check the first VM's account ID in Settings.";
    if (text === "Certificate files were not mounted. Check their paths in credentials/auth.json.") return "Cannot find both certificate files. Check Certificate paths in Credentials and relaunch if needed, or use Generate certificates to create a new pair.";
    if (text === "The public and private certificate files do not match or cannot be read.") return "The certificate files do not match or cannot be read. Check Certificate paths in Credentials, or generate and register a new pair.";
    return text;
}

export function startWebServer(options: {
    configDirectory?: string; port?: number; host?: string; workerScript?: string;
    sessionFile?: string; onStop?: () => void; signalHandlers?: boolean;
    sqlCommand?: string; sqlArgs?: string[]; sqlTimeoutMs?: number;
    inactivityNow?: () => number; inactivityCheckMs?: number;
} = {}): Server {
    const configDirectory = options.configDirectory ?? "/config";
    const configPath = join(configDirectory, "suitecontainer.config.json");
    const credentials = join(configDirectory, "credentials");
    const authPath = join(credentials, "auth.json");
    const sqlDefaultPath = join(credentials, ".sql-default");
    const sqlUserPath = join(credentials, ".sql-user");
    const prepareSqlUser = () => {
        if (existsSync(sqlUserPath) || !existsSync(sqlDefaultPath)) return;
        try {
            copyFileSync(sqlDefaultPath, sqlUserPath, constants.COPYFILE_EXCL);
            chmodSync(sqlUserPath, 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Cannot create credentials/.sql-user. Check the credentials folder permissions or enter the SQL password manually.");
        }
    };
    try { prepareSqlUser(); } catch (error) { console.warn(message(error)); }
    const mountedCredentialPath = (path: string) => {
        const runtime = credentialPath(record, path);
        return runtime?.startsWith("/config/credentials/")
            ? join(credentials, runtime.slice("/config/credentials/".length)) : runtime;
    };
    const session = randomBytes(32).toString("hex");
    const passkey = randomBytes(32).toString("hex");
    const record: MountRecord = JSON.parse(readFileSync(join(credentials, "web-mounts.json"), "utf8"));
    const sftpService = new SftpService(credentials, record);
    let run: Run = { state: "idle", log: "" };
    let sqlRun: { state: Run["state"]; output: string; host?: string; database?: string } = { state: "idle", output: "" };
    let sqlWorker: ChildProcess | undefined;
    let sqlPreparing = false;
    let worker: ChildProcess | undefined;
    let snapshot: string | undefined;
    let stopping = false;
    let generatedCertificates = false;
    const heartbeatDeadline = new HeartbeatDeadline(options.inactivityNow);
    const secrets = new Set([passkey, session]);
    const busy = () => sqlPreparing || run.state === "running" || sqlRun.state === "running";
    const busyMessage = () => sqlPreparing ? "SQL credentials are being unlocked. Wait before making changes." : sqlRun.state === "running"
        ? "SQL is running. Wait for its results before making changes."
        : "Deployment is running. Wait for its results before making changes.";
    const redact = (text: string) => {
        // Remove known credentials and PEM private-key blocks from browser progress.
        let token = "";
        try { token = readAuth(authPath)["gitlab-token"] ?? ""; } catch { /* malformed auth */ }
        if (token) secrets.add(token);
        try { const password = readAuth(authPath).sftp?.password; if (password) secrets.add(password); } catch { /* malformed auth */ }
        for (const secret of secrets) if (secret) text = text.split(secret).join("[redacted]");
        return text.replace(/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----|$)/g, "[private key redacted]");
    };
    const certificateState = (auth: Auth) => {
        const certs = auth["suitecloud-certificates"];
        const mounted = Object.keys(record.certificates).length > 0 ||
            readdirSync(credentials, { recursive: true }).some(name => /\.(pem|key|cer|crt)$/i.test(String(name)));
        let error = "";
        let publicPath: string | null = null;
        let privatePath: string | null = null;
        if (certs?.public || certs?.private) {
            if (!certs.public || !certs.private) error = "Set both certificate paths, or generate a new pair and register it on your runbox.";
            else {
                publicPath = mountedCredentialPath(certs.public);
                privatePath = mountedCredentialPath(certs.private);
                if (!publicPath || !privatePath) error = "Save credentials, stop the app, and run the launcher again to use these certificate files. You can also generate a new pair here.";
                else { try { verifyCertificates(publicPath, privatePath); } catch (e) { error = message(e); } }
            }
        } else if (mounted) error = "Certificate files already exist. Enter both paths in Certificate paths and save credentials, or generate and register a new pair.";
        else error = "Click Generate certificates, download and register the public certificate on your runbox, then enter its assigned certificate ID and save credentials.";
        return { hasExisting: mounted || !!certs?.public || !!certs?.private, error, publicPath, privatePath };
    };
    const readiness = (text: string) => {
        try {
            const config = validateConfig(JSON.parse(text));
            const auth = readAuth(authPath);
            if (config.suiteapps.length === 0) throw new Error("Add at least one SuiteApp before deploying.");
            if (mountChanges(config, auth, record, generatedCertificates)) throw new Error("Relaunch required: local repositories or certificate paths need different mounts.");
            const cert = certificateState(auth);
            if (cert.error) throw new Error(cert.error);
            config.certificates = auth["suitecloud-certificates"];
            validateConfig(config, true);
            if (config.suiteapps.some(repo => !repo.localPath) && !auth["gitlab-token"]?.trim()) throw new Error("Paste a GitLab token in Credentials and click Save credentials to copy SuiteApps from GitLab.");
            return { ready: true, error: "", config, auth, cert };
        } catch (error) { return { ready: false, error: message(error) }; }
    };
    const status = (text = readFileSync(configPath, "utf8")) => {
        let auth: Auth = {};
        let credentialError = "";
        try { auth = readAuth(authPath); } catch (error) { credentialError = message(error); }
        const cert = certificateState(auth);
        const ready = readiness(text);
        let sqlDefaults = { ...SQL_DEFAULTS };
        let deploymentStarted = false;
        let relaunch = false;
        let theme: "light" | "dark" | undefined;
        try {
            const savedTheme = JSON.parse(readFileSync(configPath, "utf8"))?.status?.theme;
            if (savedTheme === "light" || savedTheme === "dark") theme = savedTheme;
        } catch { /* Configuration validation explains malformed JSON. */ }
        try {
            const config = JSON.parse(text);
            deploymentStarted = config?.status?.["deploy-start-ok"] === 1;
            const database = config?.vms?.[0]?.database;
            sqlDefaults = {
                user: typeof database?.user === "string" ? database.user : SQL_DEFAULTS.user,
                service: typeof database?.service === "string" ? database.service : SQL_DEFAULTS.service,
            };
            if (Array.isArray(config.suiteapps)) relaunch = mountChanges(config, auth, record, generatedCertificates);
        } catch { /* Configuration validation explains malformed JSON. */ }
        return {
            config: text, ready: ready.ready && !busy(), error: credentialError || ready.error,
            credentialError, tokenPresent: !!auth["gitlab-token"]?.trim(),
            deploymentStarted,
            theme,
            certificates: {
                public: /[\r\n]/.test(auth["suitecloud-certificates"]?.public ?? "") ? "" : auth["suitecloud-certificates"]?.public ?? "",
                private: /[\r\n]/.test(auth["suitecloud-certificates"]?.private ?? "") ? "" : auth["suitecloud-certificates"]?.private ?? "",
                id: auth["suitecloud-certificates"]?.id ?? "", canGenerate: !busy(), hasExisting: cert.hasExisting,
                error: cert.error, canDownload: !!cert.publicPath && existsSync(cert.publicPath) && !cert.error },
            relaunch, run: { ...run, log: redact(run.log) },
            sql: { ...sqlRun, output: redact(sqlRun.output), defaults: sqlDefaults, passwordHint: SQL_PASSWORD_HINT,
                hasDefaultPassword: existsSync(sqlUserPath) || existsSync(sqlDefaultPath), preparing: sqlPreparing },
            sftp: sftpService.status(auth),
        };
    };
    const app = new Hono<{ Variables: { input: Record<string, unknown> } }>();
    const reply = (c: Context, code: ContentfulStatusCode, value: unknown) => c.json(value, code);
    const require = createRequire(import.meta.url);
    // Source-mode development uses installed packages; built runtime uses emitted assets.
    const sourceMode = import.meta.url.endsWith(".ts");
    const alpine = readFileSync(sourceMode ? require.resolve("@alpinejs/csp/dist/cdn.min.js") : new URL("./assets/alpine.js", import.meta.url), "utf8");
    const pico = readFileSync(sourceMode ? require.resolve("@picocss/pico/css/pico.min.css") : new URL("./assets/pico.css", import.meta.url), "utf8");
    app.use("*", async (c, next) => {
        c.header("X-Content-Type-Options", "nosniff");
        c.header("Referrer-Policy", "no-referrer");
        c.header("Cache-Control", "no-store");
        // Classless Pico uses embedded SVG images for disclosure and form icons.
        c.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const host = c.req.header("host") ?? "";
        if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) return reply(c, 403, { error: "Open the app through its localhost address." });
        await next();
    });
    for (const [path, contentType, content] of [
        ["/", "text/html", deploymentPage.html],
        ["/page.js", "text/javascript", deploymentPage.script],
        ["/page.css", "text/css", deploymentPage.style],
        ["/alpine.js", "text/javascript", alpine],
        ["/pico.css", "text/css", pico],
    ]) app.get(path!, c => { c.header("Content-Type", contentType + "; charset=utf-8"); return c.body(content!); });
    for (const name of ["Ubuntu-Light.ttf", "Ubuntu-Regular.ttf", "Ubuntu-Medium.ttf", "Ubuntu-Bold.ttf"]) {
        const font = readFileSync(new URL("./assets/fonts/" + name, import.meta.url));
        app.get("/fonts/" + name, c => {
            c.header("Content-Type", "font/ttf");
            return c.body(new Uint8Array(font));
        });
    }
    app.get("/health", c => reply(c, 200, { ready: true }));
    app.use("*", async (c, next) => {
        const supplied = Buffer.from(c.req.header("x-session-token") ?? "");
        const expected = Buffer.from(session);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected) ||
            (c.req.method !== "GET" && c.req.header("origin") !== 'http://' + c.req.header("host")))
            return reply(c, 403, { error: "Reopen the page using the launcher URL." });
        await next();
    });
    app.get("/api/state", c => reply(c, 200, status()));
    app.get("/api/certificate", c => {
        const cert = certificateState(readAuth(authPath));
        if (cert.error || !cert.publicPath) throw new Error("A valid certificate pair is required before downloading.");
        c.header("Content-Type", "application/x-pem-file");
        c.header("Content-Disposition", 'attachment; filename="public.pem"');
        return c.body(new Uint8Array(readFileSync(cert.publicPath)));
    });
    app.use("/api/*", async (c, next) => {
        if (c.req.method !== "POST") return reply(c, 404, { error: "Page not found." });
        if (stopping) return reply(c, 409, { error: "The app is stopping. Relaunch to continue." });
        const background = ["/api/check", "/api/heartbeat", "/api/theme"].includes(c.req.path);
        if (busy() && !background) return reply(c, 409, { error: busyMessage() });
        // Count every byte before side effects, including requests without Content-Length.
        const chunks: Uint8Array[] = [];
        let length = 0;
        const reader = c.req.raw.body?.getReader();
        if (reader) {
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    length += value.byteLength;
                    if (length > 128 * 1024) {
                        await reader.cancel();
                        throw new Error("Settings are too large (maximum 128 KiB).");
                    }
                    chunks.push(value);
                }
            } finally { reader.releaseLock(); }
        }
        const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected settings as an object.");
        // Recheck after the asynchronous read: another request may have started a worker.
        if (stopping) return reply(c, 409, { error: "The app is stopping." });
        if (busy() && !background) return reply(c, 409, { error: busyMessage() });
        c.set("input", input as Record<string, unknown>);
        await next();
    });
    app.post("/api/heartbeat", c => {
        heartbeatDeadline.heartbeat();
        return reply(c, 200, { alive: true });
    });
    app.post("/api/check", c => {
        const input = c.get("input");
        if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
        return reply(c, 200, status(input.config));
    });
    app.post("/api/theme", c => {
        const theme = c.get("input").theme;
        if (theme !== "light" && theme !== "dark") throw new Error('Choose "light" or "dark" for the theme.');
        const value = JSON.parse(readFileSync(configPath, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
        if (value.status !== undefined && (!value.status || typeof value.status !== "object" || Array.isArray(value.status))) {
            throw new Error("Set status to an object in Settings before changing the theme.");
        }
        value.status = { ...value.status, theme };
        writeFileSync(configPath, JSON.stringify(value, null, 4) + "\n");
        return reply(c, 200, status());
    });
    app.post("/api/sftp", async c => {
        const input = c.get("input");
        if (!["save", "start", "stop"].includes(String(input.action))) throw new Error("Choose Start SFTP, Stop SFTP, or Save settings.");
        if (input.action === "stop") { sftpService.stop(); return reply(c, 200, status()); }
        if (sftpService.active) throw new Error("Stop SFTP before changing its settings.");
        const auth = readAuth(authPath);
        const saved = auth.sftp ?? { username: "suitecontainer", port: 8000, password: "" };
        if (typeof input.username !== "string" || typeof input.port !== "number" || typeof input.path !== "string" ||
            (input.password !== undefined && typeof input.password !== "string")) throw new Error("Enter the SFTP user, port, password, and local folder.");
        const next: Auth = { ...auth, sftp: { username: input.username.trim(), port: input.port,
            password: input.password ? String(input.password) : saved.password, path: input.path.trim() } };
        // Validate through the same credential parser before writing the real file.
        const temporary = join(credentials, `.sftp-${randomBytes(8).toString("hex")}.json`);
        try { writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 }); readAuth(temporary); }
        finally { rmSync(temporary, { force: true }); }
        writeFileSync(authPath, JSON.stringify(next, null, 4) + "\n", { mode: 0o600 });
        secrets.add(next.sftp!.password);
        if (input.action === "start") {
            const host = JSON.parse(readFileSync(configPath, "utf8"))?.vms?.[0]?.url;
            await sftpService.start(next, typeof host === "string" ? host : "");
        }
        return reply(c, 200, status());
    });
    app.post("/api/sql", async c => {
        const input = c.get("input");
        if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
        // SQL needs a configured target, not SuiteCloud certificates or a GitLab token.
        // Use the visible configuration without saving it as a side effect of execution.
        const config = JSON.parse(input.config);
        if ((input.password !== undefined && typeof input.password !== "string") || (input.unlock !== undefined && typeof input.unlock !== "string")) throw new Error("Enter your SQL password or the answer to the password hint.");
        const manual = typeof input.password === "string" && !!input.password;
        const unlock = typeof input.unlock === "string" && !!input.unlock;
        if (manual && unlock) throw new Error("Use only one option: your SQL password or the answer to the password hint.");
        if (!manual && !unlock) throw new Error("Enter your SQL password, or answer the password hint to unlock the saved password.");
        const request = validateSqlRequest({ ...input, host: config?.vms?.[0]?.url, password: manual ? input.password : "pending-unlock" }, config);
        if (unlock) {
            sqlPreparing = true;
            let decrypted: Buffer | undefined;
            try {
                let encrypted: string;
                prepareSqlUser();
                try { encrypted = readFileSync(sqlUserPath, "utf8").trim(); }
                catch { throw new Error("Cannot read credentials/.sql-user. Enter the SQL password manually or restore the encrypted user file."); }
                decrypted = await decryptSqlPassword(encrypted, input.unlock as string, SQL_PASSWORD_SALT);
                if (stopping) throw new Error("The app is stopping. Relaunch to continue.");
                request.password = decrypted.toString("utf8");
                validateSqlRequest(request, config);
            } finally { decrypted?.fill(0); sqlPreparing = false; heartbeatDeadline.heartbeat(); }
        }
        secrets.add(request.password);
        const execution = startSql(request, { command: options.sqlCommand, args: options.sqlArgs, timeoutMs: options.sqlTimeoutMs });
        sqlWorker = execution.child;
        sqlRun = { state: "running", output: "", host: request.host, database: request.database };
        void execution.result.then(result => {
            sqlRun = { ...sqlRun, ...result };
            sqlWorker = undefined;
            heartbeatDeadline.heartbeat();
        });
        return reply(c, 202, status(input.config));
    });
    app.on("POST", ["/api/settings", "/api/deploy"], c => {
        const input = c.get("input");
        if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
        const value = JSON.parse(input.config);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
        // Write in place: replacing a bind-mounted file would leave the container reading its old inode.
        writeFileSync(configPath, JSON.stringify(value, null, 4) + "\n");
        if (c.req.path === "/api/settings") { return reply(c, 200, status()); }
        const ready = readiness(input.config);
        if (!ready.ready || !ready.config || !ready.auth || !ready.cert) { return reply(c, 400, { error: ready.error }); }
        value.status = { ...value.status, "deploy-start-ok": 1 };
        writeFileSync(configPath, JSON.stringify(value, null, 4) + "\n");
        ready.config.status = value.status;
        snapshot = mkdtempSync(join(tmpdir(), "suitecontainer-run-"));
        const workerConfig = join(snapshot, "config.json");
        const workerAuth = join(snapshot, "auth.json");
        writeFileSync(workerConfig, JSON.stringify(ready.config), { mode: 0o600 });
        writeFileSync(workerAuth, JSON.stringify(ready.auth), { mode: 0o600 });
        if (ready.auth["gitlab-token"]) secrets.add(ready.auth["gitlab-token"]);
        run = { state: "running", log: "Starting deployment...\n", started: new Date().toISOString() };
        worker = spawn(process.execPath, [options.workerScript ?? fileURLToPath(new URL("./install.js", import.meta.url)), "--deploy"], {
            stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true,
            env: { ...process.env, FORCE_COLOR: "1", SUITECONTAINER_CONFIG: workerConfig, SUITECONTAINER_AUTH: workerAuth,
                SUITECONTAINER_PUBLIC_KEY: ready.cert.publicPath!, SUITECONTAINER_PRIVATE_KEY: ready.cert.privatePath!,
                SUITECONTAINER_NONINTERACTIVE: "1", SUITECONTAINER_DEPLOY_PASSKEY: passkey },
        });
        const append = (chunk: Buffer) => { run.log = (run.log + chunk.toString()).slice(-512 * 1024); };
        worker.stdout!.on("data", append);
        worker.stderr!.on("data", append);
        worker.on("error", error => append(Buffer.from(message(error) + "\n")));
        worker.on("close", code => {
            run.state = code === 0 ? "succeeded" : "failed";
            run.finished = new Date().toISOString();
            run.log = redact(run.log);
            if (snapshot) rmSync(snapshot, { recursive: true, force: true });
            snapshot = undefined; worker = undefined;
            heartbeatDeadline.heartbeat();
        });
        return reply(c, 202, status());
    });
    app.post("/api/credentials", c => {
        const input = c.get("input");
        let settings: string | undefined;
        if (input.config !== undefined) {
            if (typeof input.config !== "string") throw new Error("Configuration must be JSON text.");
            const value = JSON.parse(input.config);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
            settings = input.config;
        }
        const auth = readAuth(authPath);
        if (input.token !== undefined) {
            if (typeof input.token !== "string" || /[\r\n\0]/.test(input.token)) throw new Error("Enter a valid GitLab token.");
            if (input.token.trim()) auth["gitlab-token"] = input.token.trim();
        }
        const cert = auth["suitecloud-certificates"] ?? { public: "", private: "", id: "" };
        for (const key of ["public", "private", "id"] as const) {
            if (input[key] !== undefined) {
                if (typeof input[key] !== "string" || /[\r\n\0,]/.test(input[key])) throw new Error("Certificate settings must be single-line text.");
                cert[key] = input[key].trim();
            }
        }
        auth["suitecloud-certificates"] = cert;
        if (settings !== undefined) writeFileSync(configPath, settings);
        writeFileSync(authPath, JSON.stringify(auth, null, 4) + "\n", { mode: 0o600 });
        chmodSync(authPath, 0o600);
        return reply(c, 200, status());
    });
    app.post("/api/generate", c => {
        const input = c.get("input");
        const auth = readAuth(authPath);
        if (certificateState(auth).hasExisting && input.replace !== true) throw new Error("Confirm replacement: old certificates generated by this app will not be preserved, and the saved certificate ID will be cleared.");
        replaceCertificates(credentials, authPath);
        generatedCertificates = true;
        return reply(c, 200, status());
    });
    app.post("/api/stop", c => {
        const response = reply(c, 200, { stopped: true });
        stopApp();
        return response;
    });
    app.notFound(c => reply(c, 404, { error: "Page not found." }));
    app.onError((error, c) => reply(c, 400, { error: redact(message(error)) }));
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    const stopApp = () => {
        if (stopping) return;
        stopping = true;
        sftpService.stop();
        server.close(options.onStop ?? (() => process.exit(0)));
    };
    const inactivityTimer = setInterval(() => {
        if (!stopping && heartbeatDeadline.expired(busy() || sftpService.active)) stopApp();
    }, options.inactivityCheckMs ?? 1000);
    inactivityTimer.unref();
    server.once("close", () => clearInterval(inactivityTimer));
    server.once("close", () => sftpService.stop());
    server.requestTimeout = 15_000;
    server.once("close", () => sqlWorker?.kill("SIGKILL"));
    server.on("error", error => { console.error(message(error)); process.exitCode = 1; });
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
        writeFileSync(options.sessionFile ?? "/tmp/suitecontainer-web-url", `/#session=${session}`, { mode: 0o600 });
        console.log("SuiteCloud deployment page is ready.");
    });
    const shutdown = () => {
        stopping = true;
        sftpService.stop();
        sqlWorker?.kill("SIGKILL");
        if (worker?.pid) { try { process.kill(-worker.pid, "SIGTERM"); } catch { worker.kill("SIGTERM"); } }
        server.close();
        const timer = setTimeout(() => process.exit(0), 3000);
        timer.unref();
    };
    if (options.signalHandlers !== false) {
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        server.once("close", () => { process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); });
    }
    return server;
}
