import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ConfigurationService } from "./configuration.ts";
import type { SuiteAppsService } from "./suiteapps.ts";
import type { CredentialsService } from "./credentials.ts";
import type { OperationsService } from "./operations.ts";
import { ServiceError, message } from "./errors.ts";

export class DeploymentService {
    run: {
        state: "idle" | "running" | "succeeded" | "failed";
        log: string;
        started?: string;
        finished?: string;
        operationId?: string;
    } = { state: "idle", log: "" };
    private worker?: ChildProcess;
    private completed?: Promise<void>;
    private configuration: ConfigurationService;
    private suiteapps: SuiteAppsService;
    private credentials: CredentialsService;
    private operations: OperationsService;
    private passkey: string;
    private workerScript?: string;
    constructor(
        configuration: ConfigurationService,
        suiteapps: SuiteAppsService,
        credentials: CredentialsService,
        operations: OperationsService,
        passkey: string,
        workerScript?: string,
    ) {
        this.configuration = configuration;
        this.suiteapps = suiteapps;
        this.credentials = credentials;
        this.operations = operations;
        this.passkey = passkey;
        this.workerScript = workerScript;
    }
    start(input: Record<string, unknown>) {
        this.operations.assertIdle();
        // A string config is the original browser contract and retains explicit multi-target deployment.
        const legacy =
            input.__legacyConfig === true && input.targetId === undefined;
        const value = legacy
            ? (input.config as Record<string, unknown>)
            : this.suiteapps.select(input.targetId);
        if (legacy) this.configuration.write(value);
        const ready = this.suiteapps.readiness(value);
        if (!ready.ready || !ready.config || !ready.auth || !ready.cert)
            throw new ServiceError(
                ready.blockers[0]?.code ?? "not_ready",
                ready.error,
            );
        const operation = this.operations.reserve(
            "deployment",
            this.suiteapps.targets(ready.config).map((target) => target.id),
        );
        let snapshot: string | undefined;
        try {
            if (legacy) {
                const saved = {
                    ...value,
                    status: {
                        ...(value.status as object),
                        "deploy-start-ok": 1 as const,
                    },
                };
                this.configuration.write(saved);
                ready.config.status = saved.status;
            }
            snapshot = mkdtempSync(join(tmpdir(), "suitecontainer-run-"));
            const workerConfig = join(snapshot, "config.json");
            const workerAuth = join(snapshot, "auth.json");
            writeFileSync(workerConfig, JSON.stringify(ready.config), {
                mode: 0o600,
            });
            writeFileSync(workerAuth, JSON.stringify(ready.auth), {
                mode: 0o600,
            });
            if (ready.auth["gitlab-token"])
                this.credentials.shared.secrets.add(ready.auth["gitlab-token"]);
            this.run = {
                state: "running",
                log: "Starting deployment...\n",
                started: new Date().toISOString(),
                operationId: operation.id,
            };
            this.operations.append(operation.id, this.run.log);
            this.operations.running(operation.id);
            const script =
                this.workerScript ??
                fileURLToPath(
                    new URL(
                        import.meta.url.endsWith(".ts")
                            ? "../install.ts"
                            : "../install.js",
                        import.meta.url,
                    ),
                );
            const worker = spawn(process.execPath, [script, "--deploy"], {
                stdio: ["ignore", "pipe", "pipe"],
                detached: true,
                windowsHide: true,
                env: {
                    ...process.env,
                    FORCE_COLOR: "1",
                    SUITECONTAINER_CONFIG: workerConfig,
                    SUITECONTAINER_AUTH: workerAuth,
                    SUITECONTAINER_PUBLIC_KEY: ready.cert.publicPath!,
                    SUITECONTAINER_PRIVATE_KEY: ready.cert.privatePath!,
                    SUITECONTAINER_NONINTERACTIVE: "1",
                    SUITECONTAINER_DEPLOY_PASSKEY: this.passkey,
                },
            });
            this.worker = worker;
            const append = (chunk: Buffer) => {
                this.operations.append(operation.id, chunk.toString());
                this.run.log = this.operations.logs(operation.id).log;
            };
            worker.stdout!.on("data", append);
            worker.stderr!.on("data", append);
            worker.on("error", (error) =>
                append(Buffer.from(message(error) + "\n")),
            );
            this.completed = new Promise((resolve) =>
                worker.once("close", (code) => {
                    this.run.state = code === 0 ? "succeeded" : "failed";
                    this.run.finished = new Date().toISOString();
                    this.run.log = this.credentials.redact(this.run.log);
                    this.operations.finish(
                        operation.id,
                        { exitCode: code },
                        this.run.state,
                    );
                    if (snapshot)
                        rmSync(snapshot, { recursive: true, force: true });
                    this.worker = undefined;
                    resolve();
                }),
            );
            return operation.id;
        } catch (error) {
            if (snapshot) rmSync(snapshot, { recursive: true, force: true });
            this.operations.fail(operation.id, error);
            throw error;
        }
    }
    status() {
        return {
            ...this.run,
            log: this.credentials.redact(
                this.run.log,
                this.run.state === "running",
            ),
        };
    }
    async dispose(): Promise<void> {
        const worker = this.worker;
        if (!worker) return;
        const terminate = (force: boolean) => {
            if (!worker.pid) return;
            if (process.platform === "win32") {
                const killer = spawn(
                    "taskkill",
                    [
                        "/PID",
                        String(worker.pid),
                        "/T",
                        ...(force ? ["/F"] : []),
                    ],
                    { stdio: "ignore", windowsHide: true },
                );
                killer.on("error", () =>
                    worker.kill(force ? "SIGKILL" : "SIGTERM"),
                );
            } else {
                try {
                    process.kill(-worker.pid, force ? "SIGKILL" : "SIGTERM");
                } catch {
                    worker.kill(force ? "SIGKILL" : "SIGTERM");
                }
            }
        };
        terminate(false);
        const timer = setTimeout(() => terminate(true), 2000);
        timer.unref();
        await this.completed;
        clearTimeout(timer);
    }
}
