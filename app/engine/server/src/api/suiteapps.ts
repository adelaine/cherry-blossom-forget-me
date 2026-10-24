import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";

export const suiteappContracts: ApiContract[] = [
    {
        method: "POST",
        path: "/api/settings",
        schema: {
            required: ["config"],
            fields: { config: { type: "config" } },
        },
        responseFields: ["config", "ready", "error"],
    },
    {
        method: "GET",
        path: "/api/targets",
        responseFields: [
            "instanceId",
            "targets[].id",
            "targets[].account",
            "targets[].url",
            "targets[].displayName",
        ],
    },
    {
        method: "GET",
        path: "/api/readiness",
        schema: {
            description: "Required target query parameter from /api/targets.",
        },
        responseFields: [
            "instanceId",
            "ready",
            "blockers[].code",
            "blockers[].message",
            "blockers[].capability",
            "blockers[].target",
        ],
    },
    {
        method: "POST",
        path: "/api/validate",
        schema: {
            required: ["config"],
            fields: {
                config: { type: "config" },
                targetId: { type: "string" },
            },
        },
        responseFields: ["valid", "ready", "blockers", "targets"],
    },
    {
        method: "POST",
        path: "/api/check",
        schema: {
            required: ["config"],
            fields: { config: { type: "config" } },
        },
        responseFields: ["config", "ready", "error"],
    },
];
export const suiteappsApi = (app: ApiApp, lifecycle: ServerLifecycle): void => {
    register(app, lifecycle, suiteappContracts[0], (input) => {
        lifecycle.services.configuration.save(input.config);
        return lifecycle.services.status();
    });
    register(app, lifecycle, suiteappContracts[1], () => ({
        instanceId: lifecycle.instanceId,
        targets: lifecycle.services.suiteapps.targets(),
    }));
    register(app, lifecycle, suiteappContracts[2], (_, c) => {
        const target = c.req.query("target");
        if (!target) lifecycle.services.suiteapps.select(target);
        const { ready, blockers } = lifecycle.services.suiteapps.readiness(
            undefined,
            target,
        );
        return { instanceId: lifecycle.instanceId, ready, blockers };
    });
    register(app, lifecycle, suiteappContracts[3], (input) => {
        const config = lifecycle.services.suiteapps.validate(input.config);
        const targets = lifecycle.services.suiteapps.targets(config);
        const { ready, blockers } = lifecycle.services.suiteapps.readiness(
            config,
            input.targetId,
        );
        return { valid: true, ready, blockers, targets };
    });
    register(app, lifecycle, suiteappContracts[4], (input) =>
        lifecycle.services.status(JSON.stringify(input.config)),
    );
};
