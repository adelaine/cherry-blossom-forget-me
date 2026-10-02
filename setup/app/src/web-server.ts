import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
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
    return (error instanceof Error ? error.message : String(error))
        .replace(/ Update .* and run the start script again\.$/, "");
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
                if (!publicPath || !privatePath) error = "Certificate paths require new mounts. Save your settings and relaunch.";
                else { try { verifyCertificates(publicPath, privatePath); } catch (e) { error = message(e); } }
            }
        } else if (mounted) error = "Certificate files already exist. Enter their matching public and private paths.";
        else error = certs
            ? "Generate certificates, register the public certificate on your runbox, and enter the assigned certificate ID."
            : "Save credentials with both certificate paths empty, then generate certificates and register the public certificate on your runbox.";
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
            if (config.suiteapps.some(repo => !repo.localPath) && !auth["gitlab-token"]?.trim()) throw new Error("Enter a GitLab token to copy the SuiteApps.");
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
        try {
            const database = JSON.parse(text)?.vms?.[0]?.database;
            sqlDefaults = {
                user: typeof database?.user === "string" ? database.user : SQL_DEFAULTS.user,
                service: typeof database?.service === "string" ? database.service : SQL_DEFAULTS.service,
            };
        } catch { /* Configuration validation explains malformed JSON. */ }
        let relaunch = false;
        try {
            const value = JSON.parse(text);
            if (Array.isArray(value.suiteapps)) relaunch = mountChanges(value, auth, record, generatedCertificates);
        } catch { /* validation explains this */ }
        return {
            config: text, ready: ready.ready && !busy(), error: credentialError || ready.error,
            credentialError, tokenPresent: !!auth["gitlab-token"]?.trim(),
            certificates: {
                public: /[\r\n]/.test(auth["suitecloud-certificates"]?.public ?? "") ? "" : auth["suitecloud-certificates"]?.public ?? "",
                private: /[\r\n]/.test(auth["suitecloud-certificates"]?.private ?? "") ? "" : auth["suitecloud-certificates"]?.private ?? "",
                id: auth["suitecloud-certificates"]?.id ?? "", canGenerate: !busy(), hasExisting: cert.hasExisting,
                error: cert.error, canDownload: !!cert.publicPath && existsSync(cert.publicPath) && !cert.error },
            relaunch, run: { ...run, log: redact(run.log) },
            sql: { ...sqlRun, output: redact(sqlRun.output), defaults: sqlDefaults, passwordHint: SQL_PASSWORD_HINT,
                hasDefaultPassword: existsSync(sqlUserPath) || existsSync(sqlDefaultPath), preparing: sqlPreparing },
        };
    };
    const reply = (res: ServerResponse, code: number, value: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(value));
    };
    const authorized = (req: IncomingMessage) => {
        const supplied = Buffer.from(String(req.headers["x-session-token"] ?? ""));
        const expected = Buffer.from(session);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    };
    const body = async (req: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
            const bytes = Buffer.from(chunk);
            length += bytes.length;
            if (length > 128 * 1024) throw new Error("Settings are too large (maximum 128 KiB).");
            chunks.push(bytes);
        }
        const data = Buffer.concat(chunks).toString("utf8");
        const value: unknown = JSON.parse(data || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected settings as an object.");
        return value as Record<string, unknown>;
    };
    const server = createServer(async (req, res) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        const host = req.headers.host ?? "";
        if (!/^(?:localhost|127\.0\.0\.1):\d+$/.test(host)) { reply(res, 403, { error: "Open the app through its localhost address." }); return; }
        const url = new URL(req.url ?? "/", `http://${host}`);
        if (req.method === "GET" && ["/", "/page.js", "/page.css"].includes(url.pathname)) {
            const asset = url.pathname === "/" ? deploymentPage.html : url.pathname === "/page.js" ? deploymentPage.script : deploymentPage.style;
            res.writeHead(200, { "Content-Type": url.pathname === "/" ? "text/html; charset=utf-8" : url.pathname === "/page.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-store" });
            res.end(asset); return;
        }
        if (req.method === "GET" && url.pathname === "/health") { reply(res, 200, { ready: true }); return; }
        if (!authorized(req) || (req.method !== "GET" && req.headers.origin !== `http://${host}`)) { reply(res, 403, { error: "Reopen the page using the launcher URL." }); return; }
        try {
            if (req.method === "GET" && url.pathname === "/api/state") { reply(res, 200, status()); return; }
            if (req.method === "GET" && url.pathname === "/api/certificate") {
                const cert = certificateState(readAuth(authPath));
                if (cert.error || !cert.publicPath) throw new Error("A valid certificate pair is required before downloading.");
                res.writeHead(200, { "Content-Type": "application/x-pem-file", "Content-Disposition": 'attachment; filename="public.pem"', "Cache-Control": "no-store" });
                res.end(readFileSync(cert.publicPath)); return;
            }
            if (req.method !== "POST") { reply(res, 404, { error: "Page not found." }); return; }
            if (stopping) { reply(res, 409, { error: "The app is stopping. Relaunch to continue." }); return; }
            if (busy() && !["/api/check", "/api/heartbeat"].includes(url.pathname)) { reply(res, 409, { error: busyMessage() }); return; }
            const input = await body(req);
            // Recheck after the asynchronous body read to prevent simultaneous clicks starting two workers.
            if (stopping) { reply(res, 409, { error: "The app is stopping." }); return; }
            if (url.pathname === "/api/heartbeat") {
                heartbeatDeadline.heartbeat();
                reply(res, 200, { alive: true }); return;
            }
            if (url.pathname === "/api/check") {
                if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
                reply(res, 200, status(input.config)); return;
            }
            if (busy()) { reply(res, 409, { error: busyMessage() }); return; }
            if (url.pathname === "/api/sql") {
                if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
                // SQL needs a configured target, not SuiteCloud certificates or a GitLab token.
                // Use the visible configuration without saving it as a side effect of execution.
                const config = JSON.parse(input.config);
                if ((input.password !== undefined && typeof input.password !== "string") || (input.unlock !== undefined && typeof input.unlock !== "string")) throw new Error("Enter a SQL password or the password hint.");
                const manual = typeof input.password === "string" && !!input.password;
                const unlock = typeof input.unlock === "string" && !!input.unlock;
                if (manual && unlock) throw new Error("Use only one option: the SQL password or the password hint.");
                if (!manual && !unlock) throw new Error("Enter a SQL password or the password hint for the default password.");
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
                reply(res, 202, status(input.config)); return;
            }
            if (url.pathname === "/api/settings" || url.pathname === "/api/deploy") {
                if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
                const value = JSON.parse(input.config);
                if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Configuration must be a JSON object.");
                // Write in place: replacing a bind-mounted file would leave the container reading its old inode.
                writeFileSync(configPath, JSON.stringify(value, null, 4) + "\n");
                if (url.pathname === "/api/settings") { reply(res, 200, status()); return; }
                const ready = readiness(input.config);
                if (!ready.ready || !ready.config || !ready.auth || !ready.cert) { reply(res, 400, { error: ready.error }); return; }
                snapshot = mkdtempSync(join(tmpdir(), "suitecontainer-run-"));
                const workerConfig = join(snapshot, "config.json");
                const workerAuth = join(snapshot, "auth.json");
                writeFileSync(workerConfig, JSON.stringify(ready.config), { mode: 0o600 });
                writeFileSync(workerAuth, JSON.stringify(ready.auth), { mode: 0o600 });
                if (ready.auth["gitlab-token"]) secrets.add(ready.auth["gitlab-token"]);
                run = { state: "running", log: "Starting deployment...\n", started: new Date().toISOString() };
                worker = spawn(process.execPath, [options.workerScript ?? fileURLToPath(new URL("./install.js", import.meta.url)), "--deploy"], {
                    stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true,
                    env: { ...process.env, SUITECONTAINER_CONFIG: workerConfig, SUITECONTAINER_AUTH: workerAuth,
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
                reply(res, 202, status()); return;
            }
            if (url.pathname === "/api/credentials") {
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
                reply(res, 200, status()); return;
            }
            if (url.pathname === "/api/generate") {
                const auth = readAuth(authPath);
                if (certificateState(auth).hasExisting && input.replace !== true) throw new Error("Confirm replacement: old certificates will not be preserved.");
                replaceCertificates(credentials, authPath);
                generatedCertificates = true;
                reply(res, 200, status()); return;
            }
            if (url.pathname === "/api/stop") {
                reply(res, 200, { stopped: true });
                stopApp();
                return;
            }
            reply(res, 404, { error: "Page not found." });
        } catch (error) { reply(res, 400, { error: redact(message(error)) }); }
    });
    const stopApp = () => {
        if (stopping) return;
        stopping = true;
        server.close(options.onStop ?? (() => process.exit(0)));
    };
    const inactivityTimer = setInterval(() => {
        if (!stopping && heartbeatDeadline.expired(busy())) stopApp();
    }, options.inactivityCheckMs ?? 1000);
    inactivityTimer.unref();
    server.once("close", () => clearInterval(inactivityTimer));
    server.requestTimeout = 15_000;
    server.once("close", () => sqlWorker?.kill("SIGKILL"));
    server.on("error", error => { console.error(message(error)); process.exitCode = 1; });
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
        writeFileSync(options.sessionFile ?? "/tmp/suitecontainer-web-url", `/#session=${session}`, { mode: 0o600 });
        console.log("SuiteCloud deployment page is ready.");
    });
    const shutdown = () => {
        stopping = true;
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
