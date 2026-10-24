import type { Context, Hono } from "hono";
import type { ServerLifecycle } from "../main.ts";
import { configObject } from "../services/configuration.ts";
import { ServiceError } from "../services/errors.ts";

export type RequestSchema = { required?: string[]; fields?: Record<string, { type?: "string" | "number" | "boolean" | "config"; enum?: unknown[] }>; description?: string };
export type ApiContract = { method: "GET" | "POST"; path: string; schema?: RequestSchema; responseFields: string[]; contentType?: string; cancelSupported?: boolean; confirmation?: string };
export type ApiApp = Hono<{ Variables: { input: Record<string, unknown> } }>;
export function parseSchema(schema: RequestSchema | undefined, input: Record<string, unknown>): Record<string, unknown> {
    if (!schema) return input;
    const normalized = { ...input };
    // Both existing stringified configuration and object configuration enter the same validator.
    normalized.__legacyConfig = typeof input.config === "string";
    if (input.config !== undefined) normalized.config = configObject(input.config);
    for (const field of schema.required ?? []) if (normalized[field] === undefined) throw new ServiceError("missing_input", `Enter ${field}.`, 400, false, { field });
    for (const [field, rule] of Object.entries(schema.fields ?? {})) {
        const value = normalized[field]; if (value === undefined) continue;
        if (rule.type && rule.type !== "config" && typeof value !== rule.type) throw new ServiceError("invalid_input", `Enter a valid ${field}.`, 400, false, { field });
        if (rule.enum && !rule.enum.includes(value)) throw new ServiceError("invalid_input", `Choose a supported ${field}.`, 400, false, { field });
    }
    return normalized;
}
export function register(app: ApiApp, lifecycle: ServerLifecycle, contract: ApiContract, action: (input: Record<string, unknown>, c: Context) => unknown | Promise<unknown>, status = 200): void {
    const handler = async (c: Context) => {
        const input = parseSchema(contract.schema, c.get("input") ?? {});
        const execute = async () => ({ status, value: await action(input, c) });
        const result = contract.method === "POST" ? await lifecycle.operations.idempotent(c.req.header("Idempotency-Key"), c.req.path, input, execute) : await execute();
        return c.json(result.value as object, result.status as 200);
    };
    if (contract.method === "POST") app.post(contract.path, handler); else app.get(contract.path, handler);
}

export const operationContracts: ApiContract[] = [
    { method: "GET", path: "/api/operations/:id", responseFields: ["id", "instanceId", "kind", "targets", "state", "created", "started", "finished", "cancelSupported", "result", "error"] },
    { method: "GET", path: "/api/operations/:id/logs", schema: { description: "Optional cursor query parameter from the preceding response." }, responseFields: ["id", "instanceId", "log", "nextCursor", "truncated"] },
    { method: "POST", path: "/api/operations/:id/cancel", responseFields: ["id", "state"], cancelSupported: true },
];
export function operationsApi(app: ApiApp, lifecycle: ServerLifecycle): void {
    register(app, lifecycle, operationContracts[0], (_, c) => lifecycle.operations.get(c.req.param("id")!));
    register(app, lifecycle, operationContracts[1], (_, c) => lifecycle.operations.logs(c.req.param("id")!, c.req.query("cursor")));
    register(app, lifecycle, operationContracts[2], (_, c) => lifecycle.operations.cancel(c.req.param("id")!));
}
