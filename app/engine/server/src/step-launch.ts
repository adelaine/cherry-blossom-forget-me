import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    renameSync,
} from "node:fs";
import { join, posix, win32 } from "node:path";
import type { Config } from "./step-config.ts";

export const prepareConfiguration = (
    projectRoot: string,
    templatesDirectory = "/config-example",
): boolean => {
    const directory = join(projectRoot, "config");
    mkdirSync(directory, { recursive: true });
    const config = join(directory, "suitecontainer.json");
    const legacy = join(projectRoot, "suitecontainer.config.json");
    const credentials = join(projectRoot, "credentials");
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    const auth = join(credentials, "auth.json");
    if (!existsSync(auth)) {
        copyFileSync(join(templatesDirectory, "auth.example.json"), auth);
        chmodSync(auth, 0o600);
        console.log(
            "Created credentials/auth.json. Set gitlab-token there; supply certificate paths or leave both empty to generate them.",
        );
    }
    if (existsSync(config)) return false;
    if (existsSync(legacy)) {
        renameSync(legacy, config);
        return false;
    }
    copyFileSync(
        join(templatesDirectory, "suitecontainer.example.json"),
        config,
    );
    console.log(
        "Created config/suitecontainer.json from the template. Add your SuiteApps and VMs, then run the start script again.",
    );
    return true;
};

export const launchMounts = (
    config: Config,
    hostRoot: string,
    platform: string,
): string[] => {
    const paths = platform === "win32" ? win32 : posix;
    const hostPath = (path: string) => paths.resolve(hostRoot, path);
    const mount = (source: string, destination: string, readOnly = false) =>
        `type=bind,src=${hostPath(source)},dst=${destination}${readOnly ? ",ro=true" : ""}`;
    return [
        mount("config/suitecontainer.json", "/config/suitecontainer.json"),
        mount("credentials/auth.json", "/config/credentials/auth.json", true),
        mount("repos", "/workspace"),
        mount(config.certificates!.public, "/config/certs/public.pem", true),
        mount(config.certificates!.private, "/config/certs/private.pem", true),
        ...config.suiteapps
            .filter((repo) => repo.localPath)
            .map((repo) =>
                mount(repo.localPath!, `/workspace/${repo.directory}`),
            ),
    ];
};
