/* Copyright (c) 2026, Oracle and/or its affiliates. */
import type { CredentialAccess, TargetAccess } from "../../common/context.ts";
import { PlaywrightClient } from "./PlaywrightClient.ts";
import type { PlaywrightRun } from "./types.ts";
import type { OperationsService } from "../../common/operations.ts";
import { ServiceError } from "../../common/errors.ts";

export class PlaywrightService {
	readonly client: PlaywrightClient;
	starting = false;
	private operationId?: string;
	private timer?: ReturnType<typeof setInterval>;
	private cancelled = false;
	private credentials: CredentialAccess;
	private suiteapps: TargetAccess;
	private operations: OperationsService;
	constructor(
		credentials: CredentialAccess,
		suiteapps: TargetAccess,
		operations: OperationsService,
		url?: string,
		token?: string,
	) {
		this.credentials = credentials;
		this.suiteapps = suiteapps;
		this.operations = operations;
		this.client = new PlaywrightClient(url, token);
	}
	get active(): boolean {
		return this.starting || this.client.active;
	}
	async start(input: Record<string, unknown>): Promise<string> {
		this.operations.assertIdle();
		if (typeof input.project !== "string" || !input.project.trim())
			throw new ServiceError(
				"missing_input",
				"Provide the project for this test run.",
			);
		const workers = input.workers ?? 1;
		if (
			typeof workers !== "number" ||
			!Number.isInteger(workers) ||
			workers < 1 ||
			workers > 16
		)
			throw new ServiceError(
				"invalid_input",
				"Workers must be an integer from 1 to 16.",
			);
		if (input.testFile !== undefined && typeof input.testFile !== "string")
			throw new ServiceError(
				"invalid_input",
				"Test file must be a relative path.",
			);
		let host = input.host;
		let account = input.account;
		const targets: string[] = [];
		if (input.targetId !== undefined) {
			if (host !== undefined || account !== undefined)
				throw new ServiceError(
					"invalid_input",
					"Provide targetId or host and account, not both.",
				);
			const config = this.suiteapps.select(input.targetId);
			host = config.vms[0]!.url;
			account = config.vms[0]!.account;
			targets.push(String(input.targetId));
		}
		if (
			typeof host !== "string" ||
			!host ||
			host.length > 253 ||
			/[\s/@\\?#\0]/.test(host)
		)
			throw new ServiceError(
				"invalid_input",
				"Provide a target hostname without a URL scheme or path.",
			);
		if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account))
			throw new ServiceError(
				"invalid_input",
				"Provide the account for this test run.",
			);
		const run: PlaywrightRun = {
			project: input.project,
			host,
			account,
			workers,
			testFile: input.testFile as string | undefined,
		};
		const operation = this.operations.reserve("playwright", targets, () =>
			this.cancel(),
		);
		this.operationId = operation.id;
		this.cancelled = false;
		this.starting = true;
		try {
			await this.client.start(run);
			this.operations.running(operation.id);
			this.timer = setInterval(() => this.update(), 500);
			this.timer.unref();
			this.update();
			return operation.id;
		} catch (error) {
			// A lost response can still mean accepted work; retain reservation until runner status establishes completion.
			if (this.client.active) {
				this.operations.running(operation.id);
				this.timer = setInterval(() => this.update(), 500);
				this.timer.unref();
			} else this.operations.fail(operation.id, error);
			throw error;
		} finally {
			this.starting = false;
		}
	}
	private update(): void {
		if (!this.operationId) return;
		const state = this.client.status();
		this.operations.replaceLog(this.operationId, state.log);
		if (!this.starting && state.state !== "running" && state.state !== "idle") {
			this.operations.finish(
				this.operationId,
				{ state: state.state },
				this.cancelled
					? "cancelled"
					: state.state === "succeeded"
						? "succeeded"
						: "failed",
			);
			clearInterval(this.timer);
		}
	}
	async cancel(): Promise<void> {
		await this.client.cancel();
		this.cancelled = true;
		this.update();
	}
	status() {
		const state = this.client.status();
		return {
			...state,
			log: this.credentials.redact(state.log, state.state === "running"),
			operationId: this.operationId,
			state: this.starting ? "running" : state.state,
			error: state.error,
			canRun:
				state.available &&
				!this.operations.busy() &&
				!this.operations.restartPending,
		};
	}
	async dispose(shutdownRunner = true): Promise<void> {
		clearInterval(this.timer);
		const active = this.active;
		await this.client.dispose(shutdownRunner);
		if (active && this.operationId)
			this.operations.fail(this.operationId, new Error("Backend stopped."));
	}
}
