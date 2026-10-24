import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";
export const sftpContracts: ApiContract[] = [
    {
        method: "POST",
        path: "/api/sftp",
        schema: {
            required: ["action"],
            fields: {
                action: {
                    type: "string",
                    enum: ["save", "start", "stop", "probe", "recreate"],
                },
                username: { type: "string" },
                port: { type: "number" },
                password: { type: "string" },
                path: { type: "string" },
                confirmReplace: { type: "boolean" },
            },
        },
        responseFields: ["sftp"],
        confirmation:
            "recreate requires confirmReplace=true and a replaceable target-side container.",
    },
];
export const sftpApi = (app: ApiApp, lifecycle: ServerLifecycle): void => {
    register(app, lifecycle, sftpContracts[0], async (input) => {
        await lifecycle.services.sftp.action(input);
        return lifecycle.services.status();
    });
};
