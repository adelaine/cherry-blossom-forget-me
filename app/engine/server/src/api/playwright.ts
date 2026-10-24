import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";
export const playwrightContracts: ApiContract[] = [
    {
        method: "POST",
        path: "/api/playwright/run",
        schema: {
            fields: {
                config: { type: "config" },
                targetId: { type: "string" },
            },
            description:
                "Provide targetId or legacy config with enabled Playwright project settings.",
        },
        responseFields: ["operationId", "instanceId", "playwright"],
        cancelSupported: true,
    },
    {
        method: "POST",
        path: "/api/playwright/cancel",
        responseFields: ["playwright"],
        cancelSupported: true,
    },
];
export const playwrightApi = (
    app: ApiApp,
    lifecycle: ServerLifecycle,
): void => {
    register(
        app,
        lifecycle,
        playwrightContracts[0],
        async (input) => {
            const operationId =
                await lifecycle.services.playwright.start(input);
            return { ...lifecycle.services.status(), operationId };
        },
        202,
    );
    register(app, lifecycle, playwrightContracts[1], async () => {
        await lifecycle.services.playwright.cancel();
        return lifecycle.services.status();
    });
};
