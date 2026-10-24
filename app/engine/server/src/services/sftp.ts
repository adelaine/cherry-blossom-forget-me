import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SftpService } from "../sftp-server.ts";
import { RemoteSftpService } from "../sftp-remote.ts";
import { readAuth, type Auth } from "../step-auth.ts";
import type { ConfigurationService } from "./configuration.ts";
import type { CredentialsService } from "./credentials.ts";

export class SftpApplicationService {
    readonly implementation: SftpService | RemoteSftpService;
    private configuration: ConfigurationService;
    private credentials: CredentialsService;
    constructor(
        configuration: ConfigurationService,
        credentials: CredentialsService,
    ) {
        this.configuration = configuration;
        this.credentials = credentials;
        this.implementation = (process.env.SUITECONTAINER_HOST_FQDN || "")
            .toLowerCase()
            .endsWith(".vm.eng.netsuite.com")
            ? new RemoteSftpService(
                  configuration.credentialsDirectory,
                  configuration.mounts,
              )
            : new SftpService(
                  configuration.credentialsDirectory,
                  configuration.mounts,
              );
    }
    target(): string {
        try {
            const host = (
                this.configuration.read().vms as { url?: string }[]
            )?.[0]?.url;
            return typeof host === "string" ? host : "";
        } catch {
            return "";
        }
    }
    get active(): boolean {
        return this.implementation.active;
    }
    status(auth: Auth) {
        if (this.implementation instanceof RemoteSftpService)
            this.implementation.setTarget(this.target());
        return this.implementation.status(auth);
    }
    async action(input: Record<string, unknown>): Promise<void> {
        const service = this.implementation;
        if (
            !["save", "start", "stop", "probe", "recreate"].includes(
                String(input.action),
            )
        )
            throw new Error("Choose an SFTP action.");
        if (service instanceof RemoteSftpService) {
            service.setTarget(this.target());
            if (input.action === "probe") {
                void service.probe(this.target());
                return;
            }
            if (input.action === "stop") {
                if (!service.status(this.credentials.read()).canStop)
                    throw new Error(
                        "This session has no target SFTP container available to stop.",
                    );
                void service.stop();
                return;
            }
            if (
                input.action === "recreate" &&
                (input.confirmReplace !== true ||
                    !service.status(this.credentials.read()).recreateAvailable)
            )
                throw new Error(
                    "Confirm replacement of the existing SFTP container before recreating it.",
                );
        } else if (input.action === "probe" || input.action === "recreate")
            throw new Error("This SFTP action requires scrumbox mode.");
        if (input.action === "stop") {
            service.stop();
            return;
        }
        this.configuration.operations.assertIdle();
        if (service.active)
            throw new Error("Stop SFTP before changing its settings.");
        const auth = this.credentials.read();
        const saved = auth.sftp ?? {
            username: "suitecontainer",
            port: 8000,
            password: "",
        };
        if (
            typeof input.username !== "string" ||
            typeof input.port !== "number" ||
            typeof input.path !== "string" ||
            (input.password !== undefined && typeof input.password !== "string")
        )
            throw new Error(
                "Enter the SFTP user, port, password, and local folder.",
            );
        const next: Auth = {
            ...auth,
            sftp: {
                username: input.username.trim(),
                port: input.port,
                password: input.password
                    ? String(input.password)
                    : saved.password,
                path: input.path.trim(),
            },
        };
        const temporary = join(
            this.configuration.credentialsDirectory,
            `.sftp-${randomBytes(8).toString("hex")}.json`,
        );
        try {
            writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
            readAuth(temporary);
        } finally {
            rmSync(temporary, { force: true });
        }
        this.credentials.write(next);
        if (input.action === "start" || input.action === "recreate") {
            if (service instanceof RemoteSftpService) {
                if (!next.sftp!.password)
                    throw new Error("Enter an SFTP password before starting.");
                void service.start(
                    next,
                    this.target(),
                    input.action === "recreate",
                );
            } else await service.start(next, this.target());
        }
    }
    dispose(): void {
        this.implementation.dispose();
    }
}
