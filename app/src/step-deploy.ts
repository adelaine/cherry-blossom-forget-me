import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./step-config.js";

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
): void {
    const result = spawnSync("suitecloud", args, {
        cwd,
        stdio: "inherit",
        env: suitecloudEnv(passkey, deploying),
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
        throw new Error(`SuiteCloud ${args[0]} failed in ${cwd}.`);
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
                );
            }
            authenticationReady = true;
        } else {
            runSuitecloud(
                ["account:setup:ci", "--select", authId],
                destination,
                passkey,
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
