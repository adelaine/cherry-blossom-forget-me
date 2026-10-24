import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MountRecord } from "../../../src/web-mounts.ts";
import type { OperationsService } from "./operations.ts";

export function configObject(value: unknown): Record<string, unknown> {
    const parsed = typeof value === "string" ? JSON.parse(value) : structuredClone(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuration must be a JSON object.");
    return parsed as Record<string, unknown>;
}

export class ConfigurationService {
    readonly path: string;
    readonly credentialsDirectory: string;
    readonly authPath: string;
    readonly mounts: MountRecord;
    readonly directory: string;
    readonly operations: OperationsService;
    constructor(directory: string, operations: OperationsService) { this.directory = directory; this.operations = operations;
        this.path = join(directory, "suitecontainer.config.json");
        this.credentialsDirectory = join(directory, "credentials");
        this.authPath = join(this.credentialsDirectory, "auth.json");
        this.mounts = JSON.parse(readFileSync(join(this.credentialsDirectory, "web-mounts.json"), "utf8"));
    }
    text(): string { return readFileSync(this.path, "utf8"); }
    read(): Record<string, unknown> { return configObject(this.text()); }
    save(input: unknown): void { this.operations.assertIdle(); this.write(configObject(input)); }
    write(value: unknown): void {
        // Keep the inode of bind-mounted configuration files intact.
        writeFileSync(this.path, JSON.stringify(configObject(value), null, 4) + "\n");
    }
    theme(theme: unknown): void {
        if (theme !== "light" && theme !== "dark") throw new Error('Choose "light" or "dark" for the theme.');
        const value = this.read();
        if (value.status !== undefined && (!value.status || typeof value.status !== "object" || Array.isArray(value.status))) throw new Error("Set status to an object in Settings before changing the theme.");
        this.write({ ...value, status: { ...value.status as object, theme } });
    }
}
