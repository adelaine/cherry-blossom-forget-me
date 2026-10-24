import {
	copyFileSync,
	constants,
	chmodSync,
	existsSync,
	readFileSync,
	renameSync,
} from "node:fs";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { startSql, validateSqlRequest } from "../sql-runner.ts";
import {
	SQL_DEFAULTS,
	SQL_PASSWORD_HINT,
	SQL_PASSWORD_SALT,
} from "../sql-settings.ts";
import { decryptSqlPassword } from "../sql-password-crypto.ts";
import { configObject, type ConfigurationService } from "./configuration.ts";
import type { CredentialsService } from "./credentials.ts";
import type { OperationsService } from "./operations.ts";
import type { SuiteAppsService } from "./suiteapps.ts";
import { message } from "./errors.ts";

export class SqlService {
	run: {
		state: "idle" | "running" | "succeeded" | "failed";
		output: string;
		host?: string;
		database?: string;
		operationId?: string;
	} = { state: "idle", output: "" };
	preparing = false;
	private worker?: ChildProcess;
	private completion?: Promise<void>;
	private disposed = false;
	private pending?: Promise<string>;
	private userPath: string;
	private defaultPath: string;
	private configuration: ConfigurationService;
	private credentials: CredentialsService;
	private operations: OperationsService;
	private suiteapps: SuiteAppsService;
	private options: {
		sqlCommand?: string;
		sqlArgs?: string[];
		sqlTimeoutMs?: number;
	};
	constructor(
		configuration: ConfigurationService,
		credentials: CredentialsService,
		operations: OperationsService,
		suiteapps: SuiteAppsService,
		options: {
			sqlCommand?: string;
			sqlArgs?: string[];
			sqlTimeoutMs?: number;
		},
	) {
		this.configuration = configuration;
		this.credentials = credentials;
		this.operations = operations;
		this.suiteapps = suiteapps;
		this.options = options;
		this.userPath = join(configuration.credentialsDirectory, ".sql-user.enc");
		this.defaultPath = join(
			configuration.credentialsDirectory,
			".sql-default.enc",
		);
		try {
			this.prepareUser();
		} catch (error) {
			console.warn(message(error));
		}
	}
	private prepareUser() {
		for (const [legacyName, destination] of [
			[".sql-default", this.defaultPath],
			[".sql-user", this.userPath],
		]) {
			const legacy = join(this.configuration.credentialsDirectory, legacyName);
			if (!existsSync(destination) && existsSync(legacy))
				renameSync(legacy, destination);
		}
		if (existsSync(this.userPath) || !existsSync(this.defaultPath)) return;
		try {
			copyFileSync(this.defaultPath, this.userPath, constants.COPYFILE_EXCL);
			chmodSync(this.userPath, 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST")
				throw new Error(
					"Cannot create credentials/.sql-user.enc. Check the credentials folder permissions or enter the SQL password manually.",
				);
		}
	}
	start(input: Record<string, unknown>): Promise<string> {
		this.operations.assertIdle();
		const config =
			input.targetId !== undefined
				? this.suiteapps.select(input.targetId)
				: configObject(input.config);
		if (
			(input.password !== undefined && typeof input.password !== "string") ||
			(input.unlock !== undefined && typeof input.unlock !== "string")
		)
			throw new Error(
				"Enter your SQL password or the answer to the password hint.",
			);
		const manual = typeof input.password === "string" && !!input.password;
		const unlock = typeof input.unlock === "string" && !!input.unlock;
		if (manual && unlock)
			throw new Error(
				"Use only one option: your SQL password or the answer to the password hint.",
			);
		if (!manual && !unlock)
			throw new Error(
				"Enter your SQL password, or answer the password hint to unlock the saved password.",
			);
		const request = validateSqlRequest(
			{
				...input,
				host: (config.vms as { url?: string }[])?.[0]?.url,
				password: manual ? input.password : "pending-unlock",
			},
			config,
		);
		const targetIds = this.suiteapps
			.targets(config)
			.slice(0, 1)
			.map((target) => target.id);
		const op = this.operations.reserve("sql", targetIds);
		if (typeof input.password === "string")
			this.credentials.shared.secrets.add(input.password);
		if (typeof input.unlock === "string")
			this.credentials.shared.secrets.add(input.unlock);
		this.pending = (async () => {
			try {
				if (unlock) {
					this.preparing = true;
					let decrypted: Buffer | undefined;
					try {
						this.prepareUser();
						let encrypted: string;
						try {
							encrypted = readFileSync(this.userPath, "utf8").trim();
						} catch {
							throw new Error(
								"Cannot read credentials/.sql-user.enc. Enter the SQL password manually or restore the encrypted user file.",
							);
						}
						decrypted = await decryptSqlPassword(
							encrypted,
							input.unlock as string,
							SQL_PASSWORD_SALT,
						);
						if (this.disposed)
							throw new Error("The app is stopping. Relaunch to continue.");
						request.password = decrypted.toString("utf8");
						validateSqlRequest(request, config);
					} finally {
						decrypted?.fill(0);
						this.preparing = false;
					}
				}
				this.credentials.shared.secrets.add(request.password);
				const execution = startSql(request, {
					command: this.options.sqlCommand,
					args: this.options.sqlArgs,
					timeoutMs: this.options.sqlTimeoutMs,
				});
				this.worker = execution.child;
				this.operations.running(op.id);
				this.run = {
					state: "running",
					output: "",
					host: request.host,
					database: request.database,
					operationId: op.id,
				};
				this.completion = execution.result.then((result) => {
					this.run = {
						...this.run,
						...result,
						output: this.credentials.redact(result.output),
					};
					this.worker = undefined;
					this.operations.append(op.id, this.run.output);
					this.operations.finish(
						op.id,
						{
							state: this.run.state,
							output: this.run.output,
							host: request.host,
							database: request.database,
						},
						result.state === "succeeded" ? "succeeded" : "failed",
					);
				});
				return op.id;
			} catch (error) {
				this.operations.fail(op.id, error);
				throw error;
			}
		})();
		return this.pending;
	}
	status(config: Record<string, unknown>) {
		const database = (
			config.vms as { database?: { user?: string; service?: string } }[]
		)?.[0]?.database;
		return {
			...this.run,
			output: this.credentials.redact(this.run.output),
			defaults: {
				user:
					typeof database?.user === "string"
						? database.user
						: SQL_DEFAULTS.user,
				service:
					typeof database?.service === "string"
						? database.service
						: SQL_DEFAULTS.service,
			},
			passwordHint: SQL_PASSWORD_HINT,
			hasDefaultPassword:
				existsSync(this.userPath) || existsSync(this.defaultPath),
			preparing: this.preparing,
		};
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		try {
			await this.pending;
		} catch {
			/* Preparation failure is recorded. */
		}
		this.worker?.kill("SIGKILL");
		await this.completion;
	}
}
