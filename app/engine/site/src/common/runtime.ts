import { createContext, createElement, type ComponentChildren } from "preact";
import { useContext, useLayoutEffect, useState } from "preact/hooks";
import { createSiteApi, type ApiEnvironment } from "./api.ts";
import { errorMessage, parseConfiguration, type ServerState } from "./state.ts";
import {
    ACTIVITY_GRACE_MS,
    HEARTBEAT_INTERVAL_MS,
} from "../../../server/src/web-inactivity.ts";

export interface RuntimeEnvironment extends ApiEnvironment {
    document: Pick<Document, "addEventListener" | "removeEventListener">;
    window: Pick<
        Window,
        "addEventListener" | "removeEventListener" | "close" | "closed"
    >;
    now: () => number;
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
}

function browserEnvironment(): RuntimeEnvironment {
    return {
        location,
        history,
        sessionStorage,
        document,
        window,
        fetch: fetch.bind(globalThis),
        now: () => Date.now(),
        setTimeout: setTimeout.bind(globalThis),
        clearTimeout: clearTimeout.bind(globalThis),
        setInterval: setInterval.bind(globalThis),
        clearInterval: clearInterval.bind(globalThis),
    };
}

export class SiteRuntime {
    snapshot: ServerState | undefined;
    configText = "";
    editing = false;
    credentialEditing = false;
    settingsMessage = "";
    actionError = "";
    connectionFailed = false;
    stopped = false;
    stopMessage = "";
    collapseVersion = 0;
    readonly pending = new Set<string>();
    readonly connectionMessage =
        "Connection to the app was lost. It may have stopped automatically after inactivity. Start the launcher again to reconnect.";
    private listeners = new Set<() => void>();
    private client: ReturnType<typeof createSiteApi>;
    private disposed = false;
    private initialized = false;
    private lastActivity: number;
    private heartbeatPending = false;
    private idleCloseScheduled = false;
    private draftVersion = 0;
    private responseVersion = 0;
    private refreshSequence = 0;
    private lastDeploymentStarted: string | undefined;
    private sectionsInitialized = false;
    private checking: ReturnType<typeof setTimeout> | undefined;
    private timers = new Set<ReturnType<typeof setTimeout>>();
    private intervals = new Set<ReturnType<typeof setInterval>>();
    private cleanups: (() => void)[] = [];
    private refreshController: AbortController | undefined;

    constructor(
        readonly environment: RuntimeEnvironment = browserEnvironment(),
    ) {
        this.lastActivity = environment.now();
        this.client = createSiteApi(
            environment,
            () => this.connectionLost(),
            () => {
                if (!this.disposed && this.connectionFailed) {
                    this.connectionFailed = false;
                    this.notify();
                }
            },
            this.connectionMessage,
        );
    }
    get session() {
        return this.client.session;
    }
    requestId = () => this.client.requestId();
    api = <T = ServerState>(
        path: string,
        data?: unknown,
        key?: string,
        signal?: AbortSignal,
    ): Promise<T> => this.client.api<T>(path, data, key, signal);
    request = (
        path: string,
        data?: unknown,
        key?: string,
        signal?: AbortSignal,
    ): Promise<Response> => this.client.request(path, data, key, signal);
    get busy(): boolean {
        return (
            this.snapshot?.run.state === "running" ||
            this.snapshot?.sql?.state === "running" ||
            !!this.snapshot?.sql?.preparing ||
            this.snapshot?.playwright?.state === "running" ||
            ["deployment", "sql", "playwright"].some((id) =>
                this.pending.has(id),
            )
        );
    }
    get preventStop(): boolean {
        return (
            this.snapshot?.run.state === "running" ||
            this.snapshot?.sql?.state === "running" ||
            !!this.snapshot?.sql?.preparing ||
            this.pending.has("sql") ||
            this.pending.has("deployment")
        );
    }
    get active(): boolean {
        return (
            this.busy ||
            ["starting", "running"].includes(
                this.snapshot?.sftp?.state ?? "",
            ) ||
            this.pending.has("sftp")
        );
    }
    get disabled(): boolean {
        return (
            !this.snapshot || this.busy || this.connectionFailed || this.stopped
        );
    }
    subscribe = (listener: () => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    private notify() {
        if (!this.disposed) for (const listener of this.listeners) listener();
    }
    setCredentialEditing(value: boolean) {
        this.credentialEditing = value;
        this.notify();
    }
    setSettingsMessage(value: string) {
        this.settingsMessage = value;
        this.notify();
    }
    setActionError(value: string) {
        this.actionError = value;
        this.notify();
    }
    setPending(id: string, value: boolean) {
        if (value) this.pending.add(id);
        else this.pending.delete(id);
        this.notify();
    }
    changeConfig(text: string) {
        if (this.stopped || this.disposed) return;
        this.configText = text;
        this.editing = true;
        this.draftVersion++;
        this.actionError = "";
        this.settingsMessage =
            "Settings changed. Save settings, or click Deploy to save and deploy.";
        if (this.checking !== undefined)
            this.environment.clearTimeout(this.checking);
        this.checking = this.environment.setTimeout(() => {
            this.checking = undefined;
            void this.refresh();
        }, 350);
        this.notify();
    }
    updateConfig(update: (config: Record<string, unknown>) => void) {
        const config = parseConfiguration(this.configText);
        update(config);
        this.changeConfig(JSON.stringify(config, null, 4));
    }
    themeDraft(theme: string) {
        const config = parseConfiguration(this.configText);
        config.status = {
            ...(config.status as Record<string, unknown> | undefined),
            theme,
        };
        this.configText = JSON.stringify(config, null, 4);
        this.draftVersion++;
        this.notify();
    }
    accept(next: ServerState) {
        if (this.stopped || this.disposed) return;
        this.responseVersion++;
        this.snapshot = next;
        if (!this.editing) this.configText = next.config;
        if (!this.sectionsInitialized) {
            this.sectionsInitialized = true;
            if (next.deploymentStarted) this.collapseVersion++;
        }
        if (
            next.run.started &&
            next.run.started !== this.lastDeploymentStarted
        ) {
            this.lastDeploymentStarted = next.run.started;
            this.collapseVersion++;
        }
        this.notify();
    }
    saved(next: ServerState, submittedText = this.configText) {
        if (this.stopped || this.disposed) return;
        if (this.configText === submittedText) this.editing = false;
        this.accept(next);
        this.settingsMessage = "Settings saved.";
        this.notify();
    }
    refresh = async () => {
        if (this.stopped || this.disposed) return;
        this.refreshController?.abort();
        const controller = (this.refreshController = new AbortController());
        const sequence = ++this.refreshSequence,
            draft = this.draftVersion,
            response = this.responseVersion;
        try {
            const next = this.editing
                ? await this.api(
                      "check",
                      { config: this.configText },
                      undefined,
                      controller.signal,
                  )
                : await this.api(
                      "state",
                      undefined,
                      undefined,
                      controller.signal,
                  );
            if (
                !controller.signal.aborted &&
                sequence === this.refreshSequence &&
                draft === this.draftVersion &&
                response === this.responseVersion
            )
                this.accept(next);
        } catch (error) {
            if (controller.signal.aborted || this.stopped || this.disposed)
                return;
            this.actionError = errorMessage(error);
            this.connectionLost();
        }
    };
    heartbeat = async () => {
        if (
            this.stopped ||
            this.disposed ||
            this.heartbeatPending ||
            this.environment.now() - this.lastActivity >= ACTIVITY_GRACE_MS
        )
            return;
        this.heartbeatPending = true;
        try {
            await this.api("heartbeat", {});
        } catch {
            /* The request helper reports connection errors. */
        } finally {
            this.heartbeatPending = false;
        }
    };
    private timeout(callback: () => void, delay: number) {
        const timer = this.environment.setTimeout(() => {
            this.timers.delete(timer);
            if (!this.disposed) callback();
        }, delay);
        this.timers.add(timer);
    }
    private connectionLost() {
        if (this.stopped || this.disposed) return;
        this.connectionFailed = true;
        this.notify();
        if (
            !this.idleCloseScheduled &&
            this.environment.now() - this.lastActivity >= ACTIVITY_GRACE_MS &&
            !this.active
        ) {
            this.idleCloseScheduled = true;
            this.timeout(() => {
                if (
                    !this.connectionFailed ||
                    this.environment.now() - this.lastActivity <
                        ACTIVITY_GRACE_MS
                ) {
                    this.idleCloseScheduled = false;
                    return;
                }
                try {
                    this.environment.window.close();
                } catch {
                    /* Browser may refuse. */
                }
            }, 5000);
        }
    }
    start() {
        if (this.initialized || this.disposed) return;
        this.initialized = true;
        const activity = (event: Event) => {
            if (!event.isTrusted || this.stopped) return;
            const expired =
                this.environment.now() - this.lastActivity >= ACTIVITY_GRACE_MS;
            this.lastActivity = this.environment.now();
            if (expired) void this.heartbeat();
        };
        for (const name of ["click", "input", "keydown", "scroll"]) {
            this.environment.document.addEventListener(name, activity, {
                capture: true,
                passive: true,
            });
            this.cleanups.push(() =>
                this.environment.document.removeEventListener(name, activity, {
                    capture: true,
                }),
            );
        }
        const dispose = () => this.dispose();
        this.environment.window.addEventListener("pagehide", dispose);
        this.cleanups.push(() =>
            this.environment.window.removeEventListener("pagehide", dispose),
        );
        void this.refresh();
        void this.heartbeat();
        this.intervals.add(
            this.environment.setInterval(() => void this.refresh(), 2000),
        );
        this.intervals.add(
            this.environment.setInterval(
                () => void this.heartbeat(),
                HEARTBEAT_INTERVAL_MS,
            ),
        );
    }
    stop = async () => {
        if (
            this.stopped ||
            this.disposed ||
            this.preventStop ||
            this.pending.has("stop") ||
            this.connectionFailed
        )
            return;
        this.setActionError("");
        this.setPending("stop", true);
        try {
            await this.api("stop", {});
            if (this.disposed) return;
            this.stopped = true;
            this.client.dispose();
            this.stopMessage = "App stopped. Attempting to close this page…";
            this.refreshController?.abort();
            for (const interval of this.intervals)
                this.environment.clearInterval(interval);
            this.intervals.clear();
            this.timeout(() => {
                try {
                    this.environment.window.close();
                } catch {
                    /* Browser may refuse. */
                }
                if (!this.environment.window.closed) {
                    this.stopMessage =
                        "App stopped. Your browser kept this page open. You can close this tab.";
                    this.notify();
                }
            }, 5000);
        } catch (error) {
            this.setActionError(errorMessage(error));
        } finally {
            this.setPending("stop", false);
        }
    };
    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.client.dispose();
        this.refreshController?.abort();
        if (this.checking !== undefined)
            this.environment.clearTimeout(this.checking);
        for (const timer of this.timers) this.environment.clearTimeout(timer);
        for (const interval of this.intervals)
            this.environment.clearInterval(interval);
        for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
        this.timers.clear();
        this.intervals.clear();
        this.listeners.clear();
    }
}

const SiteContext = createContext<
    { runtime: SiteRuntime; revision: number } | undefined
>(undefined);
export function SiteProvider({
    runtime,
    children,
}: {
    runtime: SiteRuntime;
    children: ComponentChildren;
}) {
    const [revision, setRevision] = useState(0);
    useLayoutEffect(() => {
        const unsubscribe = runtime.subscribe(() =>
            setRevision((value) => value + 1),
        );
        runtime.start();
        return () => {
            unsubscribe();
            runtime.dispose();
        };
    }, [runtime]);
    return createElement(
        SiteContext.Provider,
        { value: { runtime, revision } },
        children,
    );
}
export function useSite(): SiteRuntime {
    const context = useContext(SiteContext);
    if (!context) throw new Error("SiteProvider is required.");
    return context.runtime;
}
