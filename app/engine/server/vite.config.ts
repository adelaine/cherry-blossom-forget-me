import { defineConfig, type ViteDevServer } from "vite";
import devServer from "@hono/vite-dev-server";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Lifecycle = ReturnType<
    (typeof import("./src/main.ts"))["createServerLifecycle"]
>;
type ServiceDefinitions = Awaited<
    ReturnType<Parameters<Lifecycle["restartServices"]>[0]>
>;
const serverDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = resolve(serverDirectory, "..");
const entry = resolve(serverDirectory, "src/main.ts");
const serviceEntry = resolve(serverDirectory, "src/services/system.ts");
const ignored = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/.git/**",
    "**/.cache/**",
    "**/credentials/**",
    "**/repos/**",
    "**/test/**",
    "**/*.log",
];

export default defineConfig(() => {
    let lifecycle: Lifecycle | undefined;
    let creating: Promise<Lifecycle> | undefined;
    let pendingServices = false;
    let pendingLaunch = false;
    let replacing = false;

    const getLifecycle = (server: ViteDevServer): Promise<Lifecycle> => {
        if (lifecycle) return Promise.resolve(lifecycle);
        return (creating ??= (async () => {
            const module = await server.ssrLoadModule(entry);
            lifecycle = module.createServerLifecycle({
                mode: "development",
                onStop: () => {
                    setImmediate(() => {
                        void server.close();
                    });
                },
            }) as Lifecycle;
            return lifecycle;
        })());
    };
    const requiresServices = (file: string) => {
        const path = file.replaceAll("\\", "/");
        const source = serverDirectory.replaceAll("\\", "/") + "/src/";
        return (
            path.startsWith(source) &&
            !path.includes("/api/") &&
            !/\/(?:main|install|step-deploy|step-token)\.ts$|\/services\/operations\.ts$/.test(
                path,
            )
        );
    };

    return {
        root: serverDirectory,
        publicDir: false,
        cacheDir: resolve(appDirectory, "node_modules/.vite"),
        clearScreen: false,
        server: {
            host: "0.0.0.0",
            port: 8080,
            strictPort: true,
            cors: false,
            // The client derives the published host port from its own import URL.
            // HTTP and updates share the single Podman-published listener.
            hmr: { protocol: "ws" },
            fs: {
                strict: true,
                allow: [appDirectory],
                deny: [
                    "**/.env",
                    "**/.env.*",
                    "**/.npmrc",
                    "**/*.{pem,key,p12,pfx,crt}",
                    "**/credentials/**",
                    "**/.cache/**",
                    "**/repos/**",
                    "**/.git/**",
                    "**/test/**",
                    "**/*.log",
                    ...[
                        appDirectory,
                        serverDirectory,
                        resolve(appDirectory, "client"),
                    ].flatMap((directory) => [
                        resolve(directory, "dist/**"),
                        resolve(directory, "build/**"),
                    ]),
                ],
            },
            watch: {
                ignored,
                usePolling: process.env.SUITECONTAINER_WATCH_POLLING === "1",
                interval: Math.max(
                    100,
                    Number(process.env.SUITECONTAINER_WATCH_INTERVAL_MS) || 250,
                ),
            },
        },
        plugins: [
            {
                name: "suitecontainer-lifecycle",
                enforce: "pre",
                async configureServer(server) {
                    const owner = await getLifecycle(server);
                    server.watcher.add([
                        resolve(serverDirectory, "src"),
                        resolve(appDirectory, "client/src"),
                        resolve(appDirectory, "package.json"),
                        resolve(appDirectory, "package-lock.json"),
                    ]);
                    // Vite configuration reloads must not recreate backend owners.
                    // They require the same explicit launcher path as process restarts.
                    server.restart = async () => {
                        pendingLaunch = true;
                        owner.setRestartPending(
                            "Development server configuration changed. Run the launcher again while idle.",
                        );
                    };
                    server.middlewares.use((request, response, next) => {
                        const host = request.headers.host ?? "";
                        const allowedHost =
                            /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(
                                host,
                            );
                        let allowedOrigin = !request.headers.origin;
                        try {
                            if (request.headers.origin)
                                allowedOrigin =
                                    new URL(request.headers.origin).origin ===
                                    `http://${host}`;
                        } catch {
                            /* rejected below */
                        }
                        // The runner's authenticated health probe can use the
                        // container-network hostname; Hono validates that token.
                        const health = request.url?.split("?")[0] === "/health";
                        if ((!allowedHost || !allowedOrigin) && !health) {
                            response.statusCode = 403;
                            response.setHeader(
                                "Content-Type",
                                "application/json",
                            );
                            response.end(
                                JSON.stringify({
                                    error: "Use the published loopback origin.",
                                    code: "origin_forbidden",
                                    retryable: false,
                                    details: {},
                                }),
                            );
                            return;
                        }
                        next();
                    });
                    server.httpServer?.prependListener("upgrade", (request) => {
                        const origin = request.headers.origin;
                        if (
                            origin &&
                            origin !== `http://${request.headers.host}`
                        )
                            request.socket.destroy();
                    });
                    const refresh = setInterval(() => {
                        if (
                            !pendingServices ||
                            pendingLaunch ||
                            replacing ||
                            owner.busy() ||
                            owner.managedActive()
                        )
                            return;
                        replacing = true;
                        void owner
                            .restartServices(async () => {
                                // Refresh the complete service graph, including legacy tool
                                // integrations. Old process instances remain alive until idle.
                                for (const module of server.moduleGraph.idToModuleMap.values()) {
                                    if (
                                        module.file &&
                                        requiresServices(module.file)
                                    )
                                        server.moduleGraph.invalidateModule(
                                            module,
                                        );
                                }
                                return (await server.ssrLoadModule(
                                    serviceEntry,
                                )) as ServiceDefinitions;
                            })
                            .then((replaced) => {
                                if (replaced) pendingServices = false;
                            })
                            .catch(() => {
                                owner.setRestartPending(
                                    "Service reload failed. Correct the source or run the launcher again while idle.",
                                );
                            })
                            .finally(() => {
                                replacing = false;
                            });
                    }, 250);
                    refresh.unref();
                    const terminate = () => {
                        void server.close();
                    };
                    process.on("SIGINT", terminate);
                    process.on("SIGTERM", terminate);
                    server.httpServer?.once("listening", () => {
                        writeFileSync(
                            process.env.SUITECONTAINER_SESSION_FILE ??
                                "/tmp/suitecontainer-web-url",
                            `/#session=${owner.session}`,
                            { mode: 0o600 },
                        );
                    });
                    server.httpServer?.once("close", () => {
                        clearInterval(refresh);
                        process.off("SIGINT", terminate);
                        process.off("SIGTERM", terminate);
                        void owner.dispose();
                    });
                },
            },
            devServer({
                entry,
                injectClientScript: false,
                // Keep existing application JS/CSS routes in Hono. Only Vite's
                // own modules and explicitly requested source use its file server.
                exclude: [
                    /^\/@(?:vite|id|fs)\//,
                    /^\/node_modules\//,
                    /^\/(?:src|server\/src|client\/src)\//,
                ],
                ignoreWatching: ignored,
                async loadModule(server, path) {
                    const owner = await getLifecycle(server);
                    const module = await server.ssrLoadModule(path);
                    return module.createApplication(owner);
                },
                env: () => ({ lifecycle }),
                handleHotUpdate({ file, server }) {
                    if (!lifecycle) return [];
                    const path = file.replaceAll("\\", "/");
                    if (
                        file === entry ||
                        path.endsWith("/services/operations.ts")
                    ) {
                        pendingLaunch = true;
                        lifecycle.setRestartPending(
                            "Backend lifecycle or operation coordinator code changed. Run the launcher again while idle to restart this instance.",
                        );
                    } else if (
                        /\/(?:package(?:-lock)?\.json|vite\.config\.ts)$/.test(
                            path,
                        )
                    ) {
                        pendingLaunch = true;
                        lifecycle.setRestartPending(
                            "Dependencies or development configuration changed. Run the launcher again while idle to refresh them.",
                        );
                    } else if (requiresServices(file)) {
                        pendingServices = true;
                        lifecycle.setRestartPending(
                            lifecycle.managedActive()
                                ? "Service changes are pending. Stop managed SFTP to allow the idle service restart."
                                : "Service changes are pending until active operations finish.",
                        );
                    }
                    server.ws.send({ type: "full-reload" });
                    return [];
                },
            }),
        ],
    };
});
