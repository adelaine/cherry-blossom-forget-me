import { posix, win32 } from "node:path";

export type SshFile = { source: string; path: string };
export type SshSettings = {
    target: string;
    hostname: string;
    user: string;
    port: number;
    identities: SshFile[];
    knownHosts: SshFile[];
    certificates: SshFile[];
    hostKeyAlias?: string;
    strictHostKeyChecking?: "yes" | "no";
    error?: string;
};

// Parse OpenSSH's resolved output, not the user's configuration syntax.
export function hostSshSettings(hostRoot: string, platform: string): SshSettings {
    const target = process.env.SUITECONTAINER_SSH_TARGET || "";
    const settings: SshSettings = { target, hostname: target, user: "nsbuild", port: 22,
        identities: [], knownHosts: [], certificates: [] };
    const values = new Map<string, string[]>();
    for (const line of (process.env.SUITECONTAINER_SSH_RESOLVED || "").split(/\r?\n/)) {
        const match = /^(\S+)\s+(.+)$/.exec(line.trim());
        if (match) values.set(match[1]!.toLowerCase(), [...(values.get(match[1]!.toLowerCase()) || []), match[2]!]);
    }
    const first = (key: string) => values.get(key)?.[0];
    settings.hostname = first("hostname") || target;
    settings.user = first("user") || "nsbuild";
    settings.port = Number(first("port") || 22);
    settings.hostKeyAlias = first("hostkeyalias");
    settings.strictHostKeyChecking = ["no", "false"].includes(first("stricthostkeychecking") || "") ? "no" : "yes";
    if (!target || !values.size) settings.error = "SSH settings could not be detected. Check laptop SSH access and relaunch SuiteContainer.";
    else if (![target, settings.hostname].every(host => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host)) ||
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(settings.user) ||
        !Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
        settings.error = "The detected SSH host, user, or port is invalid.";
    if (["proxycommand", "proxyjump"].some(key => first(key) && first(key) !== "none"))
        settings.error = "Your SSH setup uses a jump host or proxy command. SFTP cannot use that setup inside SuiteContainer yet.";

    const paths = platform === "win32" ? win32 : posix;
    const home = process.env.SUITECONTAINER_SSH_HOME || "";
    const expand = (source: string) => {
        let value = source.replace(/^"(.*)"$/, "$1").replace(/^~(?=[/\\]|$)/, home)
            .replace(/__PROGRAMDATA__/g, process.env.SUITECONTAINER_SSH_PROGRAMDATA || "__PROGRAMDATA__")
            .replace(/%([%dhnrp])/g, (_, token: string) => ({ "%": "%", d: home, h: settings.hostname,
                n: target, r: settings.user, p: String(settings.port) })[token]!);
        if (/%[A-Za-z]|\$\{|^~|__PROGRAMDATA__/.test(value) || /[,\r\n\t\0]/.test(value)) {
            settings.error = "An SSH file path could not be resolved. Use a full path in your laptop SSH configuration and relaunch.";
            return undefined;
        }
        value = paths.resolve(hostRoot, value);
        return value;
    };
    const files = (sources: string[], kind: string): SshFile[] => [...new Set(sources)]
        .filter(source => source !== "none").flatMap(source => {
            const absolute = expand(source);
            return absolute ? [{ source: absolute, path: `/config/ssh/${kind}-${sources.indexOf(source)}` }] : [];
        });
    // ssh -G omits quotes around filenames with spaces. Absolute roots mark
    // each new trust-file path, preserving spaces within Windows/macOS homes.
    const words = (key: string) => (values.get(key) || []).flatMap(value =>
        /^(?:~[/\\]|\/|[A-Za-z]:[/\\]|__PROGRAMDATA__)/.test(value)
            ? value.split(/\s+(?=~[/\\]|\/|[A-Za-z]:[/\\]|__PROGRAMDATA__)/)
            : [...value.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]!));
    settings.identities = files(process.env.SUITECONTAINER_SSH_KEY ? [process.env.SUITECONTAINER_SSH_KEY] : values.get("identityfile") || [], "key");
    settings.knownHosts = files(process.env.SUITECONTAINER_SSH_KNOWN_HOSTS ? [process.env.SUITECONTAINER_SSH_KNOWN_HOSTS] :
        [...words("userknownhostsfile"), ...words("globalknownhostsfile")], "known-hosts");
    settings.certificates = files(values.get("certificatefile") || settings.identities.map(file => file.source + "-cert.pub"), "certificate");
    return settings;
}
