import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { readAuth } from "./step-auth.ts";

const projectRoot = resolve(
    process.env.SUITECONTAINER_INSTALL_ROOT ??
        resolve(
            dirname(fileURLToPath(import.meta.url)),
            import.meta.url.endsWith(".ts") ? "../../../.." : "../../../../..",
        ),
);
const homeRoot = resolve(
    process.env.SUITECONTAINER_HOST_ROOT ?? join(projectRoot, "home"),
);
const help = `Connect SuiteContainer's SFTP service to your deployment scrumbox over SSH.
Start SuiteContainer with the usual launcher first. From app/engine/: npm run sftp

Options:
  --scrumbox USER@HOST        Default: nsbuild@vms[0].url
  --remote-port PORT        Scrumbox port (default: 8000, for Banyan)
  --remote-bind ADDRESS     Scrumbox listener address (default: 127.0.0.1)
  --ssh-option KEY=VALUE    Repeatable ssh -o option
  --help                   Show this help

The files come from sftp-files beside repos; access is read-only.
Keep this terminal open. Ctrl+C closes the tunnel; SuiteContainer stays running.
SuiteScript connects to localhost:8000 after your canary restriction is disabled.
`;

export type SftpOptions = {
    scrumbox: string;
    remotePort: number;
    remoteBind: string;
    sshOptions: string[];
};

export function parseSftpOptions(args: string[]): SftpOptions | null {
    if (args.includes("--help")) return null;
    const options: SftpOptions = {
        scrumbox: "",
        remotePort:
            readAuth(join(homeRoot, "credentials/auth.json")).sftp?.port ??
            8000,
        remoteBind: "127.0.0.1",
        sshOptions: [],
    };
    for (let i = 0; i < args.length; i++) {
        const flag = args[i];
        if (
            ![
                "--scrumbox",
                "--remote-port",
                "--remote-bind",
                "--ssh-option",
            ].includes(flag)
        )
            throw new Error(`Unknown SFTP option: ${flag}. Use --help.`);
        const value = args[++i];
        if (!value || value.startsWith("--") || /[\r\n\0]/.test(value))
            throw new Error(`Supply a value for ${flag}.`);
        switch (flag) {
            case "--scrumbox":
                options.scrumbox = value;
                break;
            case "--remote-port":
                if (
                    !/^\d+$/.test(value) ||
                    Number(value) < 1024 ||
                    Number(value) > 65535
                )
                    throw new Error(
                        "The remote SFTP port must be between 1024 and 65535.",
                    );
                options.remotePort = Number(value);
                break;
            case "--remote-bind":
                if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(value))
                    throw new Error(
                        "Use an IPv4 address or hostname for --remote-bind.",
                    );
                options.remoteBind = value;
                break;
            case "--ssh-option":
                if (!/^[A-Za-z][A-Za-z0-9]*=.+$/.test(value))
                    throw new Error("Use KEY=VALUE for --ssh-option.");
                options.sshOptions.push(value);
                break;
        }
    }
    if (!options.scrumbox) {
        const config = JSON.parse(
            readFileSync(join(homeRoot, "suitecontainer.config.json"), "utf8"),
        );
        const host = config?.vms?.[0]?.url;
        if (typeof host !== "string" || !host)
            throw new Error(
                "Set vms[0].url or supply --scrumbox nsbuild@HOST.",
            );
        options.scrumbox = `nsbuild@${host}`;
    }
    if (
        !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(
            options.scrumbox,
        )
    )
        throw new Error(
            "Use USER@HOST or an SSH configuration alias for --scrumbox.",
        );
    return options;
}

function command(executable: string, args: string[]): string {
    const result = spawnSync(executable, args, {
        encoding: "utf8",
        timeout: 15_000,
    });
    if (result.error)
        throw new Error(`Cannot run ${executable}: ${result.error.message}`);
    if (result.status !== 0)
        throw new Error(
            `${executable} failed (${result.status ?? result.signal}). ${result.stderr.trim()}`,
        );
    return result.stdout.trim();
}

function podmanExecutable(): string {
    if (process.platform === "win32") {
        for (const candidate of [
            join(process.env.LOCALAPPDATA ?? "", "Programs/Podman/podman.exe"),
            join(process.env.ProgramFiles ?? "", "Podman/podman.exe"),
        ])
            if (existsSync(candidate)) return candidate;
    }
    return "podman";
}

export function sftpTunnelArgs(
    options: SftpOptions,
    localPort: number,
): string[] {
    return [
        "-N",
        "-T",
        ...options.sshOptions.flatMap((value) => ["-o", value]),
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-R",
        `${options.remoteBind}:${options.remotePort}:127.0.0.1:${localPort}`,
        "--",
        options.scrumbox,
    ];
}

export async function serveSftp(options: SftpOptions): Promise<number> {
    const podman = podmanExecutable();
    const containers = JSON.parse(
        command(podman, ["ps", "--format", "json"]),
    ) as { Id: string; Labels?: Record<string, string> }[];
    const normalize = (path: string) =>
        process.platform === "win32" ? path.toLowerCase() : path;
    const matches = containers.filter(
        (container) =>
            normalize(container.Labels?.["suitecontainer.project"] ?? "") ===
            normalize(projectRoot),
    );
    if (matches.length !== 1)
        throw new Error(
            "Start this project's SuiteContainer with the usual launcher first.",
        );
    const container = matches[0].Id;
    const address = command(podman, ["port", container, "8000/tcp"]).split(
        /\r?\n/,
    )[0];
    const localPort = Number(address.split(":").at(-1));
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
        throw new Error("Relaunch SuiteContainer to enable its SFTP port.");
    command(podman, [
        "exec",
        container,
        "/usr/sbin/sshd",
        "-t",
        "-f",
        "/run/sftp/sshd_config",
    ]);
    const hostKey = command(podman, [
        "exec",
        container,
        "cat",
        "/config/credentials/sftp/host-keys/ssh_host_rsa_key.pub",
    ]).split(/\s+/)[1];
    const url = options.scrumbox.split("@").at(-1)!;
    const connection = {
        username:
            readAuth(join(homeRoot, "credentials/auth.json")).sftp?.username ??
            "suitecontainer",
        url:
            options.remoteBind === "127.0.0.1" ||
            options.remoteBind === "localhost"
                ? "127.0.0.1"
                : url,
        port: options.remotePort,
        directory: "/files",
        hostKeyType: "rsa",
        hostKey,
    };
    const settings = join(homeRoot, "credentials/sftp/connection.json");
    writeFileSync(settings, JSON.stringify(connection, null, 4) + "\n", {
        mode: 0o600,
    });
    console.log(
        `SFTP username: ${connection.username}. Password: sftp.password in credentials/auth.json. No client key upload is needed.`,
    );
    console.log(
        `N/sftp connection settings: ${settings}. Shared folder: ${join(homeRoot, "sftp-files")} (read-only).`,
    );
    console.log(
        `Opening SSH tunnel to ${options.scrumbox}, port ${options.remotePort}. Keep this terminal open.`,
    );
    if (
        options.remoteBind !== "127.0.0.1" &&
        options.remoteBind !== "localhost"
    )
        console.log(
            "VM-name access requires GatewayPorts clientspecified or yes on the scrumbox and Banyan access to this port.",
        );
    const marker = `/tmp/suitecontainer-sftp-tunnels/${randomUUID()}`;
    const touch = () => command(podman, ["exec", container, "touch", marker]);
    touch();
    const tunnel = spawn("ssh", sftpTunnelArgs(options, localPort), {
        stdio: "inherit",
    });
    let stopped = false;
    const stop = () => {
        stopped = true;
        tunnel.kill();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    // The existing app's inactivity timeout must not interrupt an SFTP tunnel.
    const heartbeat = setInterval(() => {
        try {
            touch();
        } catch (error) {
            console.error(String(error));
            tunnel.kill();
        }
    }, 15_000);
    try {
        return await new Promise<number>((resolveExit, reject) => {
            tunnel.once("error", reject);
            tunnel.once("exit", (code, signal) =>
                resolveExit(stopped ? 130 : (code ?? (signal ? 1 : 0))),
            );
        });
    } finally {
        clearInterval(heartbeat);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        tunnel.kill();
        try {
            command(podman, ["exec", container, "rm", "-f", marker]);
        } catch {
            /* app may already have stopped */
        }
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        const options = parseSftpOptions(process.argv.slice(2));
        if (options) process.exitCode = await serveSftp(options);
        else console.log(help);
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
