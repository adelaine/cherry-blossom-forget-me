import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test(
    "copied runtime packages and compiled code run without the development dependencies",
    { timeout: 120_000 },
    async () => {
        const appDirectory = fileURLToPath(new URL("../../", import.meta.url));
        execFileSync(
            process.execPath,
            [join(appDirectory, "node_modules/vite/bin/vite.js"), "build", "--config", "site/vite.config.ts"],
            { cwd: appDirectory, encoding: "utf8", timeout: 90_000 },
        );
        execFileSync(
            process.execPath,
            [
                join(appDirectory, "../setup/node/copy-runtime.mjs"),
                appDirectory,
            ],
            {
                cwd: appDirectory,
                encoding: "utf8",
                timeout: 90_000,
            },
        );

        execFileSync(
            process.execPath,
            [
                join(appDirectory, "node_modules/typescript/bin/tsc"),
                "-p",
                "tsconfig.build.json",
            ],
            {
                cwd: appDirectory,
                encoding: "utf8",
                timeout: 90_000,
            },
        );

        const root = mkdtempSync(join(tmpdir(), "suitecontainer-standalone-"));
        try {
            const runtime = join(root, "runtime");
            cpSync(join(appDirectory, "dist"), runtime, { recursive: true });
            const configDirectory = join(root, "config");
            mkdirSync(join(configDirectory, "credentials"), {
                recursive: true,
            });
            const configPath = join(
                configDirectory,
                "suitecontainer.config.json",
            );
            writeFileSync(
                configPath,
                JSON.stringify({
                    suiteapps: [],
                    vms: [{ account: "000071", url: "" }],
                }),
            );
            writeFileSync(
                join(configDirectory, "credentials/auth.json"),
                JSON.stringify({
                    "gitlab-token": "",
                    "suitecloud-certificates": {
                        public: "",
                        private: "",
                        id: "",
                    },
                }),
            );
            writeFileSync(
                join(configDirectory, "credentials/web-mounts.json"),
                JSON.stringify({
                    hostRoot: "/project",
                    platform: "linux",
                    local: {},
                    certificates: {},
                }),
            );

            const environment = {
                ...process.env,
                NODE_PATH: "",
                NODE_OPTIONS: "",
                SUITECONTAINER_AUTH: join(
                    configDirectory,
                    "credentials/auth.json",
                ),
            };
            execFileSync(
                process.execPath,
                [join(runtime, "install.js"), "--validate", configPath],
                {
                    cwd: runtime,
                    env: environment,
                    encoding: "utf8",
                    timeout: 10_000,
                },
            );

            const probe = join(root, "probe.mjs");
            writeFileSync(
                probe,
                `
import assert from "node:assert/strict";
import { once } from "node:events";
const { startWebServer } = await import(${JSON.stringify(pathToFileURL(join(runtime, "web-server.js")).href)});
const server = startWebServer({ configDirectory: ${JSON.stringify(configDirectory)}, port: 0, host: "127.0.0.1", sessionFile: ${JSON.stringify(join(root, "session"))}, signalHandlers: false, onStop() {} });
try {
    await once(server, "listening");
    const health = await fetch("http://127.0.0.1:" + server.address().port + "/health");
    assert.deepEqual(await health.json(), { ready: true });
} finally {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
}
`,
            );
            execFileSync(process.execPath, [probe], {
                cwd: runtime,
                env: environment,
                encoding: "utf8",
                timeout: 15_000,
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
);
