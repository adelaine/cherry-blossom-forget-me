import type { PlaywrightSettings } from "./step-config.ts";

type RunnerState = {
    state: "idle" | "running" | "succeeded" | "failed";
    log: string;
    project: string;
    started?: string;
    finished?: string;
};

export class PlaywrightClient {
    private run: RunnerState = { state: "idle", log: "", project: "" };
    private available = false;
    private error = "";
    private pending?: Promise<void>;
    private generation = 0;
    private disposed = false;
    private closing?: Promise<void>;
    private starting?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;
    private url: string;
    private token: string;

    constructor(url = process.env.SUITECONTAINER_PLAYWRIGHT_URL ?? "", token = process.env.SUITECONTAINER_PLAYWRIGHT_TOKEN ?? "") {
        this.url = url;
        this.token = token;
        if (url && token) {
            void this.refresh();
            this.timer = setInterval(() => void this.refresh(), 1500);
            this.timer.unref();
        }
    }

    get active(): boolean { return this.run.state === "running"; }

    status(settings?: PlaywrightSettings) {
        const enabled = settings?.enabled === true;
        const relaunch = enabled && (!this.url || this.available && settings.project !== this.run.project);
        return { ...this.run, available: this.available, enabled, relaunch,
            settings: settings ?? { enabled: false, project: "", testFile: "", workers: 1 },
            error: this.error || (enabled && !this.url ? "Save settings and relaunch SuiteContainer to start the test runner." : "") };
    }

    private async request(path: string, input?: unknown): Promise<RunnerState> {
        if (!this.url || !this.token) throw new Error("Save settings and relaunch SuiteContainer to start the test runner.");
        let response: Response;
        try {
            response = await fetch(new URL(path, this.url), {
                method: input === undefined ? "GET" : "POST",
                headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
                body: input === undefined ? undefined : JSON.stringify(input),
                signal: AbortSignal.timeout(path === "/cancel" ? 15000 : 5000),
            });
        } catch { throw new Error("Cannot reach the test runner. Check its container and relaunch SuiteContainer."); }
        const value = await response.json() as RunnerState & { error?: string };
        if (!response.ok) throw new Error(value.error || "The test runner could not complete the request.");
        return value;
    }

    private refresh(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.pending) return this.pending;
        const generation = this.generation;
        this.pending = this.request("/state").then(value => {
            if (this.disposed || generation !== this.generation) return;
            this.run = value;
            this.available = true;
            this.error = "";
        }).catch(error => {
            if (this.disposed || generation !== this.generation) return;
            this.available = false;
            this.error = error instanceof Error ? error.message : String(error);
        }).finally(() => { this.pending = undefined; });
        return this.pending;
    }

    async start(settings: PlaywrightSettings, host: string, account: string): Promise<void> {
        if (!settings.enabled || !settings.project) throw new Error("Enable Playwright and choose its project directory before running tests.");
        if (this.active) throw new Error("Playwright tests are already running.");
        this.generation++;
        this.run = { ...this.run, state: "running", log: "Starting Playwright...\n" };
        this.starting = (async () => {
            try {
                this.run = await this.request("/run", { project: settings.project, testFile: settings.testFile ?? "", workers: settings.workers ?? 1, host, account });
                this.error = "";
                this.available = true;
            } catch (error) {
                // A timed-out start can still have reached the runner. Poll before permitting another job.
                try { this.run = await this.request("/state"); }
                catch { this.error = "The test start could not be confirmed. Reconnect to the runner before starting another job."; }
                throw error;
            }
        })();
        try { await this.starting; }
        finally { this.starting = undefined; }
    }

    async cancel(): Promise<void> {
        // Another tab can stop a run while the runner is still validating its start.
        try { await this.starting; } catch { /* Cancel any run whose start response was lost. */ }
        this.generation++;
        this.run = await this.request("/cancel", {});
    }

    dispose(): Promise<void> {
        if (this.closing) return this.closing;
        this.disposed = true;
        clearInterval(this.timer);
        this.closing = (async () => {
            if (this.url && this.token) {
                try { await this.request("/shutdown", {}); } catch { /* The runner watchdog handles an unreachable app. */ }
            }
        })();
        return this.closing;
    }
}
