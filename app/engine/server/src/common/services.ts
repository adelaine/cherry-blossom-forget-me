import type { CredentialState } from "./context.ts";
import { existsSync } from "node:fs";
import { ConfigurationService } from "../workspace/services/configuration.ts";
import { configObject } from "./configuration.ts";
import { CredentialsService } from "../workspace/services/credentials.ts";
import { SuiteAppsService } from "../workspace/services/suiteapps.ts";
import { DeploymentService } from "../workspace/services/deployment.ts";
import { SqlService } from "../tools/sql/index.ts";
import { SftpApplicationService } from "../tools/sftp/index.ts";
import { PlaywrightService } from "../tools/playwright/index.ts";
import { SuiteCloudAuthenticationService } from "../workspace/services/SuiteCloudAuthenticationService.ts";
import type { OperationsService } from "./operations.ts";
import { message } from "./errors.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { mountChanges } from "../workspace/services/suiteapps.ts";

export interface ServiceOptions {
	configDirectory?: string;
	workerScript?: string;
	sqlCommand?: string;
	sqlArgs?: string[];
	sqlTimeoutMs?: number;
	playwrightUrl?: string;
	playwrightToken?: string;
}
export type SharedServiceState = CredentialState & {
	passkey: string;
	runnerToken: string;
};
export const createServices = (
	options: ServiceOptions,
	operations: OperationsService,
	shared: SharedServiceState,
) => {
	const configuration = new ConfigurationService(
		options.configDirectory ?? "/config",
		operations,
	);
	const credentials = new CredentialsService(configuration, shared);
	const suiteapps = new SuiteAppsService(configuration, credentials);
	const authentication = new SuiteCloudAuthenticationService(
		configuration,
		credentials,
		suiteapps,
	);
	const deployment = new DeploymentService(
		configuration,
		suiteapps,
		credentials,
		operations,
		shared.passkey,
		options.workerScript,
	);
	const sql = new SqlService(
		configuration,
		credentials,
		operations,
		suiteapps,
		options,
	);
	const sftp = new SftpApplicationService(configuration, credentials);
	const playwright = new PlaywrightService(
		configuration,
		credentials,
		suiteapps,
		operations,
		options.playwrightUrl,
		shared.runnerToken,
	);
	const status = (text = configuration.text()) => {
		const authenticationState = authentication.status();
		let auth: Auth = {};
		let credentialError = "";
		try {
			auth = credentials.read();
		} catch (error) {
			credentialError = message(error);
		}
		const cert = credentials.certificateState(auth);
		const ready = suiteapps.readiness(text);
		let config: Record<string, unknown> = {};
		let testConfig: Config | undefined;
		let testConfigError = "";
		try {
			config = configObject(text);
			testConfig = suiteapps.validate(config);
		} catch (error) {
			testConfigError = message(error);
		}
		let relaunch = false;
		try {
			if (Array.isArray(config.suiteapps))
				relaunch = mountChanges(
					config as Config,
					auth,
					configuration.mounts,
					shared.generatedCertificates,
				);
		} catch {
			/* Validation explains malformed configuration. */
		}
		const savedStatus = config.status as Config["status"];
		return {
			instanceId: operations.instanceId,
			apiVersion: 1,
			config: text,
			ready: ready.ready,
			blockers: ready.blockers,
			error: credentialError || ready.error,
			credentialError,
			tokenPresent: !!auth["gitlab-token"]?.trim(),
			deploymentStarted: savedStatus?.["deploy-start-ok"] === 1,
			theme: savedStatus?.theme,
			authentication: authenticationState,
			certificates: {
				public: /[\r\n]/.test(auth["suitecloud-certificates"]?.public ?? "")
					? ""
					: (auth["suitecloud-certificates"]?.public ?? ""),
				private: /[\r\n]/.test(auth["suitecloud-certificates"]?.private ?? "")
					? ""
					: (auth["suitecloud-certificates"]?.private ?? ""),
				id: auth["suitecloud-certificates"]?.id ?? "",
				canGenerate: !operations.busy() && !operations.restartPending,
				hasExisting: cert.hasExisting,
				error: cert.error,
				canDownload:
					!!cert.publicPath && existsSync(cert.publicPath) && !cert.error,
			},
			relaunch,
			run: deployment.status(),
			sql: sql.status(config),
			sftp: sftp.status(auth),
			playwright: playwright.status(testConfig, testConfigError),
			operations: operations
				.list()
				.map(({ result: _result, ...operation }) => operation),
			serviceRestartPending: operations.restartPending || null,
		};
	};
	const dispose = async (options: { preserveRunner?: boolean } = {}) => {
		sftp.dispose();
		await Promise.all([
			authentication.dispose(),
			deployment.dispose(),
			sql.dispose(),
			playwright.dispose(!options.preserveRunner),
		]);
	};
	return {
		configuration,
		credentials,
		authentication,
		suiteapps,
		deployment,
		sql,
		sftp,
		playwright,
		status,
		dispose,
	};
};
export type Services = ReturnType<typeof createServices>;
