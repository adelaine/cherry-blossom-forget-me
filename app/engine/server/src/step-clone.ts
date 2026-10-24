import { spawnSync } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { gitlabHttpsUrl, type SuiteApp } from "./step-config.ts";

export function run(command: string, args: string[]): void {
    const result = spawnSync(command, args, {
        stdio: "inherit",
        env: {
            ...process.env,
            GIT_ASKPASS: "/usr/local/bin/gitlab-askpass.sh",
            GIT_TERMINAL_PROMPT: "0",
        },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed.`);
}

export function hasLocalCheckout(directory: string): boolean {
    const destination = join("/workspace", directory);
    return (
        existsSync(destination) &&
        statSync(destination).isDirectory() &&
        existsSync(join(destination, ".git"))
    );
}

export function cloneRepos(repos: SuiteApp[], pmMode = false): void {
    for (const repo of repos) {
        if (repo.localPath || pmMode) {
            if (!hasLocalCheckout(repo.directory)) {
                if (!repo.localPath)
                    throw new Error(
                        `Place a local checkout in repos/${repo.directory} or set its localPath before continuing.`,
                    );
                throw new Error(
                    `SuiteApp ${repo.directory} localPath is not a Git checkout: ${repo.localPath}`,
                );
            }
            console.log(`Using local checkout: ${repo.directory}`);
            continue;
        }
        const destination = join("/workspace", repo.directory);
        const cloneUrl = gitlabHttpsUrl(repo.url)!;
        if (existsSync(join(destination, ".git"))) {
            const remote = spawnSync(
                "git",
                ["-C", destination, "remote", "get-url", "origin"],
                { encoding: "utf8" },
            );
            if (
                remote.status !== 0 ||
                gitlabHttpsUrl(remote.stdout.trim()) !== cloneUrl
            ) {
                throw new Error(
                    `${repo.directory} already contains a different SuiteApp.`,
                );
            }
            if (repo.branch) {
                run("git", ["-C", destination, "fetch", "origin"]);
                run("git", ["-C", destination, "checkout", repo.branch]);
                run("git", [
                    "-C",
                    destination,
                    "pull",
                    "--ff-only",
                    "origin",
                    repo.branch,
                ]);
            }
            console.log(`Already copied: ${repo.directory}`);
        } else if (existsSync(destination)) {
            throw new Error(
                `${repo.directory} already exists but is not a Git checkout.`,
            );
        } else {
            console.log(`Copying ${repo.directory}...`);
            try {
                run("git", [
                    "clone",
                    ...(repo.branch ? ["--branch", repo.branch] : []),
                    cloneUrl,
                    destination,
                ]);
                if (repo.branch)
                    run("git", [
                        "-C",
                        destination,
                        "symbolic-ref",
                        "--quiet",
                        "--short",
                        "HEAD",
                    ]);
            } catch (error) {
                rmSync(destination, { recursive: true, force: true });
                throw error;
            }
        }
    }
}
