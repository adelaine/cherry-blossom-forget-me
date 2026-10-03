import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readAuth } from "./step-auth.ts";

const tunnelDirectory = "/tmp/suitecontainer-sftp-tunnels";

export function sftpTunnelActive(): boolean {
    if (process.env.SUITECONTAINER_SFTP !== "1") return false;
    try {
        return readdirSync(tunnelDirectory).some((name) => {
            try {
                return (
                    Date.now() -
                        statSync(`${tunnelDirectory}/${name}`).mtimeMs <
                    45_000
                );
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }
}

export function startSftpServer(): ChildProcess | undefined {
    if (process.env.SUITECONTAINER_SFTP !== "1") return undefined;
    try {
        if (!readAuth().sftp?.password) {
            console.warn(
                "SFTP is disabled. Set sftp.password in credentials/auth.json and restart SuiteContainer to enable it.",
            );
            return undefined;
        }
    } catch {
        console.warn(
            "SFTP is disabled. Check sftp settings in credentials/auth.json and restart SuiteContainer.",
        );
        return undefined;
    }
    return spawn("/bin/sh", ["/usr/local/bin/start-sftp"], {
        stdio: ["ignore", "inherit", "inherit"],
    });
}
