import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readAuth, type Auth } from "./step-auth.ts";
import { validateConfig, type Config } from "./step-config.ts";
import { prepareCertificates, verifyCertificates } from "./step-certificates.ts";
import { credentialPath, hostPath, type MountRecord } from "./web-mounts.ts";
import { deploymentPage } from "./web-page.ts";

type Run = { state: "idle" | "running" | "succeeded" | "failed"; log: string; started?: string; finished?: string };

export function generateAllowed(auth: Auth, mounted: boolean): boolean {
    const certificates = auth["suitecloud-certificates"];
    return !mounted && certificates?.public === "" && certificates?.private === "";
}

export function mountChanges(config: Config, auth: Auth, record: MountRecord): boolean {
    const local = Object.fromEntries(config.suiteapps.filter(repo => repo.localPath).map(repo => [repo.directory, hostPath(record, repo.localPath!)]));
    const names = new Set([...Object.keys(local), ...Object.keys(record.local)]);
    if ([...names].some(name => local[name] !== record.local[name])) return true;
    const usedExternal = new Set<string>();
    const missing = ["public", "private"].some(key => {
        const path = auth["suitecloud-certificates"]?.[key as "public" | "private"];
        if (typeof path === "string" && record.certificates[hostPath(record, path)]) usedExternal.add(hostPath(record, path));
        return typeof path === "string" && !!path.trim() && !credentialPath(record, path);
    });
    return missing || Object.keys(record.certificates).some(path => !usedExternal.has(path));
}

function message(error: unknown): string {
    return (error instanceof Error ? error.message : String(error))
        .replace(/ Update .* and run the start script again\.$/, "");
}

export function startWebServer(options: {
    configDirectory?: string; port?: number; host?: string; workerScript?: string;
    sessionFile?: string; onStop?: () => void; signalHandlers?: boolean;
} = {}): Server {
    const configDirectory = options.configDirectory ?? "/config";
    const configPath = join(configDirectory, "suitecontainer.config.json");
    const credentials = join(configDirectory, "credentials");
    const authPath = join(credentials, "auth.json");
    const mountedCredentialPath = (path: string) => {
        const runtime = credentialPath(record, path);
        return runtime?.startsWith("/config/credentials/")
            ? join(credentials, runtime.slice("/config/credentials/".length)) : runtime;
    };
    const session = randomBytes(32).toString("hex");
    const passkey = randomBytes(32).toString("hex");
    const record: MountRecord = JSON.parse(readFileSync(join(credentials, "web-mounts.json"), "utf8"));
    let run: Run = { state: "idle", log: "" };
    let worker: ChildProcess | undefined;
    let snapshot: string | undefined;
    let stopping = false;
    const secrets = new Set([passkey, session]);
    const busy = () => run.state === "running";
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
            if (!certs.public || !certs.private) error = "Set both certificate paths. Restore the matching pair; replacements will not be generated.";
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
        return { canGenerate: generateAllowed(auth, mounted), error, publicPath, privatePath };
    };
    const readiness = (text: string) => {
        try {
            const config = validateConfig(JSON.parse(text));
            const auth = readAuth(authPath);
            if (config.suiteapps.length === 0) throw new Error("Add at least one SuiteApp before deploying.");
            if (mountChanges(config, auth, record)) throw new Error("Relaunch required: local repositories or certificate paths need different mounts.");
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
        let relaunch = false;
        try {
            const value = JSON.parse(text);
            if (Array.isArray(value.suiteapps)) relaunch = mountChanges(value, auth, record);
        } catch { /* validation explains this */ }
        return {
            config: text, ready: ready.ready && !busy(), error: credentialError || ready.error,
            credentialError, tokenPresent: !!auth["gitlab-token"]?.trim(),
            certificates: {
                public: /[\r\n]/.test(auth["suitecloud-certificates"]?.public ?? "") ? "" : auth["suitecloud-certificates"]?.public ?? "",
                private: /[\r\n]/.test(auth["suitecloud-certificates"]?.private ?? "") ? "" : auth["suitecloud-certificates"]?.private ?? "",
                id: auth["suitecloud-certificates"]?.id ?? "", canGenerate: cert.canGenerate && !busy(),
                error: cert.error, canDownload: !!cert.publicPath && existsSync(cert.publicPath) && !cert.error },
            relaunch, run: { ...run, log: redact(run.log) },
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
            if (busy() && url.pathname !== "/api/check") { reply(res, 409, { error: "Deployment is running. Wait for its results before making changes." }); return; }
            const input = await body(req);
            // Recheck after the asynchronous body read to prevent simultaneous clicks starting two workers.
            if (stopping) { reply(res, 409, { error: "The app is stopping." }); return; }
            if (url.pathname === "/api/check") {
                if (typeof input.config !== "string") throw new Error("Enter configuration JSON.");
                reply(res, 200, status(input.config)); return;
            }
            if (busy()) { reply(res, 409, { error: "Deployment is already running." }); return; }
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
                });
                reply(res, 202, status()); return;
            }
            if (url.pathname === "/api/credentials") {
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
                writeFileSync(authPath, JSON.stringify(auth, null, 4) + "\n", { mode: 0o600 });
                chmodSync(authPath, 0o600);
                reply(res, 200, status()); return;
            }
            if (url.pathname === "/api/generate") {
                const auth = readAuth(authPath);
                if (!certificateState(auth).canGenerate) throw new Error("Generation requires no mounted certificates and both certificate paths to be empty.");
                const config = { suiteapps: [], vms: [], certificates: auth["suitecloud-certificates"] };
                prepareCertificates(config, credentials, authPath);
                reply(res, 200, status()); return;
            }
            if (url.pathname === "/api/stop") {
                stopping = true;
                reply(res, 200, { stopped: true });
                server.close(options.onStop ?? (() => process.exit(0)));
                return;
            }
            reply(res, 404, { error: "Page not found." });
        } catch (error) { reply(res, 400, { error: redact(message(error)) }); }
    });
    server.requestTimeout = 15_000;
    server.on("error", error => { console.error(message(error)); process.exitCode = 1; });
    server.listen(options.port ?? 8080, options.host ?? "0.0.0.0", () => {
        writeFileSync(options.sessionFile ?? "/tmp/suitecontainer-web-url", `/#session=${session}`, { mode: 0o600 });
        console.log("SuiteCloud deployment page is ready.");
    });
    const shutdown = () => {
        stopping = true;
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
