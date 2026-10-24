import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deployRepos } from "../src/step-deploy.ts";
import { vms } from "./step-config.fixture.ts";

test("deploys each SuiteApp in order for each VM", (t) => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-deploy-test-"));
    const suiteapps = [
        { directory: "first", localPath: "local-first" },
        { directory: "second", localPath: "local-second" },
    ];
    const targets = [...vms, { account: "67890", url: "second.netsuite.com" }];
    const events: string[] = [];
    const domainsByAuthId = new Map<string, string>();
    let activeDomain = "";
    t.mock.method(console, "log", () => {});
    try {
        for (const repo of suiteapps) {
            const path = join(root, repo.directory);
            mkdirSync(path);
            writeFileSync(join(path, "manifest.xml"), "<manifest/>");
            writeFileSync(join(path, "deploy.xml"), "<deploy/>");
        }
        const spawn = ((
            command: string,
            args: string[],
            options: { cwd: string },
        ) => {
            if (args[0] === "account:manageauth")
                return { status: 1, stdout: "", stderr: "" };
            const app = basename(options.cwd);
            if (args[0] === "account:setup:ci") {
                if (args.includes("--domain")) {
                    activeDomain = args[args.indexOf("--domain") + 1];
                    domainsByAuthId.set(
                        args[args.indexOf("--authid") + 1],
                        activeDomain,
                    );
                } else {
                    activeDomain = domainsByAuthId.get(
                        args[args.indexOf("--select") + 1],
                    )!;
                }
                events.push(`${activeDomain}:${app}:auth`);
            } else {
                events.push(
                    `${activeDomain}:${app}:${args.includes("--dryrun") ? "dryrun" : "deploy"}`,
                );
            }
            return { status: 0, stdout: "", stderr: "" };
        }) as unknown as typeof import("node:child_process").spawnSync;
        deployRepos(
            {
                suiteapps,
                vms: targets,
                certificates: { public: "", private: "", id: "cert_1" },
            },
            "/private.pem",
            { workspaceRoot: root, spawn },
        );
        assert.deepEqual(
            events,
            targets.flatMap((vm) =>
                suiteapps.flatMap((repo) =>
                    ["auth", "dryrun", "deploy"].map(
                        (step) => `${vm.url}:${repo.directory}:${step}`,
                    ),
                ),
            ),
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
