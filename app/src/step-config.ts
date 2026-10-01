import { readFileSync } from "node:fs";

export type SuiteApp = { url: string; directory: string; branch?: string };
export type Config = {
    suiteapps: SuiteApp[];
    certificates?: { public: string; private: string; id: string };
    runbox?: { account: string; url: string };
};

function invalidConfig(message: string): never {
    throw new Error(
        `${message} Update suiteapps-to-install.json and run the start script again.`,
    );
}

export function gitlabHttpsUrl(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    let projectPath: string;
    const ssh = raw.match(
        /^git@gitlab\.eng\.netsuite\.com:([A-Za-z0-9._/-]+)$/i,
    );
    if (ssh) {
        projectPath = ssh[1];
    } else {
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            return null;
        }
        if (
            parsed.protocol !== "https:" ||
            parsed.hostname !== "gitlab.eng.netsuite.com" ||
            parsed.port ||
            parsed.username ||
            parsed.password ||
            parsed.search ||
            parsed.hash
        )
            return null;
        projectPath = parsed.pathname.slice(1);
    }
    projectPath = projectPath.replace(/\.git$/i, "");
    if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(projectPath))
        return null;
    return `https://gitlab.eng.netsuite.com/${projectPath}.git`;
}

export function validBranch(branch: unknown): boolean {
    return (
        typeof branch === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
        !branch.includes("..") &&
        !branch.includes("//") &&
        !branch
            .split("/")
            .some(
                (part) =>
                    part.startsWith(".") ||
                    part.endsWith(".") ||
                    part.endsWith(".lock"),
            )
    );
}

export function validateConfig(
    value: unknown,
    requireDeploymentSettings = false,
): Config {
    if (
        !value ||
        typeof value !== "object" ||
        !Array.isArray((value as Config).suiteapps)
    ) {
        invalidConfig('The file needs a "suiteapps" list.');
    }
    const config = value as Config;
    if (requireDeploymentSettings) {
        const certs = config.certificates;
        const runbox = config.runbox;
        if (
            !certs ||
            !(["public", "private"] as const).every(
                (key) =>
                    typeof certs[key] === "string" &&
                    certs[key].trim() &&
                    !/[\r\n]/.test(certs[key]),
            )
        ) {
            invalidConfig(
                'The "certificates" section needs public and private file paths.',
            );
        }
        if (!/^[A-Za-z0-9_-]+$/.test(certs.id || "")) {
            invalidConfig(
                'The "certificates" section needs the NetSuite certificate ID.',
            );
        }
        if (
            !runbox ||
            typeof runbox.account !== "string" ||
            !/^[A-Za-z0-9_-]+$/.test(runbox.account) ||
            typeof runbox.url !== "string" ||
            !/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(runbox.url) ||
            !runbox.url.endsWith(".netsuite.com")
        ) {
            invalidConfig(
                'The "runbox" section needs an account ID and a NetSuite domain.',
            );
        }
    }

    const seen = new Set<string>();
    for (const [index, repo] of config.suiteapps.entries()) {
        if (
            !repo ||
            typeof repo !== "object" ||
            Array.isArray(repo) ||
            !gitlabHttpsUrl(repo.url)
        ) {
            invalidConfig(
                `SuiteApp ${index + 1} needs a GitLab HTTPS or SSH URL from gitlab.eng.netsuite.com.`,
            );
        }
        if (
            typeof repo.directory !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.directory) ||
            [".", ".."].includes(repo.directory) ||
            seen.has(repo.directory.toLowerCase())
        ) {
            invalidConfig(
                `SuiteApp ${index + 1} needs a unique "directory" name without spaces or slashes.`,
            );
        }
        if (repo.branch !== undefined && !validBranch(repo.branch)) {
            invalidConfig(
                `SuiteApp ${index + 1} has an invalid "branch" name.`,
            );
        }
        seen.add(repo.directory.toLowerCase());
    }
    return config;
}

export function readConfig(
    path: string,
    requireDeploymentSettings = false,
): Config {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        invalidConfig("The JSON file could not be read or has a syntax error.");
    }
    return validateConfig(value, requireDeploymentSettings);
}
