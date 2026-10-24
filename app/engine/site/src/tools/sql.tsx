/** @jsxImportSource preact */
import { useEffect, useRef, useState } from "preact/hooks";
import type { SiteModule } from "../common/module.ts";
import { useSite } from "../common/runtime.ts";
import { errorMessage, targetHost } from "../common/state.ts";

export function Sql() {
    const runtime = useSite();
    const status = runtime.snapshot?.sql;
    const host = targetHost(runtime.configText);
    const [overrides, setOverrides] = useState<{
        host: string;
        account?: string;
        database?: string;
    }>({ host });
    const [password, setPassword] = useState("");
    const [unlock, setUnlock] = useState("");
    const [statement, setStatement] = useState("");
    const [requestError, setRequestError] = useState("");
    const submitting = useRef(false);
    const request = useRef<AbortController | undefined>(undefined);
    const details = useRef<HTMLDetailsElement>(null);
    // A different target owns different defaults; password and query drafts stay local.
    if (overrides.host !== host) setOverrides({ host });
    const account =
        overrides.host === host && overrides.account !== undefined
            ? overrides.account
            : status?.defaults.user || "";
    const database =
        overrides.host === host && overrides.database !== undefined
            ? overrides.database
            : status?.defaults.service || "";
    const disabled = runtime.disabled || submitting.current;
    const canRun =
        !disabled &&
        !!host &&
        !!account.trim() &&
        !!database.trim() &&
        !!statement.trim() &&
        Boolean(password) !== Boolean(unlock && status?.hasDefaultPassword);
    const detail = status?.host ? ` (${status.host}/${status.database})` : "";
    const message =
        requestError ||
        (submitting.current
            ? "Starting SQL…"
            : status?.preparing
              ? "Unlocking SQL credentials…"
              : status?.state && status.state !== "idle"
                ? {
                      running: "SQL is running…",
                      succeeded: "SQL completed.",
                      failed: "SQL failed. Review the output and retry.",
                  }[status.state] + detail
                : "");

    useEffect(
        () => () => {
            request.current?.abort();
            runtime.setPending("sql", false);
        },
        [runtime],
    );
    useEffect(() => {
        if (runtime.collapseVersion && details.current)
            details.current.open = false;
    }, [runtime.collapseVersion]);

    async function run() {
        if (submitting.current || !canRun || runtime.disabled) return;
        submitting.current = true;
        runtime.setActionError("");
        setRequestError("");
        runtime.setPending("sql", true);
        const controller = new AbortController();
        request.current = controller;
        try {
            const next = await runtime.api(
                "sql",
                {
                    config: runtime.configText,
                    account,
                    database,
                    ...(password ? { password } : { unlock }),
                    sql: statement,
                },
                undefined,
                controller.signal,
            );
            if (!controller.signal.aborted) runtime.accept(next);
        } catch (error) {
            if (!controller.signal.aborted)
                setRequestError(errorMessage(error));
        } finally {
            submitting.current = false;
            runtime.setPending("sql", false);
        }
    }

    return (
        <article>
            <details class="setup-section" id="sql-section" ref={details}>
                <summary>
                    <h2>SQL queries</h2>
                </summary>
                <div class="grid">
                    <div>
                        <label for="sql-account">User</label>
                        <input
                            id="sql-account"
                            autocomplete="off"
                            spellcheck={false}
                            disabled={disabled}
                            value={account}
                            onInput={(event) =>
                                setOverrides({
                                    ...overrides,
                                    host,
                                    account: event.currentTarget.value,
                                })
                            }
                        />
                    </div>
                    <div>
                        <label for="sql-database">Service Name</label>
                        <input
                            id="sql-database"
                            autocomplete="off"
                            spellcheck={false}
                            disabled={disabled}
                            value={database}
                            onInput={(event) =>
                                setOverrides({
                                    ...overrides,
                                    host,
                                    database: event.currentTarget.value,
                                })
                            }
                        />
                    </div>
                </div>
                <div class="grid">
                    <div>
                        <label for="sql-password">Password</label>
                        <input
                            id="sql-password"
                            type="password"
                            autocomplete="off"
                            disabled={disabled}
                            value={password}
                            onInput={(event) => {
                                const value = event.currentTarget.value;
                                setPassword(value);
                                if (value) setUnlock("");
                            }}
                        />
                    </div>
                    <div>
                        <label for="sql-unlock">Answer to password hint</label>
                        <input
                            id="sql-unlock"
                            type="password"
                            autocomplete="off"
                            aria-describedby="sql-password-hint sql-unlock-availability"
                            disabled={disabled || !status?.hasDefaultPassword}
                            value={unlock}
                            onInput={(event) => {
                                const value = event.currentTarget.value;
                                setUnlock(value);
                                if (value) setPassword("");
                            }}
                        />
                        <p
                            id="sql-password-hint"
                            hidden={!status?.passwordHint}
                        >
                            {status?.passwordHint}
                        </p>
                    </div>
                </div>
                <p>
                    Enter SQL password, or answer the hint to use the default
                    password. Entering one clears the other.
                </p>
                <p
                    id="sql-unlock-availability"
                    hidden={!!status?.hasDefaultPassword}
                >
                    No saved SQL password is available to unlock. Enter your SQL
                    password above.
                </p>
                <label for="sql-statement">SQL statement</label>
                <textarea
                    id="sql-statement"
                    rows={8}
                    spellcheck={false}
                    placeholder="SELECT * FROM your_table;"
                    disabled={disabled}
                    value={statement}
                    onInput={(event) => setStatement(event.currentTarget.value)}
                />
                <fieldset>
                    <button id="sql-run" disabled={!canRun} onClick={run}>
                        Run SQL
                    </button>
                </fieldset>
                <p id="sql-message" role="status">
                    {message}
                </p>
                <pre id="sql-output" tabindex={0} aria-label="SQL results">
                    {status?.output || ""}
                </pre>
            </details>
        </article>
    );
}

export const sql: SiteModule = {
    id: "sql",
    placement: "tool",
    Component: Sql,
    navigation: { target: "sql-section", label: "SQL" },
};
