import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Auth } from "./step-auth.ts";
import type { MountRecord } from "./web-mounts.ts";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
type State = "stopped" | "starting" | "running" | "failed";

/** Target-side SFTP never starts a local server or an SSH reverse tunnel. */
export class RemoteSftpService {
    private target = "";
    private generation = 0;
    private state: State = "stopped";
    private probeState: "idle" | "checking" | "ready" | "failed" = "idle";
    private error = "";
    private connection?: { username: string; port: number; hostKey: string };
    private recreateAvailable = false;
    private owned = new Map<string, string>();
    private processes = new Set<ChildProcess>();
    private runtime?: string;
    private agent?: ChildProcess;
    private agentPreparation?: Promise<void>;

    private credentials: string;
    private record: MountRecord;
    constructor(credentials: string, record: MountRecord) {
        this.credentials = credentials;
        this.record = record;
    }

    get active(): boolean { return this.state === "starting" || this.probeState === "checking"; }

    setTarget(target: string): void {
        if (target === this.target) return;
        ++this.generation;
        for (const child of this.processes) child.kill();
        this.target = target;
        this.state = "stopped";
        this.probeState = "idle";
        this.error = "";
        this.connection = undefined;
        this.recreateAvailable = false;
        rmSync(join(this.credentials, "sftp/connection.json"), { force: true });
    }

    status(auth: Auth) {
        const settings = auth.sftp ?? { username: "suitecontainer", port: 8000, password: "" };
        return { mode: "remote", target: this.target, state: this.state, probe: this.probeState,
            username: settings.username, port: settings.port, path: settings.path || "",
            passwordPresent: !!settings.password, hostKey: this.connection?.hostKey || "",
            connection: this.connection, uploadUrl: this.connection ? `sftp://${this.target}:${this.connection.port}` : "",
            error: this.error, relaunch: false, recreateAvailable: this.recreateAvailable,
            canStart: !!this.target && !this.active && this.probeState !== "idle",
            canStop: !this.active && this.owned.has(this.target),
            tunnel: { state: "stopped", error: "" } };
    }

    private run(command: string, args: string[], input = "", timeout = 15_000,
        env: NodeJS.ProcessEnv = process.env): Promise<string> {
        return new Promise((resolve, reject) => {
            const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
            this.processes.add(child);
            let output = "", stderr = "", timedOut = false;
            const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeout);
            child.stdout.on("data", chunk => { output = (output + String(chunk)).slice(-32_000); });
            child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
            child.stdin.on("error", () => { /* Process completion reports a closed pipe. */ });
            child.on("error", () => {
                clearTimeout(timer); this.processes.delete(child);
                reject(new Error(`${command} could not start inside SuiteContainer.`));
            });
            child.on("close", code => {
                clearTimeout(timer); this.processes.delete(child);
                if (timedOut) reject(new Error("The target operation timed out. Check network access and retry."));
                else if (code !== 0) reject(new Error(/Permission denied|Authentication failed/.test(stderr)
                    ? "Authentication failed. Check the supplied credentials."
                    : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr)
                        ? "The target SSH host key is not trusted. Verify SSH access from the scrumbox and relaunch."
                        : "The target operation failed. Check network access, Podman, and the SFTP settings."));
                else resolve(output);
            });
            child.stdin.end(input);
        });
    }

    private async prepareAgent(): Promise<void> {
        if (this.agentPreparation) return this.agentPreparation;
        this.agentPreparation = this.loadAgent();
        try { await this.agentPreparation; }
        finally { this.agentPreparation = undefined; }
    }

    private async loadAgent(): Promise<void> {
        if (this.agent) return;
        const identities = this.record.ssh?.identities.filter(file => existsSync(file.path)) || [];
        if (!identities.length) throw new Error("No SSH key is mounted. Check nsbuild SSH access from the scrumbox and relaunch.");
        this.runtime ??= mkdtempSync(join(tmpdir(), "suitecontainer-remote-sftp-"));
        const socket = join(this.runtime, "agent.sock");
        const agent = spawn("ssh-agent", ["-D", "-a", socket], { stdio: "ignore" });
        this.agent = agent;
        agent.on("error", () => { if (this.agent === agent) this.agent = undefined; });
        agent.on("exit", () => { if (this.agent === agent) this.agent = undefined; });
        try {
            for (let attempt = 0; attempt < 40 && !existsSync(socket); attempt++)
                await new Promise(resolve => setTimeout(resolve, 50));
            if (!existsSync(socket)) throw new Error("The SSH authentication agent did not become ready.");
            let loaded = false;
            for (const file of identities) {
                const key = readFileSync(file.path);
                try {
                    await this.run("ssh-add", ["-"], key.toString(), 5000,
                        { ...process.env, SSH_AUTH_SOCK: socket, SSH_ASKPASS_REQUIRE: "never" });
                    loaded = true;
                } catch { /* Another mounted identity may authenticate without a passphrase. */ }
                finally { key.fill(0); }
            }
            if (!loaded) throw new Error("The mounted SSH keys could not be loaded. Passphrase and hardware keys are not supported.");
        } catch (error) { agent.kill(); this.agent = undefined; throw error; }
    }

    private async ssh(target: string, script: string, timeout = 15_000): Promise<string> {
        const generation = this.generation;
        if (!/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(target) || !target.endsWith(".netsuite.com"))
            throw new Error("Set a valid Current VM before checking SSH access.");
        await this.prepareAgent();
        if (generation !== this.generation) throw new Error("The deployment target changed.");
        const settings = this.record.ssh;
        const trustFiles = settings?.knownHosts.filter(file => existsSync(file.path)) || [];
        const strictHostKeyChecking = settings?.strictHostKeyChecking || "yes";
        if (!trustFiles.length && strictHostKeyChecking !== "no")
            throw new Error("No SSH trust file is mounted. Verify target SSH access from the scrumbox and relaunch.");
        const options = settings?.certificates.filter(file => existsSync(file.path))
            .flatMap(file => ["-o", `CertificateFile=${file.path}`]) || [];
        return this.run("ssh", ["-F", "/dev/null", "-T", "-o", "BatchMode=yes",
            "-o", "IdentityFile=none", "-o", `IdentityAgent=${join(this.runtime!, "agent.sock")}`,
            "-o", `StrictHostKeyChecking=${strictHostKeyChecking}`, "-o", `UserKnownHostsFile=${trustFiles.map(file => file.path).join(" ") || "/dev/null"}`,
            "-o", "GlobalKnownHostsFile=/dev/null", "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", ...options,
            `nsbuild@${target}`, "bash -s"], script, timeout);
    }

    async probe(target: string): Promise<void> {
        this.setTarget(target);
        if (this.active) return;
        const generation = this.generation;
        this.probeState = "checking"; this.error = "";
        try {
            await this.ssh(target, "true\n");
            if (generation === this.generation) this.probeState = "ready";
        } catch (error) {
            if (generation === this.generation) {
                this.probeState = "failed";
                this.error = `${error instanceof Error ? error.message : "SSH access failed."} Click Start SFTP to retry.`;
            }
        }
    }

    private listener(target: string, port: number): Promise<boolean> {
        return new Promise((resolve, reject) => {
            const socket = createConnection({ host: target, port });
            const finish = (error?: Error, present = false) => {
                socket.destroy();
                if (error) reject(error); else resolve(present);
            };
            socket.setTimeout(5000, () => finish(new Error("The SFTP port did not respond. Check network access and retry.")));
            socket.once("error", (error: NodeJS.ErrnoException) => error.code === "ECONNREFUSED"
                ? finish(undefined, false) : finish(new Error("Cannot reach the SFTP port. Check network access and retry.")));
            socket.once("connect", () => finish(undefined, true));
        });
    }

    private async authenticate(target: string, settings: NonNullable<Auth["sftp"]>): Promise<string> {
        // Obtain the SFTP key over the authenticated administration connection.
        const scan = await this.ssh(target, `ssh-keyscan -T 5 -t rsa -p ${settings.port} 127.0.0.1\n`);
        const hostKey = scan.split(/\r?\n/).map(line => line.trim().split(/\s+/))
            .find(parts => parts[1] === "ssh-rsa")?.[2];
        if (!hostKey || !/^[A-Za-z0-9+/=]+$/.test(hostKey)) throw new Error("Could not detect an RSA SFTP host key.");
        const directory = mkdtempSync(join(this.runtime!, "login-"));
        try {
            writeFileSync(join(directory, "known_hosts"), `[${target}]:${settings.port} ssh-rsa ${hostKey}\n`, { mode: 0o600 });
            writeFileSync(join(directory, "password"), settings.password, { mode: 0o600 });
            writeFileSync(join(directory, "askpass"), '#!/bin/sh\ncat "$SUITECONTAINER_SFTP_PASSWORD_FILE"\n', { mode: 0o700 });
            await this.run("sftp", ["-F", "/dev/null", "-P", String(settings.port),
                "-o", "BatchMode=no", "-o", "PreferredAuthentications=password", "-o", "PubkeyAuthentication=no",
                "-o", "NumberOfPasswordPrompts=1", "-o", "StrictHostKeyChecking=yes",
                "-o", `UserKnownHostsFile=${join(directory, "known_hosts")}`, "-o", "GlobalKnownHostsFile=/dev/null",
                "-o", "ConnectTimeout=10", "-b", "-", `${settings.username}@${target}`], "pwd\nquit\n", 15_000,
                { ...process.env, DISPLAY: ":0", SSH_ASKPASS_REQUIRE: "force",
                    SSH_ASKPASS: join(directory, "askpass"), SUITECONTAINER_SFTP_PASSWORD_FILE: join(directory, "password") });
            return hostKey;
        } finally { rmSync(directory, { recursive: true, force: true }); }
    }

    async start(auth: Auth, target: string, recreate = false): Promise<void> {
        this.setTarget(target);
        if (this.active) throw new Error("Wait for the current SFTP operation to finish.");
        if (!auth.sftp?.password) throw new Error("Enter an SFTP password before starting.");
        if (recreate && !this.recreateAvailable) throw new Error("Check existing SFTP access before recreating the container.");
        const generation = this.generation, settings = { ...auth.sftp };
        this.state = "starting"; this.error = ""; this.connection = undefined;
        this.recreateAvailable = false;
        rmSync(join(this.credentials, "sftp/connection.json"), { force: true });
        const current = () => { if (generation !== this.generation) throw new Error("The deployment target changed."); };
        try {
            await this.ssh(target, "true\n"); current(); this.probeState = "ready";
            const present = await this.listener(target, settings.port); current();
            if (present && !recreate) {
                try {
                    const hostKey = await this.authenticate(target, settings); current();
                    this.publish(settings, hostKey);
                    this.state = this.owned.has(target) ? "running" : "stopped";
                    return;
                } catch (error) {
                    current();
                    // Only authentication failure warrants offering replacement.
                    this.recreateAvailable = error instanceof Error && error.message.startsWith("Authentication failed.");
                    throw error;
                }
            }
            const startup = `useradd -m ${quote(settings.username)} && echo ${quote(`${settings.username}:${settings.password}`)} | chpasswd && ssh-keygen -A && mkdir -p /run/sshd && printf "\\nPasswordAuthentication yes\\nPermitRootLogin no\\n" >> /etc/ssh/sshd_config && exec /usr/sbin/sshd -D -e`;
            const result = await this.ssh(target, `podman run -d --name sftp --replace -p ${settings.port}:22 container-registry.eng.netsuite.com/devops/ns-oraclelinux-9 bash -lc ${quote(startup)}\n`, 120_000);
            const id = result.trim().split(/\s+/).findLast(value => /^[a-f0-9]{64}$/.test(value));
            if (!id) throw new Error("Podman did not return the SFTP container ID.");
            this.owned.set(target, id); current();
            // Key generation may finish after Podman returns the container ID.
            let hostKey = "";
            for (let attempt = 0; attempt < 3; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 2000)); current();
                try { hostKey = await this.authenticate(target, settings); break; }
                catch (error) {
                    current();
                    if (attempt === 2 || error instanceof Error && error.message.startsWith("Authentication failed.")) throw error;
                }
            }
            current();
            this.publish(settings, hostKey); this.state = "running";
        } catch (error) {
            if (generation === this.generation) {
                this.state = "failed";
                this.error = error instanceof Error ? error.message : "SFTP could not start.";
                if (this.probeState !== "ready") this.probeState = "failed";
            }
        }
    }

    private publish(settings: NonNullable<Auth["sftp"]>, hostKey: string): void {
        this.connection = { username: settings.username, port: settings.port, hostKey };
        this.recreateAvailable = false;
        mkdirSync(join(this.credentials, "sftp"), { recursive: true, mode: 0o700 });
        writeFileSync(join(this.credentials, "sftp/connection.json"), JSON.stringify({ ...this.connection,
            url: "localhost", uploadUrl: `sftp://${this.target}:${settings.port}`, hostKeyType: "rsa" }, null, 4) + "\n", { mode: 0o600 });
    }

    async stop(): Promise<void> {
        const target = this.target, id = this.owned.get(target), generation = this.generation;
        if (!id) throw new Error("This session did not create the target SFTP container.");
        if (this.active) throw new Error("Wait for the current SFTP operation to finish.");
        this.state = "starting"; this.error = "";
        try {
            await this.ssh(target, `podman stop ${quote(id)}\n`);
            this.owned.delete(target);
            if (generation === this.generation) {
                this.state = "stopped"; this.connection = undefined;
                rmSync(join(this.credentials, "sftp/connection.json"), { force: true });
            }
        } catch (error) {
            if (generation === this.generation) { this.state = "failed"; this.error = error instanceof Error ? error.message : "SFTP could not stop."; }
        }
    }

    dispose(): void {
        ++this.generation;
        for (const child of this.processes) child.kill();
        this.agent?.kill(); this.agent = undefined;
        if (this.runtime) rmSync(this.runtime, { recursive: true, force: true });
    }
}
