import { type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { createAdaptorServer } from "@hono/node-server";
import { HeartbeatDeadline } from "./common/inactivity.ts";
import {
	createServices,
	type ServiceOptions,
	type Services,
	type SharedServiceState,
} from "./common/services.ts";
import { OperationsService } from "./common/operations.ts";
import { message, ServiceError } from "./common/errors.ts";
import type { ApiApp } from "./api/operations.ts";
import { createApplication } from "./api/application.ts";
export { createApplication } from "./api/application.ts";

export type ServerOptions = ServiceOptions & {
	port?: number;
	host?: string;
	sessionFile?: string;
	onStop?: () => void;
	signalHandlers?: boolean;
	inactivityNow?: () => number;
	inactivityCheckMs?: number;
	mode?: "production" | "development";
	accessToken?: string;
	accessTokenFile?: string;
	instanceId?: string;
};

export class ServerLifecycle {
	readonly instanceId: string;
	readonly session = randomBytes(32).toString("hex");
	readonly token: string;
	readonly runnerToken: string;
	readonly passkey = randomBytes(32).toString("hex");
	readonly heartbeat: HeartbeatDeadline;
	readonly operations: OperationsService;
	readonly shared: SharedServiceState;
	services: Services;
	stopping = false;
	stopHandler?: () => void;
	private timer?: ReturnType<typeof setInterval>;
	private disposing?: Promise<void>;
	private restarting?: Promise<boolean>;
	readonly options: ServerOptions;
	constructor(options: ServerOptions = {}) {
		this.options = options;
		this.options.mode ??=
			process.env.SUITECONTAINER_MODE === "development"
				? "development"
				: "production";
		this.instanceId =
			options.instanceId ??
			process.env.SUITECONTAINER_INSTANCE_ID ??
			randomUUID();
		const tokenFile =
			options.accessTokenFile ?? process.env.SUITECONTAINER_ACCESS_TOKEN_FILE;
		this.token =
			options.accessToken ??
			(tokenFile
				? readFileSync(tokenFile, "utf8").trim()
				: randomBytes(32).toString("hex"));
		if (Buffer.byteLength(this.token) < 32 || /[\r\n\0]/.test(this.token))
			throw new Error(
				"The access-token file must contain a securely generated token of at least 256 bits.",
			);
		this.runnerToken =
			options.playwrightToken ??
			process.env.SUITECONTAINER_PLAYWRIGHT_TOKEN ??
			"";
		this.heartbeat = new HeartbeatDeadline(options.inactivityNow);
		this.shared = {
			secrets: new Set([
				this.session,
				this.token,
				this.passkey,
				this.runnerToken,
			]),
			generatedCertificates: false,
			passkey: this.passkey,
			runnerToken: this.runnerToken,
		};
		this.operations = new OperationsService(
			this.instanceId,
			(text, active) => this.services.credentials.redact(text, active),
			() => this.heartbeat.heartbeat(),
			(state, text, final) =>
				this.services.credentials.redactChunk(state, text, final),
		);
		this.services = createServices(options, this.operations, this.shared);
		if (this.options.mode !== "development") {
			this.timer = setInterval(() => {
				if (
					!this.stopping &&
					this.heartbeat.expired(this.busy() || this.managedActive())
				)
					this.stop();
			}, options.inactivityCheckMs ?? 1000);
			this.timer.unref();
		}
	}
	createApp(): ApiApp {
		return createApplication(this);
	}
	busy(): boolean {
		return this.operations.busy() || this.services.playwright.active;
	}
	managedActive(): boolean {
		return this.services.sftp.active;
	}
	setRestartPending(reason = ""): void {
		this.operations.restartPending = reason;
	}
	async restartServices(
		loader: () => Promise<{ createServices: typeof createServices }>,
	): Promise<boolean> {
		if (this.restarting) return this.restarting;
		if (this.stopping || this.busy() || this.managedActive()) return false;
		this.restarting = (async () => {
			try {
				const fresh = await loader();
				if (this.stopping || this.busy() || this.managedActive()) return false;
				await this.services.dispose({ preserveRunner: true });
				this.services = fresh.createServices(
					this.options,
					this.operations,
					this.shared,
				);
				this.operations.restartPending = "";
				return true;
			} catch (error) {
				this.operations.restartPending = `Service restart failed: ${this.services.credentials.redact(message(error))}. Relaunch SuiteContainer.`;
				return false;
			} finally {
				this.restarting = undefined;
			}
		})();
		return this.restarting;
	}
	stop(): void {
		if (this.stopping) return;
		const protectedOperation = this.operations
			.list()
			.find(
				(op) =>
					["preparing", "running"].includes(op.state) &&
					op.kind !== "playwright",
			);
		if (protectedOperation)
			throw new ServiceError(
				"operation_conflict",
				`${protectedOperation.kind === "sql" ? "SQL is" : "Deployment is"} running. Wait for its results before stopping.`,
				409,
				true,
				{ operationId: protectedOperation.id },
			);
		this.stopping = true;
		if (this.stopHandler) this.stopHandler();
		else void this.dispose().finally(this.options.onStop);
	}
	dispose(): Promise<void> {
		if (this.disposing) return this.disposing;
		this.stopping = true;
		clearInterval(this.timer);
		this.disposing = (async () => {
			await this.services.dispose();
			const descriptor = process.env.SUITECONTAINER_CONNECTION_FILE;
			if (descriptor) {
				try {
					if (
						JSON.parse(readFileSync(descriptor, "utf8")).instanceId ===
						this.instanceId
					)
						rmSync(descriptor, { force: true });
				} catch {
					/* A stale host descriptor is rejected during discovery. */
				}
			}
		})();
		return this.disposing;
	}
}
export const createServerLifecycle = (
	options: ServerOptions = {},
): ServerLifecycle => {
	return new ServerLifecycle(options);
};

export const startWebServer = (options: ServerOptions = {}): Server => {
	const lifecycle = createServerLifecycle(options);
	const app = createApplication(lifecycle);
	const server = createAdaptorServer({ fetch: app.fetch }) as Server;
	lifecycle.stopHandler = () =>
		server.close(() => {
			void lifecycle
				.dispose()
				.finally(options.onStop ?? (() => process.exit(0)));
		});
	server.once("close", () => {
		void lifecycle.dispose();
	});
	server.requestTimeout = 15_000;
	server.on("error", (error) => {
		console.error(message(error));
		void lifecycle.dispose();
		process.exitCode = 1;
	});
	server.listen(options.port ?? 8521, options.host ?? "0.0.0.0", () => {
		writeFileSync(
			options.sessionFile ?? "/tmp/suitecontainer-web-url",
			`/#session=${lifecycle.session}`,
			{
				mode: 0o600,
			},
		);
		console.log("SuiteCloud deployment page is ready.");
	});
	const shutdown = () => {
		void lifecycle.dispose().finally(() => {
			server.closeAllConnections();
			server.close();
		});
	};
	if (options.signalHandlers !== false) {
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
		server.once("close", () => {
			process.off("SIGTERM", shutdown);
			process.off("SIGINT", shutdown);
		});
	}
	return server;
};

export default {
	fetch: (
		request: Request,
		env: { lifecycle: ServerLifecycle },
		executionCtx?: unknown,
	) => {
		if (!env?.lifecycle)
			throw new Error(
				"The outer server lifecycle must be injected before handling requests.",
			);
		return createApplication(env.lifecycle).fetch(
			request,
			env,
			executionCtx as never,
		);
	},
};
