import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "./step-config.ts";
import { authenticationError } from "./step-suitecloud-errors.ts";

function suitecloudEnv(passkey: string, deploying = false): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        SUITECLOUD_CI_PASSKEY: passkey,
    };
    delete env.SUITECLOUD_FALLBACK_PASSKEY;
    if (deploying) env.SUITECLOUD_CI = "1";
    else delete env.SUITECLOUD_CI;
    return env;
}

function runSuitecloud(
    args: string[],
    cwd: string,
    passkey: string,
    deploying = false,
    domain = "",
    spawn: typeof spawnSync = spawnSync,
): void {
    const authenticating = args[0] === "account:setup:ci";
    const result = spawn("suitecloud", args, {
        cwd,
        stdio: authenticating ? ["inherit", "pipe", "pipe"] : "inherit",
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: suitecloudEnv(passkey, deploying),
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        if (authenticating) {
            throw new Error(
                authenticationError(
                    [result.stdout, result.stderr].filter(Boolean).join("\n"),
                    basename(cwd),
                    domain,
                ),
            );
        }
        throw new Error(`SuiteCloud ${args[0]} failed in ${cwd}.`);
    }
    if (authenticating) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
    }
}

export function deployRepos(
    config: Config,
    privateKeyPath: string,
    options: { workspaceRoot?: string; spawn?: typeof spawnSync } = {},
): void {
    const certificates = config.certificates!;
    const passkey = process.env.SUITECONTAINER_DEPLOY_PASSKEY || randomBytes(32).toString("hex");
    const workspaceRoot = options.workspaceRoot ?? "/workspace";
    const spawn = options.spawn ?? spawnSync;
    const runCommand = (
        args: string[],
        cwd: string,
        deploying = false,
        domain = "",
    ) => runSuitecloud(args, cwd, passkey, deploying, domain, spawn);

    for (const repo of config.suiteapps) {
        const destination = join(workspaceRoot, repo.directory);
        if (
            !existsSync(join(destination, "manifest.xml")) ||
            !existsSync(join(destination, "deploy.xml"))
        ) {
            throw new Error(
                `${repo.directory} needs manifest.xml and deploy.xml before deployment.`,
            );
        }
        const cliConfig = join(destination, "suitecloud.config.js");
        if (!existsSync(cliConfig)) {
            writeFileSync(
                cliConfig,
                "module.exports = { defaultProjectFolder: '.', commands: {} };\n",
            );
        }
    }

    for (const vm of config.vms) {
        const authId = `suitecontainer_${vm.account}_${createHash("sha256").update(vm.url).digest("hex").slice(0, 8)}`;
        let authenticationReady = false;
        for (const repo of config.suiteapps) {
            const destination = join(workspaceRoot, repo.directory);
            if (!authenticationReady) {
                const existing = spawn(
                    "suitecloud",
                    ["account:manageauth", "--info", authId],
                    {
                        cwd: destination,
                        stdio: "ignore",
                        env: suitecloudEnv(passkey),
                    },
                );
                if (existing.error) throw existing.error;
                if (existing.status === 0) {
                    runCommand(
                        ["account:setup:ci", "--select", authId],
                        destination,
                        false,
                        vm.url,
                    );
                } else {
                    runCommand(
                        [
                            "account:setup:ci",
                            "--account",
                            vm.account,
                            "--authid",
                            authId,
                            "--certificateid",
                            certificates.id,
                            "--privatekeypath",
                            privateKeyPath,
                            "--domain",
                            vm.url,
                        ],
                        destination,
                        false,
                        vm.url,
                    );
                }
                authenticationReady = true;
            } else {
                runCommand(
                    ["account:setup:ci", "--select", authId],
                    destination,
                    false,
                    vm.url,
                );
            }
            console.log(`Checking ${repo.directory} against ${vm.url}...`);
            runCommand(["project:deploy", "--dryrun"], destination, true);
            console.log(`Deploying ${repo.directory} to ${vm.url}...`);
            runCommand(["project:deploy"], destination, true);
        }
    }
    console.log("All SuiteApps were deployed.");
}
