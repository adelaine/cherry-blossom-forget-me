import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";

export const deploymentContracts: ApiContract[] = [
	{
		method: "POST",
		path: "/api/deploy",
		schema: {
			fields: {
				config: { type: "config" },
				targetId: { type: "string" },
				allTargets: { type: "boolean" },
			},
			description:
				"Use targetId from /api/targets or allTargets=true to execute saved settings. " +
				"Legacy string config requests retain explicit configured multi-target behavior.",
		},
		responseFields: ["operationId", "instanceId", "run", "ready"],
		cancelSupported: false,
	},
];
export const deploymentApi = (
	app: ApiApp,
	lifecycle: ServerLifecycle,
): void => {
	register(
		app,
		lifecycle,
		deploymentContracts[0],
		(input) => {
			const operationId = lifecycle.services.deployment.start(input);
			return { ...lifecycle.services.status(), operationId };
		},
		202,
	);
};
