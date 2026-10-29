/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
	browserAccountKey,
	browserEnvironment,
	suitecloudSdk,
} from "../suitecloud-auth.ts";
import type { ConfigurationService } from "./configuration.ts";
import type { CredentialsService } from "./credentials.ts";
import type { SuiteAppsService } from "./suiteapps.ts";
import { ServiceError } from "../../common/errors.ts";
import type { Auth } from "../../common/auth.ts";
import type { Operation } from "../../common/operations.ts";

/** Own the browser login process and its bounded lifetime. */
export class SuiteCloudAuthenticationService {
	private worker?: ChildProcess;
	private completed?: Promise<void>;
	private operationId?: string;
	private terminalOperation?: Operation;
	private configuration: ConfigurationService;
	private credentials: CredentialsService;
	private suiteapps: SuiteAppsService;
	private reconciled = false;
	private reconciliationError = "";
	constructor(
		configuration: ConfigurationService,
		credentials: CredentialsService,
		suiteapps: SuiteAppsService,
	) {
		this.configuration = configuration;
		this.credentials = credentials;
		this.suiteapps = suiteapps;
	}

	private reconcile(stored: Auth): void {
		const accounts = stored["suitecloud-authentication"]?.accounts;
		if (this.reconciled || !accounts || !Object.keys(accounts).length) return;
		this.reconciled = true;
		try {
			const result = spawnSync(
				"java",
				[
					"-DintegrationMode",
					"--add-opens",
					"java.base/java.io=ALL-UNNAMED",
					"-jar",
					suitecloudSdk(),
					"manageauth",
					"-list",
				],
				{
					env: browserEnvironment(this.configuration.credentialsDirectory),
					encoding: "utf8",
					timeout: 5000,
					windowsHide: true,
					maxBuffer: 4 * 1024 * 1024,
				},
			);
			if (result.error || result.status !== 0)
				throw new Error("SDK authentication list unavailable.");
			const list = JSON.parse(result.stdout) as {
				status?: unknown;
				data?: unknown;
			};
			if (
				list.status !== "SUCCESS" ||
				!list.data ||
				typeof list.data !== "object" ||
				Array.isArray(list.data)
			)
				throw new Error("SDK authentication list was invalid.");
			const ids = new Set(Object.keys(list.data));
			const retained = { ...accounts };
			const deployments = { ...stored["suitecloud-deployments"] };
			let changed = false;
			for (const [id, account] of Object.entries(accounts)) {
				if (ids.has(account.authId)) continue;
				delete retained[id];
				delete deployments[id];
				changed = true;
			}
			if (changed) {
				const updated: Auth = {
					...stored,
					"suitecloud-authentication": {
						...stored["suitecloud-authentication"]!,
						accounts: retained,
					},
					"suitecloud-deployments": deployments,
				};
				this.credentials.write(updated);
				Object.assign(stored, updated);
			}
		} catch {
			this.reconciliationError =
				"Saved connections could not be verified with SuiteCloud. Existing entries were kept.";
		}
	}

	status() {
		let stored: Auth = {};
		try {
			stored = this.credentials.read();
			this.reconcile(stored);
		} catch {
			/* State reports credential errors. */
		}
		const auth = stored["suitecloud-authentication"];
		let version = "";
		try {
			version = basename(suitecloudSdk());
		} catch {
			/* The launcher installs the SDK. */
		}
		const accounts = Object.fromEntries(
			Object.entries(auth?.accounts ?? {}).map(([id, account]) => [
				id,
				{
					...account,
					connected: account.sdkVersion === version,
					...(stored["suitecloud-deployments"]?.[id]
						? { lastSuccessfulDeployment: stored["suitecloud-deployments"][id] }
						: {}),
				},
			]),
		);
		const operation =
			this.terminalOperation ??
			(this.operationId
				? this.configuration.operations.get(this.operationId)
				: undefined);
		return {
			method: auth?.method ?? "browser",
			accounts,
			state: operation?.state ?? "idle",
			operationId: this.operationId,
			error: operation?.error?.error || this.reconciliationError,
		};
	}

	async start(targetId: unknown, requestedUrl?: unknown) {
		const operations = this.configuration.operations;
		operations.assertIdle();
		const discovering = requestedUrl !== undefined;
		const domain =
			typeof requestedUrl === "string" ? requestedUrl.trim().toLowerCase() : "";
		if (
			discovering &&
			(targetId !== undefined ||
				!/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(domain) ||
				!domain.endsWith(".netsuite.com"))
		)
			throw new ServiceError(
				"invalid_target",
				"Enter a valid NetSuite domain for browser sign-in.",
			);
		const original = this.configuration.read();
		if (
			discovering &&
			original.vms !== undefined &&
			!Array.isArray(original.vms)
		)
			throw new ServiceError(
				"invalid_configuration",
				"Fix the VM list before signing in.",
			);
		const originalVms = (original.vms ?? []) as unknown[];
		const firstVm = originalVms[0];
		if (
			discovering &&
			firstVm !== undefined &&
			(!firstVm || typeof firstVm !== "object" || Array.isArray(firstVm))
		)
			throw new ServiceError(
				"invalid_configuration",
				"Fix the first VM before signing in.",
			);
		const vm = discovering
			? { url: domain, account: "" }
			: this.suiteapps.select(targetId).vms[0];
		const sdk = suitecloudSdk();
		const agent = "/opt/suitecontainer/browser-handoff.jar";
		if (!existsSync(agent))
			throw new ServiceError(
				"restart_required",
				"Relaunch SuiteContainer to install browser authentication.",
			);
		const temporary = mkdtempSync(join(tmpdir(), "suitecloud-login-"));
		const urlFile = join(temporary, "browser-url");
		writeFileSync(urlFile, "", { mode: 0o600 });
		const authId = `browser_${browserAccountKey(vm)}_${randomBytes(4).toString("hex")}`;
		const env = browserEnvironment(this.configuration.credentialsDirectory);
		this.credentials.shared.secrets.add(env.SUITECLOUD_FALLBACK_PASSKEY!);
		env.JAVA_TOOL_OPTIONS += ` --add-exports=java.base/jdk.internal.org.objectweb.asm=ALL-UNNAMED -javaagent:${agent}`;
		env.SUITECONTAINER_BROWSER_URL_FILE = urlFile;
		let cancelled = false;
		const operation = operations.reserve(
			"suitecloud-authentication",
			[discovering ? vm.url : String(targetId)],
			async () => {
				cancelled = true;
				this.worker?.kill();
				await this.completed;
			},
		);
		this.operationId = operation.id;
		this.terminalOperation = undefined;
		let rejectUrl: (error: Error) => void = () => {};
		let closeWatcher = () => {};
		const url = new Promise<string>((resolve, reject) => {
			rejectUrl = reject;
			const timer = setTimeout(
				() =>
					reject(
						new Error(
							"SuiteCloud did not open a login page. Try signing in again.",
						),
					),
				15000,
			);
			const watcher = watch(temporary, (_event, filename) => {
				if (filename !== "browser-url") return;
				let value: string;
				try {
					value = readFileSync(urlFile, "utf8").trim();
				} catch {
					return;
				}
				if (!value) return;
				const address = new URL(value);
				if (address.protocol !== "https:" || address.hostname !== vm.url) {
					reject(
						new Error("SuiteCloud returned an unexpected login destination."),
					);
					return;
				}
				this.credentials.shared.secrets.add(value);
				resolve(value);
			});
			closeWatcher = () => {
				clearTimeout(timer);
				watcher.close();
			};
		});
		try {
			const worker = spawn(
				"java",
				[
					"-DintegrationMode",
					"-DclientPlatform=SuiteCloudCLIforNode.js",
					`-DclientPlatformVersion=${process.version}`,
					"--add-opens",
					"java.base/java.io=ALL-UNNAMED",
					"-jar",
					sdk,
					"authenticate",
					"-authid",
					authId,
					"-url",
					vm.url,
				],
				{
					env,
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 300000,
					windowsHide: true,
				},
			);
			this.worker = worker;
			operations.running(operation.id);
			let output = "";
			worker.stdout!.on("data", (chunk: Buffer) => {
				output = (output + chunk.toString()).slice(-65536);
			});
			worker.stderr!.resume();
			worker.once("error", () =>
				rejectUrl(
					new Error("SuiteCloud could not start. Relaunch SuiteContainer."),
				),
			);
			this.completed = new Promise((resolve) =>
				worker.once("close", () => {
					try {
						if (cancelled) {
							operations.finish(operation.id, {}, "cancelled");
							return;
						}
						const result = JSON.parse(output) as {
							status: string;
							errorMessages?: string[];
							data?: {
								accountInfo: {
									companyId: string;
									companyName: string;
									roleName: string;
								};
							};
						};
						if (result.status !== "SUCCESS")
							throw new Error(
								result.errorMessages?.join("\n") ||
									"Sign-in failed. Try again.",
							);
						const info = result.data?.accountInfo;
						if (
							!info ||
							typeof info.companyId !== "string" ||
							!/^[A-Za-z0-9_-]+$/.test(info.companyId) ||
							typeof info.companyName !== "string" ||
							typeof info.roleName !== "string"
						)
							throw new Error(
								"SuiteCloud did not return valid account details. Try signing in again.",
							);
						if (!discovering && info.companyId !== vm.account)
							throw new Error(
								"The signed-in account differs from the selected VM account.",
							);
						const verifiedVm = { ...vm, account: info.companyId };
						const current = this.configuration.read();
						if (
							discovering &&
							JSON.stringify(current.vms) !== JSON.stringify(original.vms)
						)
							throw new Error(
								"Account settings changed during sign-in. Sign in again for the selected domain.",
							);
						const auth = this.credentials.read();
						const account = {
							authId,
							sdkVersion: basename(sdk),
							company: info.companyName,
							role: info.roleName,
							account: verifiedVm.account,
							url: vm.url,
						};
						auth["suitecloud-authentication"] = {
							method: "browser",
							accounts: {
								...auth["suitecloud-authentication"]?.accounts,
								[browserAccountKey(verifiedVm)]: account,
							},
						};
						this.credentials.write(auth);
						if (discovering)
							this.configuration.write({
								...current,
								vms: [
									{
										...(firstVm && typeof firstVm === "object" ? firstVm : {}),
										...verifiedVm,
									},
									...originalVms.slice(1),
								],
							});
						operations.finish(operation.id, {
							company: info.companyName,
							role: info.roleName,
						});
					} catch (error) {
						operations.fail(
							operation.id,
							error instanceof SyntaxError
								? new Error(
										"SuiteCloud sign-in failed or timed out. Try again.",
									)
								: error,
						);
						rejectUrl(
							error instanceof Error
								? error
								: new Error("SuiteCloud sign-in failed."),
						);
					} finally {
						// Keep the login outcome after disposable operation history expires.
						if (this.operationId === operation.id && !this.terminalOperation)
							this.terminalOperation = operations.get(operation.id);
						closeWatcher();
						rejectUrl(
							new Error("SuiteCloud sign-in ended before opening the browser."),
						);
						rmSync(temporary, { recursive: true, force: true });
						this.worker = undefined;
						resolve();
					}
				}),
			);
			return { operationId: operation.id, url: await url };
		} catch (error) {
			this.worker?.kill();
			operations.fail(operation.id, error);
			this.terminalOperation = operations.get(operation.id);
			throw error;
		} finally {
			closeWatcher();
		}
	}

	async dispose(): Promise<void> {
		this.worker?.kill();
		await this.completed;
	}
}
