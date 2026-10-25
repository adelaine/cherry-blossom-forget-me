/* Copyright (c) 2026, Oracle and/or its affiliates. */
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { MountRecord } from "./mounts.ts";
import type { OperationsService } from "./operations.ts";

export interface CredentialState {
	generatedCertificates: boolean;
	secrets: Set<string>;
}

export interface LogRedactionState {
	pending: string;
	privateKey: boolean;
}

export interface Target {
	id: string;
	account: string;
	url: string;
	displayName: string;
}

/** Workspace dependencies supplied to a tool, without exposing its internal services. */
export interface WorkspaceContext {
	readonly credentialsDirectory: string;
	readonly mounts: MountRecord;
	readonly operations: OperationsService;
	read(): Record<string, unknown>;
	write(value: unknown): void;
}

/** Credential access supplied to tools by the application composition. */
export interface CredentialAccess {
	readonly shared: Pick<CredentialState, "secrets">;
	read(): Auth;
	write(auth: Auth): void;
	redact(text: string, streaming?: boolean): string;
}

/** Configured target selection shared by workspace operations and tools. */
export interface TargetAccess {
	validate(value: unknown): Config;
	select(targetId: unknown, value?: unknown): Config;
	targets(value?: unknown): Target[];
}
