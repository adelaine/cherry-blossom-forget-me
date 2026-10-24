import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";
export const sqlContracts: ApiContract[] = [{ method: "POST", path: "/api/sql", schema: { required: ["sql", "account", "database"], fields: { config: { type: "config" }, targetId: { type: "string" }, password: { type: "string" }, unlock: { type: "string" }, sql: { type: "string" }, account: { type: "string" }, database: { type: "string" } }, description: "Provide targetId or legacy config, SQL request fields, and exactly one of password or unlock." }, responseFields: ["operationId", "instanceId", "sql"], cancelSupported: false }];
export function sqlApi(app: ApiApp, lifecycle: ServerLifecycle): void {
    register(app, lifecycle, sqlContracts[0], async input => { const operationId = await lifecycle.services.sql.start(input); return { ...lifecycle.services.status(input.config ? JSON.stringify(input.config) : undefined), operationId }; }, 202);
}
