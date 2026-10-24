export interface ApiEnvironment {
    location: Pick<Location, "hash" | "pathname">;
    sessionStorage: Pick<Storage, "getItem" | "setItem">;
    history: Pick<History, "replaceState">;
    fetch: typeof fetch;
}

export function createSiteApi(
    environment: ApiEnvironment,
    connectionLost: () => void,
    requestSucceeded: () => void,
    connectionMessage: string,
) {
    const fragment = new URLSearchParams(environment.location.hash.slice(1));
    const session =
        fragment.get("session") ||
        environment.sessionStorage.getItem("suitecloud-session") ||
        "";
    environment.sessionStorage.setItem("suitecloud-session", session);
    environment.history.replaceState(null, "", environment.location.pathname);
    const lifetime = new AbortController();
    let sequence = 0;
    const requestId = () =>
        globalThis.crypto?.randomUUID?.() ||
        Date.now().toString(36) +
            "-" +
            (++sequence).toString(36) +
            "-" +
            Math.random().toString(36).slice(2);

    async function request(
        path: string,
        data?: unknown,
        idempotencyKey?: string,
        signal?: AbortSignal,
    ): Promise<Response> {
        const mutation =
            data !== undefined &&
            !["check", "validate", "heartbeat"].includes(path);
        const timeout = AbortSignal.timeout(
            path === "sftp" || path === "playwright/cancel"
                ? 30000
                : path === "playwright/run"
                  ? 20000
                  : 10000,
        );
        const signals = [lifetime.signal, timeout, ...(signal ? [signal] : [])];
        let response: Response;
        try {
            response = await environment.fetch("/api/" + path, {
                signal: AbortSignal.any(signals),
                method: data === undefined ? "GET" : "POST",
                headers: {
                    "X-Session-Token": session,
                    ...(data === undefined
                        ? {}
                        : { "Content-Type": "application/json" }),
                    ...(mutation
                        ? { "Idempotency-Key": idempotencyKey || requestId() }
                        : {}),
                },
                ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            });
        } catch (error) {
            if (lifetime.signal.aborted || signal?.aborted) throw error;
            connectionLost();
            throw new Error(connectionMessage);
        }
        if (!response.ok) {
            let result: { error?: string };
            try {
                result = (await response.json()) as { error?: string };
            } catch {
                result = {};
            }
            if (
                response.status >= 500 ||
                result.error?.startsWith("The app is stopping")
            ) {
                connectionLost();
                throw new Error(connectionMessage);
            }
            throw new Error(
                result.error || "The request could not be completed.",
            );
        }
        if (path !== "heartbeat") requestSucceeded();
        return response;
    }
    async function api<T>(
        path: string,
        data?: unknown,
        key?: string,
        signal?: AbortSignal,
    ): Promise<T> {
        const response = await request(path, data, key, signal);
        try {
            return (await response.json()) as T;
        } catch (error) {
            if (lifetime.signal.aborted || signal?.aborted) throw error;
            connectionLost();
            throw new Error(connectionMessage);
        }
    }
    return {
        api,
        request,
        session,
        requestId,
        dispose: () => lifetime.abort(),
    };
}
