import { PlaywrightClient } from "../playwright-client.ts";
import { hostPath } from "../web-mounts.ts";
import type { Config } from "../step-config.ts";
import type { ConfigurationService } from "./configuration.ts";
import type { CredentialsService } from "./credentials.ts";
import type { SuiteAppsService } from "./suiteapps.ts";
import type { OperationsService } from "./operations.ts";

export class PlaywrightService {
	readonly client: PlaywrightClient;
	starting = false;
	private operationId?: string;
	private timer?: ReturnType<typeof setInterval>;
	private cancelled = false;
	private configuration: ConfigurationService;
	private credentials: CredentialsService;
	private suiteapps: SuiteAppsService;
	private operations: OperationsService;
	constructor(
		configuration: ConfigurationService,
		credentials: CredentialsService,
		suiteapps: SuiteAppsService,
		operations: OperationsService,
		url?: string,
		token?: string,
	) {
		this.configuration = configuration;
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
		const config = this.suiteapps.validate(
			input.targetId !== undefined
				? this.suiteapps.select(input.targetId)
				: input.config,
		);
		if (!config.playwright?.enabled || !config.playwright.project)
			throw new Error(
				"Enable Playwright and choose its project directory before running tests.",
			);
		const settings = config.playwright;
		const vm = config.vms[0];
		if (!vm) throw new Error("Choose a target VM before running tests.");
		const record = this.configuration.mounts;
		const local = Object.fromEntries(
			config.suiteapps
				.filter((repo) => repo.localPath)
				.map((repo) => [repo.directory, hostPath(record, repo.localPath!)]),
		);
		if (
			[...new Set([...Object.keys(local), ...Object.keys(record.local)])].some(
				(name) => local[name] !== record.local[name],
			)
		)
			throw new Error(
				"Save settings and relaunch SuiteContainer to mount the selected local checkouts.",
			);
		if (this.client.status(settings).relaunch)
			throw new Error(
				"Save settings and relaunch SuiteContainer to use the selected Playwright project and browser.",
			);
		const operation = this.operations.reserve(
			"playwright",
			this.suiteapps
				.targets(config)
				.slice(0, 1)
				.map((target) => target.id),
			() => this.cancel(),
		);
		this.operationId = operation.id;
		this.cancelled = false;
		this.starting = true;
		try {
			if (input.targetId === undefined) this.configuration.write(input.config);
			await this.client.start(settings, vm.url, vm.account);
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
	status(config?: Config, configError = "") {
		const state = this.client.status(config?.playwright);
		return {
			...state,
			log: this.credentials.redact(state.log, state.state === "running"),
			operationId: this.operationId,
			state: this.starting ? "running" : state.state,
			error: configError || state.error,
			canRun:
				!configError &&
				state.enabled &&
				!!state.settings.project &&
				state.available &&
				!state.relaunch &&
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
