import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";

export const deploymentContracts: ApiContract[] = [{ method: "POST", path: "/api/deploy", schema: { fields: { config: { type: "config" }, targetId: { type: "string" } }, description: "New requests require targetId from /api/targets and execute the saved configuration for that target. Legacy string config requests retain explicit configured multi-target behavior." }, responseFields: ["operationId", "instanceId", "run", "ready"], cancelSupported: false }];
export function deploymentApi(app: ApiApp, lifecycle: ServerLifecycle): void {
    register(app, lifecycle, deploymentContracts[0], input => { const operationId = lifecycle.services.deployment.start(input); return { ...lifecycle.services.status(), operationId }; }, 202);
}
