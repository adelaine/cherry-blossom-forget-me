import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";
import { credentialContracts } from "./credentials.ts";
import { suiteappContracts } from "./suiteapps.ts";
import { deploymentContracts } from "./deployment.ts";
import { sqlContracts } from "./sql.ts";
import { sftpContracts } from "./sftp.ts";
import { playwrightContracts } from "./playwright.ts";
import { operationContracts } from "./operations.ts";

export const systemContracts: ApiContract[] = [
	{
		method: "GET",
		path: "/api/state",
		responseFields: [
			"instanceId",
			"apiVersion",
			"config",
			"ready",
			"blockers",
			"run",
			"sql",
			"sftp",
			"playwright",
			"operations",
			"serviceRestartPending",
		],
	},
	{
		method: "GET",
		path: "/api/capabilities",
		responseFields: [
			"apiVersion",
			"instanceId",
			"mode",
			"capabilities",
			"authentication",
			"limits",
		],
	},
	{ method: "POST", path: "/api/heartbeat", responseFields: ["alive"] },
	{
		method: "POST",
		path: "/api/theme",
		schema: {
			required: ["theme"],
			fields: { theme: { type: "string", enum: ["light", "dark"] } },
		},
		responseFields: ["theme"],
	},
	{
		method: "POST",
		path: "/api/stop",
		responseFields: ["stopped"],
		confirmation:
			"Refused during deployment or SQL preparation/execution. Active Playwright is shut down through the managed runner.",
	},
];
export const systemApi = (app: ApiApp, lifecycle: ServerLifecycle): void => {
	register(app, lifecycle, systemContracts[0], () =>
		lifecycle.services.status(),
	);
	register(app, lifecycle, systemContracts[1], () => ({
		apiVersion: 1,
		instanceId: lifecycle.instanceId,
		mode: lifecycle.options.mode ?? "production",
		capabilities: [
			...systemContracts,
			...credentialContracts,
			...suiteappContracts,
			...deploymentContracts,
			...sqlContracts,
			...sftpContracts,
			...playwrightContracts,
			...operationContracts,
		].map((contract) => ({
			...contract,
			requiredInputs: contract.schema?.required ?? [],
			cancellationSupported: contract.cancelSupported ?? false,
			contentType: contract.contentType ?? "application/json",
		})),
		authentication: {
			browser: "x-session-token plus same-origin mutation requests",
			agent:
				"Authorization: Bearer <access-token>; Origin optional, validated when present",
			idempotency:
				"Idempotency-Key on mutations; original operation or latest 100 side-effect responses retained within this instance. Expired outcomes return 410 idempotency_expired and are never replayed.",
		},
		limits: {
			completedOperations: 100,
			mutationResponses: 100,
			logBytes: 512 * 1024,
			requestBytes: 128 * 1024,
		},
		errors: ["error", "code", "retryable", "details"],
	}));
	register(app, lifecycle, systemContracts[2], () => {
		lifecycle.heartbeat.heartbeat();
		return { alive: true };
	});
	register(app, lifecycle, systemContracts[3], (input) => {
		lifecycle.services.configuration.theme(input.theme);
		return lifecycle.services.status();
	});
	register(app, lifecycle, systemContracts[4], () => {
		lifecycle.stop();
		return { stopped: true };
	});
};
