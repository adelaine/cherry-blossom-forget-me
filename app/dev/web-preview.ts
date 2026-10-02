import { Hono } from "hono";
import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deploymentPage } from "../src/web-page.ts";

type RunState = "idle" | "running" | "succeeded" | "failed";

export function startWebPreview(
    options: { port?: number; delayMs?: number; quiet?: boolean } = {},
): Server {
    const require = createRequire(import.meta.url);
    const app = new Hono();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const state = {
        config: JSON.stringify(
            {
                suiteapps: [],
                vms: [{ account: "000071", url: "preview.netsuite.com" }],
            },
            null,
            4,
        ),
        error: "",
        credentialError: "",
        tokenPresent: false,
        relaunch: false,
        certificates: {
            public: "",
            private: "",
            id: "",
            canGenerate: false,
            hasExisting: false,
            canDownload: false,
            error: "",
        },
        run: { state: "idle" as RunState, log: "" },
        sql: {
            state: "idle" as RunState,
            output: "",
            host: "",
            database: "",
            defaults: { user: "PREVIEW_USER", service: "preview" },
            passwordHint: "",
            hasDefaultPassword: false,
            preparing: false,
        },
    };
    const busy = () =>
        state.run.state === "running" || state.sql.state === "running";
    const snapshot = () => ({ ...state, ready: !busy() });
    const later = (callback: () => void) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            callback();
        }, options.delayMs ?? 1500);
        timers.add(timer);
    };
    app.use("*", async (c, next) => {
        c.header("Cache-Control", "no-store");
        c.header("X-Content-Type-Options", "nosniff");
        c.header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
        const host = c.req.header("host") ?? "";
        if (
            !/^(?:localhost|127\.0\.0\.1):\d+$/.test(host) ||
            (c.req.method === "POST" &&
                c.req.header("origin") !== "http://" + host)
        ) {
            return c.json(
                { error: "Open the preview through its localhost address." },
                403,
            );
        }
        await next();
    });
    const html = deploymentPage.html.replace(
        /<p><small>The app stops automatically[\s\S]*?<\/p>/,
        '<p role="status"><strong>Local preview:</strong> SQL and deployments are simulated. Changes stay in memory. Stop with Ctrl+C or Stop app.</p>',
    );
    for (const [path, type, content] of [
        ["/", "text/html", html],
        ["/page.js", "text/javascript", deploymentPage.script],
        ["/page.css", "text/css", deploymentPage.style],
        [
            "/alpine.js",
            "text/javascript",
            readFileSync(
                require.resolve("@alpinejs/csp/dist/cdn.min.js"),
                "utf8",
            ),
        ],
        [
            "/pico.css",
            "text/css",
            readFileSync(
                require.resolve("@picocss/pico/css/pico.classless.zinc.min.css"),
                "utf8",
            ),
        ],
    ] as const)
        app.get(path, (c) => {
            c.header("Content-Type", type + "; charset=utf-8");
            return c.body(content);
        });
    app.get("/favicon.ico", (c) => c.body(null, 204));
    app.get("/health", (c) => c.json({ ready: true }));
    app.get("/api/state", (c) => c.json(snapshot()));
    app.get("/api/certificate", (c) =>
        c.json(
            { error: "Certificate downloads are unavailable in preview." },
            400,
        ),
    );
    app.post("/api/:action", async (c) => {
        const action = c.req.param("action");
        const input = await c.req.json<Record<string, unknown>>();
        if (!input || typeof input !== "object" || Array.isArray(input))
            throw new Error("Expected an object.");
        if (action === "heartbeat") return c.json({ alive: true });
        if (busy() && action !== "check")
            return c.json({ error: "A preview job is running." }, 409);
        if (input.config !== undefined) {
            if (typeof input.config !== "string")
                throw new Error("Enter configuration JSON.");
            const config: unknown = JSON.parse(input.config);
            if (!config || typeof config !== "object" || Array.isArray(config))
                throw new Error("Configuration must be a JSON object.");
        }
        switch (action) {
            case "check":
                return c.json({
                    ...snapshot(),
                    config: input.config ?? state.config,
                });
            case "settings":
                if (typeof input.config === "string")
                    state.config = input.config;
                return c.json(snapshot());
            case "credentials":
                if (typeof input.config === "string")
                    state.config = input.config;
                if (typeof input.token === "string" && input.token.trim())
                    state.tokenPresent = true;
                for (const key of ["public", "private", "id"] as const) {
                    if (typeof input[key] === "string")
                        state.certificates[key] = input[key];
                }
                return c.json(snapshot());
            case "deploy":
                if (typeof input.config === "string")
                    state.config = input.config;
                state.run = {
                    state: "running",
                    log: "Starting simulated deployment…\n",
                };
                later(() => {
                    state.run = {
                        state: "succeeded",
                        log: "Preview deployment completed. No files deployed.\n",
                    };
                });
                return c.json(snapshot(), 202);
            case "sql":
                state.sql.state = "running";
                state.sql.output = "";
                state.sql.host =
                    JSON.parse(
                        typeof input.config === "string"
                            ? input.config
                            : state.config,
                    ).vms?.[0]?.url ?? "";
                state.sql.database =
                    typeof input.database === "string"
                        ? input.database
                        : "preview";
                later(() => {
                    state.sql.state = "succeeded";
                    state.sql.output =
                        "PREVIEW_RESULT\n--------------\nSample row";
                });
                return c.json(snapshot(), 202);
            case "generate":
                return c.json(
                    {
                        error: "Certificate generation is unavailable in preview.",
                    },
                    400,
                );
            case "stop":
                setTimeout(() => server.close(), 100);
                return c.json({ stopped: true });
            default:
                return c.json({ error: "Unknown preview action." }, 404);
        }
    });
    app.onError((error, c) => c.json({ error: error.message }, 400));
    const server = createAdaptorServer({ fetch: app.fetch }) as Server;
    server.once("close", () => {
        for (const timer of timers) clearTimeout(timer);
    });
    server.on("error", (error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
    server.listen(options.port ?? 5173, "127.0.0.1", () => {
        const address = server.address();
        if (!options.quiet && address && typeof address !== "string")
            console.log(`Web preview: http://127.0.0.1:${address.port}`);
    });
    return server;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
    startWebPreview();
