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
): void {
    const authenticating = args[0] === "account:setup:ci";
    const result = spawnSync("suitecloud", args, {
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

export function deployRepos(config: Config, privateKeyPath: string): void {
    const runbox = config.runbox!;
    const certificates = config.certificates!;
    const authId = `suitecontainer_${runbox.account}_${createHash("sha256").update(runbox.url).digest("hex").slice(0, 8)}`;
    const passkey = randomBytes(32).toString("hex");
    let authenticationReady = false;

    for (const repo of config.suiteapps) {
        const destination = join("/workspace", repo.directory);
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

    for (const repo of config.suiteapps) {
        const destination = join("/workspace", repo.directory);
        if (!authenticationReady) {
            const existing = spawnSync(
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
                runSuitecloud(
                    ["account:setup:ci", "--select", authId],
                    destination,
                    passkey,
                    false,
                    runbox.url,
                );
            } else {
                runSuitecloud(
                    [
                        "account:setup:ci",
                        "--account",
                        runbox.account,
                        "--authid",
                        authId,
                        "--certificateid",
                        certificates.id,
                        "--privatekeypath",
                        privateKeyPath,
                        "--domain",
                        runbox.url,
                    ],
                    destination,
                    passkey,
                    false,
                    runbox.url,
                );
            }
            authenticationReady = true;
        } else {
            runSuitecloud(
                ["account:setup:ci", "--select", authId],
                destination,
                passkey,
                false,
                runbox.url,
            );
        }
        console.log(`Checking ${repo.directory} against ${runbox.url}...`);
        runSuitecloud(
            ["project:deploy", "--dryrun"],
            destination,
            passkey,
            true,
        );
    }

    for (const repo of config.suiteapps) {
        const destination = join("/workspace", repo.directory);
        console.log(`Deploying ${repo.directory} to ${runbox.url}...`);
        runSuitecloud(["project:deploy"], destination, passkey, true);
    }
    console.log("All SuiteApps were deployed.");
}
