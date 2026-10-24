import type { ServerLifecycle } from "../main.ts";
import { register, type ApiApp, type ApiContract } from "./operations.ts";

export const credentialContracts: ApiContract[] = [
    {
        method: "POST",
        path: "/api/credentials",
        schema: {
            fields: {
                config: { type: "config" },
                token: { type: "string" },
                public: { type: "string" },
                private: { type: "string" },
                id: { type: "string" },
            },
        },
        responseFields: ["config", "certificates", "ready"],
    },
    {
        method: "POST",
        path: "/api/generate",
        schema: { fields: { replace: { type: "boolean" } } },
        responseFields: ["certificates", "ready"],
        confirmation:
            "replace=true is required when certificates already exist; old generated files are replaced and certificate ID cleared.",
    },
    {
        method: "GET",
        path: "/api/certificate",
        responseFields: [],
        contentType: "application/x-pem-file",
    },
];
export const credentialsApi = (
    app: ApiApp,
    lifecycle: ServerLifecycle,
): void => {
    register(app, lifecycle, credentialContracts[0], (input) => {
        lifecycle.services.credentials.save(input);
        return lifecycle.services.status();
    });
    register(app, lifecycle, credentialContracts[1], (input) => {
        lifecycle.services.credentials.generate(input.replace);
        return lifecycle.services.status();
    });
    app.get("/api/certificate", (c) => {
        c.header("Content-Type", "application/x-pem-file");
        c.header("Content-Disposition", 'attachment; filename="public.pem"');
        return c.body(
            new Uint8Array(lifecycle.services.credentials.publicCertificate()),
        );
    });
};
