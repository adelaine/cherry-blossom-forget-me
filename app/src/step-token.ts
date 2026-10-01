import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tokenPath = "/tmp/suitecloud-gitlab-token";
const nemsFiles = ["/config/.nems.env", "/config/config.toml"];

export function readToken(file: string): string {
    if (!existsSync(file)) return "";
    let contents: string;
    try {
        contents = readFileSync(file, "utf8");
    } catch {
        return "";
    }
    let section = "";
    for (const raw of contents.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const heading = line.match(/^\[([^\]]+)\]$/);
        if (heading) {
            section = heading[1].toLowerCase();
            continue;
        }
        const setting =
            (file.endsWith(".toml") &&
                line.match(
                    /(?:^|[{,]\s*)((?:nems_)?gitlab_(?:(?:personal|private|access|api)_)?token)\s*=\s*("[^"]*"|'[^']*')/i,
                )) ||
            line.match(
                /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*?)\s*$/,
            );
        if (!setting) continue;
        const key = setting[1].toLowerCase();
        const isGitlabToken =
            /^(?:nems_)?gitlab_(?:(?:personal|private|access|api)_)?token$/.test(
                key,
            ) ||
            key === "gitlab_pat" ||
            key === "gitlab.token" ||
            (section === "gitlab" &&
                [
                    "token",
                    "access_token",
                    "private_token",
                    "personal_access_token",
                    "pat",
                ].includes(key));
        if (!isGitlabToken) continue;
        let value = setting[2].trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, "");
        }
        if (value) return value;
    }
    return "";
}

function promptForToken(): string {
    const result = spawnSync(
        "bash",
        [
            "-c",
            'read -rsp "GitLab token: " token </dev/tty; printf "\\n" >/dev/tty; printf "%s" "$token"',
        ],
        { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
    );
    if (result.status !== 0)
        throw new Error("Could not read the GitLab token.");
    return result.stdout;
}

export function prepareToken(): void {
    const token = nemsFiles.map(readToken).find(Boolean) || promptForToken();
    if (!token) throw new Error("A GitLab token is required.");
    writeFileSync(tokenPath, token, { mode: 0o600 });
}

export function removeToken(): void {
    rmSync(tokenPath, { force: true });
}
