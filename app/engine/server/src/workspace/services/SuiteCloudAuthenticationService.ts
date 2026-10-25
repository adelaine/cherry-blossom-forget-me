/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { spawn, type ChildProcess } from "node:child_process";
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

/** Own the browser login process and its bounded lifetime. */
export class SuiteCloudAuthenticationService {
	private worker?: ChildProcess;
	private completed?: Promise<void>;
	private operationId?: string;
	private configuration: ConfigurationService;
	private credentials: CredentialsService;
	private suiteapps: SuiteAppsService;
	constructor(
		configuration: ConfigurationService,
		credentials: CredentialsService,
		suiteapps: SuiteAppsService,
	) {
		this.configuration = configuration;
		this.credentials = credentials;
		this.suiteapps = suiteapps;
	}

	status() {
		let auth: Auth["suitecloud-authentication"];
		try {
			auth = this.credentials.read()["suitecloud-authentication"];
		} catch {
			/* State reports credential errors. */
		}
		let version = "";
		try {
			version = basename(suitecloudSdk());
		} catch {
			/* The launcher installs the SDK. */
		}
		const accounts = Object.fromEntries(
			Object.entries(auth?.accounts ?? {}).map(([id, account]) => [
				id,
				{ ...account, connected: account.sdkVersion === version },
			]),
		);
		const operation = this.operationId
			? this.configuration.operations.get(this.operationId)
			: undefined;
		return {
			method: auth?.method ?? "browser",
			accounts,
			state: operation?.state ?? "idle",
			operationId: this.operationId,
			error: operation?.error?.error ?? "",
		};
	}

	async start(targetId: unknown) {
		const operations = this.configuration.operations;
		operations.assertIdle();
		const vm = this.suiteapps.select(targetId).vms[0];
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
			[String(targetId)],
			async () => {
				cancelled = true;
				this.worker?.kill();
				await this.completed;
			},
		);
		this.operationId = operation.id;
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
						const info = result.data!.accountInfo;
						if (info.companyId !== vm.account)
							throw new Error(
								"The signed-in account differs from the selected VM account.",
							);
						const auth = this.credentials.read();
						const account = {
							authId,
							sdkVersion: basename(sdk),
							company: info.companyName,
							role: info.roleName,
							account: vm.account,
							url: vm.url,
						};
						auth["suitecloud-authentication"] = {
							method: "browser",
							accounts: {
								...auth["suitecloud-authentication"]?.accounts,
								[browserAccountKey(vm)]: account,
							},
						};
						this.credentials.write(auth);
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
