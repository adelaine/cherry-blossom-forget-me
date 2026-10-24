import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Auth } from "./step-auth.ts";
import { hostSshSettings, type SshSettings } from "./web-ssh.ts";

export type MountRecord = {
    hostRoot: string;
    platform: string;
    local: Record<string, string>;
    certificates: Record<string, string>;
    sftp?: string;
    ssh?: SshSettings;
};

export function webSshTarget(projectRoot: string): string {
    try {
        const target = JSON.parse(
            readFileSync(
                join(projectRoot, "suitecontainer.config.json"),
                "utf8",
            ),
        )?.vms?.[0]?.url;
        return typeof target === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(target)
            ? target
            : "";
    } catch {
        return "";
    }
}

export function hostPath(record: MountRecord, path: string): string {
    const paths = record.platform === "win32" ? win32 : posix;
    const resolved = paths.resolve(record.hostRoot, path);
    return record.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function credentialPath(
    record: MountRecord,
    path: string,
): string | null {
    const paths = record.platform === "win32" ? win32 : posix;
    const relative = paths.relative(
        paths.resolve(record.hostRoot, "credentials"),
        paths.resolve(record.hostRoot, path),
    );
    if (
        relative &&
        !relative.startsWith(`..${paths.sep}`) &&
        relative !== ".." &&
        !paths.isAbsolute(relative)
    ) {
        return posix.join("/config/credentials", ...relative.split(paths.sep));
    }
    return record.certificates[hostPath(record, path)] ?? null;
}

export function webPathRequests(
    projectRoot: string,
    hostRoot: string,
    platform: string,
): string[] {
    const paths = platform === "win32" ? win32 : posix;
    const result: string[] = [];
    const seen = new Set<string>();
    const add = (kind: string, name: string, source: string) => {
        const absolute = paths.resolve(hostRoot, source);
        if (/[,\r\n\t]/.test(absolute))
            throw new Error(
                "Mount paths cannot contain commas or line breaks.",
            );
        if (seen.has(`${kind}/${name}`)) return;
        seen.add(`${kind}/${name}`);
        result.push(`${kind}\t${name}\t${absolute}`);
    };
    const ssh = hostSshSettings(hostRoot, platform);
    for (const file of [
        ...ssh.identities,
        ...ssh.knownHosts,
        ...ssh.certificates,
    ])
        add("ssh", posix.basename(file.path), file.source);
    try {
        const config = JSON.parse(
            readFileSync(
                join(projectRoot, "suitecontainer.config.json"),
                "utf8",
            ),
        );
        for (const repo of Array.isArray(config?.suiteapps)
            ? config.suiteapps
            : []) {
            if (
                repo &&
                typeof repo.localPath === "string" &&
                repo.localPath &&
                typeof repo.directory === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.directory)
            )
                add("local", repo.directory, repo.localPath);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Mount paths"))
            throw error;
    }
    try {
        const auth = JSON.parse(
            readFileSync(join(projectRoot, "credentials/auth.json"), "utf8"),
        );
        add(
            "sftp",
            "files",
            typeof auth?.sftp?.path === "string" && auth.sftp.path.trim()
                ? auth.sftp.path
                : "sftp-files",
        );
        for (const key of ["public", "private"]) {
            const path = auth?.["suitecloud-certificates"]?.[key];
            if (typeof path === "string" && path.trim())
                add("external", key, path);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Mount paths"))
            throw error;
    }
    return result;
}

export function prepareWebMounts(
    projectRoot: string,
    hostRoot: string,
    platform: string,
): string[] {
    const paths = platform === "win32" ? win32 : posix;
    const record: MountRecord = {
        hostRoot,
        platform,
        local: {},
        certificates: {},
    };
    const mounts: string[] = [];
    const mount = (source: string, destination: string, readOnly = false) => {
        const absolute = paths.resolve(hostRoot, source);
        if (/[,\r\n]/.test(absolute))
            throw new Error(
                "Mount paths cannot contain commas or line breaks.",
            );
        mounts.push(
            `type=bind,src=${absolute},dst=${destination}${readOnly ? ",ro=true" : ""}`,
        );
    };
    mount("suitecontainer.config.json", "/config/suitecontainer.config.json");
    mount("credentials", "/config/credentials");
    mount("repos", "/workspace");
    const ssh = hostSshSettings(hostRoot, platform);
    const mountSshFiles = (files: SshSettings["identities"]) =>
        files.filter((file) => {
            const staged = `/ssh/${posix.basename(file.path)}`;
            if (!existsSync(staged) || !statSync(staged).isFile()) return false;
            mount(file.source, file.path, true);
            return true;
        });
    record.ssh = {
        ...ssh,
        identities: mountSshFiles(ssh.identities),
        knownHosts: mountSshFiles(ssh.knownHosts),
        certificates: mountSshFiles(ssh.certificates),
    };
    // Broken or incomplete settings must still reach the editor.
    let config: { suiteapps?: { directory?: string; localPath?: string }[] } =
        {};
    let auth: Auth = {};
    try {
        config = JSON.parse(
            readFileSync(
                join(projectRoot, "suitecontainer.config.json"),
                "utf8",
            ),
        );
    } catch {
        /* editor repairs it */
    }
    try {
        auth = JSON.parse(
            readFileSync(join(projectRoot, "credentials/auth.json"), "utf8"),
        );
    } catch {
        /* page explains it */
    }
    const sftpPath = auth.sftp?.path?.trim() || "sftp-files";
    // The launcher stages the selected directory before the app resolves mounts.
    if (
        sftpPath &&
        existsSync("/sftp/files") &&
        statSync("/sftp/files").isDirectory()
    ) {
        mount(sftpPath, "/srv/sftp/files", true);
        record.sftp = hostPath(record, sftpPath);
    }
    for (const repo of Array.isArray(config?.suiteapps)
        ? config.suiteapps
        : []) {
        if (
            !repo ||
            typeof repo.localPath !== "string" ||
            !repo.localPath ||
            typeof repo.directory !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.directory)
        )
            continue;
        if (Object.hasOwn(record.local, repo.directory)) continue;
        const source = `/local/${repo.directory}`;
        if (!existsSync(source) || !statSync(source).isDirectory()) continue;
        mount(repo.localPath, `/workspace/${repo.directory}`);
        record.local[repo.directory] = hostPath(record, repo.localPath);
    }
    for (const key of ["public", "private"] as const) {
        const path = auth?.["suitecloud-certificates"]?.[key];
        if (
            typeof path !== "string" ||
            !path.trim() ||
            credentialPath(record, path)
        )
            continue;
        // External files that exist are staged read-only by the launchers under /external.
        if (!existsSync(`/external/${key}.pem`)) continue;
        const destination = `/config/certs/${key}.pem`;
        mount(path, destination, true);
        record.certificates[hostPath(record, path)] = destination;
    }
    writeFileSync(
        join(projectRoot, "credentials/web-mounts.json"),
        JSON.stringify(record),
        { mode: 0o600 },
    );
    return mounts;
}
