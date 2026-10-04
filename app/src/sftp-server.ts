import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Auth } from "./step-auth.ts";
import { hostPath, type MountRecord } from "./web-mounts.ts";

type ServiceState = "stopped" | "starting" | "running" | "failed";
const agentSocket = "/run/sftp/tunnel-agent.sock";

export class SftpService {
    private child?: ChildProcess;
    private agent?: ChildProcess;
    private tunnel?: ChildProcess;
    private state: ServiceState = "stopped";
    private error = "";
    private tunnelState: ServiceState = "stopped";
    private generation = 0;
    constructor(private credentials: string, private record: MountRecord, private enabled = process.env.SUITECONTAINER_SFTP === "1") {}
    get active(): boolean { return this.state === "starting" || this.state === "running"; }
    dispose(): void { this.stop(); }
    status(auth: Auth) {
        const settings = auth.sftp ?? { username: "suitecontainer", port: 8000, password: "" };
        const path = settings.path || "";
        let hostKey = "";
        try { hostKey = readFileSync(join(this.credentials, "sftp/host-keys/ssh_host_rsa_key.pub"), "utf8").trim().split(/\s+/)[1] || ""; } catch { /* generated on first start */ }
        return { state: this.state, username: settings.username, port: settings.port, path,
            passwordPresent: !!settings.password, hostKey, error: this.error,
            relaunch: this.record.sftp !== hostPath(this.record, path.trim() || "sftp-files"),
            tunnel: { state: this.tunnelState, error: this.tunnelState === "failed" ? this.error : "" } };
    }
    private fail(message: string): void {
        this.stop(); this.state = "failed"; this.tunnelState = "failed"; this.error = message;
    }
    async start(auth: Auth, scrumboxHost: string): Promise<void> {
        if (!this.enabled) throw new Error("Relaunch SuiteContainer with the platform launcher to enable SFTP controls.");
        if (this.active) throw new Error("SFTP is already running or starting.");
        if (!auth.sftp?.password) throw new Error("Enter an SFTP password before starting.");
        if (this.status(auth).relaunch) throw new Error("Folder saved. Stop the app and relaunch to mount this local folder before starting SFTP.");
        if (!existsSync("/srv/sftp/files")) throw new Error("The local folder is unavailable. Check its path and relaunch.");
        const ssh = this.record.ssh;
        if (!ssh || ssh.target !== scrumboxHost) throw new Error("Relaunch SuiteContainer to detect SSH settings for the current host scrumbox.");
        if (ssh.error) throw new Error(ssh.error);
        if (!ssh.identities.length || !ssh.identities.some(file => existsSync(file.path)))
            throw new Error("No SSH private key was found for this host scrumbox. Check laptop SSH access and relaunch SuiteContainer.");
        if (!ssh.knownHosts.length || !ssh.knownHosts.every(file => existsSync(file.path)))
            throw new Error("No SSH trust file was found for this host scrumbox. Connect to it from your laptop, verify its host key, then relaunch SuiteContainer.");
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(scrumboxHost)) throw new Error("Set Current VM before starting the SFTP tunnel.");
        const generation = ++this.generation;
        this.state = "starting"; this.tunnelState = "starting"; this.error = "";
        const ensureCurrent = () => { if (generation !== this.generation) throw new Error("SFTP start was cancelled."); };
        try {
            const child = spawn("/bin/sh", ["/usr/local/bin/start-sftp"], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
            this.child = child;
            child.stderr?.resume();
            child.on("error", () => { if (this.child === child) this.fail("SFTP could not start. Check the folder and credentials."); });
            child.on("exit", () => { if (this.child === child) this.fail("SFTP stopped unexpectedly. Check the folder and credentials, then retry."); });
            let ready = false;
            for (let attempt = 0; attempt < 40; attempt++) {
                ensureCurrent();
                ready = await new Promise<boolean>(resolveReady => {
                    const socket = createConnection({ host: "127.0.0.1", port: 8000 });
                    const finish = (value: boolean) => { socket.destroy(); resolveReady(value); };
                    socket.setTimeout(500, () => finish(false));
                    socket.once("error", () => finish(false));
                    socket.once("data", data => finish(data.toString().startsWith("SSH-2.0-")));
                });
                if (ready) break;
                await new Promise(resolveWait => setTimeout(resolveWait, 250));
            }
            ensureCurrent();
            if (!ready) throw new Error("SFTP did not become ready. Check the credentials and retry.");
            rmSync(agentSocket, { force: true });
            const agent = spawn("ssh-agent", ["-D", "-a", agentSocket], { stdio: "ignore" });
            this.agent = agent;
            agent.on("error", () => { if (this.agent === agent) this.fail("The SSH authentication agent could not start."); });
            agent.on("exit", () => { if (this.agent === agent) this.fail("The SSH authentication agent stopped. Start SFTP again."); });
            for (let attempt = 0; attempt < 40 && !existsSync(agentSocket); attempt++) {
                ensureCurrent(); await new Promise(resolveWait => setTimeout(resolveWait, 50));
            }
            ensureCurrent();
            if (!existsSync(agentSocket)) throw new Error("The SSH authentication agent did not become ready.");
            // Load the read-only mounted key into memory. No private-key copy is
            // created, and Windows mount permissions do not weaken SSH checking.
            let loaded = 0;
            for (const file of ssh.identities) {
                ensureCurrent();
                if (!existsSync(file.path)) continue;
                const privateKey = readFileSync(file.path);
                try {
                    const added = spawnSync("ssh-add", ["-"], { input: privateKey,
                        env: { ...process.env, SSH_AUTH_SOCK: agentSocket, SSH_ASKPASS_REQUIRE: "never" },
                        stdio: ["pipe", "ignore", "pipe"], timeout: 5000 });
                    if (!added.error && added.status === 0) ++loaded;
                } finally { privateKey.fill(0); }
            }
            if (!loaded) throw new Error("The detected SSH keys need a passphrase, laptop agent, or hardware device. That authentication is not supported inside SuiteContainer yet.");
            const options = ssh.certificates.flatMap(file => ["-o", `CertificateFile=${file.path}`]);
            if (ssh.hostKeyAlias) options.push("-o", `HostKeyAlias=${ssh.hostKeyAlias}`);
            const tunnel = spawn("ssh", ["-F", "/dev/null", "-N", "-T", "-v", "-o", "BatchMode=yes",
                "-o", "IdentityFile=none", "-o", `IdentityAgent=${agentSocket}`, "-o", "StrictHostKeyChecking=yes",
                "-o", `UserKnownHostsFile=${ssh.knownHosts.map(file => file.path).join(" ")}`, "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=30",
                "-o", "ServerAliveCountMax=3", ...options, "-p", String(ssh.port), "-l", ssh.user,
                "-R", `127.0.0.1:${auth.sftp.port}:127.0.0.1:8000`, ssh.hostname],
                { stdio: ["ignore", "ignore", "pipe"] });
            this.tunnel = tunnel;
            let stderr = "";
            const failure = () => /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)
                ? "The deployment scrumbox SSH host key is not trusted. Verify it on your laptop and relaunch SuiteContainer."
                : /Permission denied/.test(stderr) ? "The detected SSH keys cannot log in to the deployment scrumbox. Check laptop SSH access and retry."
                : /remote port forwarding failed/.test(stderr) ? "The deployment scrumbox port is already in use or SSH forwarding is denied. Stop the existing tunnel or choose another port."
                : "Cannot connect the SFTP tunnel. Check deployment scrumbox access and retry.";
            await new Promise<void>((resolveReady, reject) => {
                let confirmed = false;
                const timer = setTimeout(() => reject(new Error("The SSH tunnel did not become ready. Check deployment scrumbox access and retry.")), 20_000);
                const rejectStart = (message: string) => { clearTimeout(timer); if (!confirmed) reject(new Error(message)); else if (this.tunnel === tunnel) this.fail(message); };
                tunnel.on("error", () => rejectStart("SSH could not start inside SuiteContainer."));
                tunnel.on("exit", () => rejectStart(failure()));
                tunnel.stderr?.on("data", chunk => {
                    stderr = (stderr + String(chunk)).slice(-8000);
                    if (!confirmed && stderr.includes("remote forward success")) { confirmed = true; clearTimeout(timer); resolveReady(); }
                });
            });
            ensureCurrent();
            this.state = "running"; this.tunnelState = "running";
            const hostKey = this.status(auth).hostKey;
            writeFileSync(join(this.credentials, "sftp/connection.json"), JSON.stringify({ username: auth.sftp.username,
                url: "localhost", port: auth.sftp.port, directory: "/files", hostKeyType: "rsa", hostKey }, null, 4) + "\n", { mode: 0o600 });
        } catch (error) {
            if (generation === this.generation) this.fail(error instanceof Error ? error.message : "SFTP could not start.");
            throw error;
        }
    }
    stop(): void {
        ++this.generation;
        const child = this.child, tunnel = this.tunnel, agent = this.agent;
        this.child = undefined; this.tunnel = undefined; this.agent = undefined;
        this.state = "stopped"; this.tunnelState = "stopped"; this.error = "";
        tunnel?.kill(); agent?.kill();
        if (child?.pid) {
            try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
            spawnSync("pkill", ["-TERM", "-u", "1000"], { stdio: "ignore" });
        }
    }
}
