import { readFileSync } from "node:fs";

export type Auth = {
    "gitlab-token"?: string;
    "suitecloud-certificates"?: { public: string; private: string; id: string };
};

export function readAuth(path = "/config/credentials/auth.json"): Auth {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error(
            "Cannot read credentials/auth.json. Create it from credentials/auth.example.json and check its JSON syntax.",
        );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("credentials/auth.json must contain an object.");
    }
    const auth = value as Auth;
    if (
        auth["gitlab-token"] !== undefined &&
        typeof auth["gitlab-token"] !== "string"
    ) {
        throw new Error(
            "Set gitlab-token to a string in credentials/auth.json.",
        );
    }
    if (
        auth["suitecloud-certificates"] !== undefined &&
        (!auth["suitecloud-certificates"] ||
            typeof auth["suitecloud-certificates"] !== "object" ||
            Array.isArray(auth["suitecloud-certificates"]) ||
            !["public", "private", "id"].every(
                (key) =>
                    typeof (
                        auth["suitecloud-certificates"] as Record<
                            string,
                            unknown
                        >
                    )[key] === "string",
            ))
    ) {
        throw new Error(
            "Set suitecloud-certificates.public, suitecloud-certificates.private, and suitecloud-certificates.id to strings in credentials/auth.json.",
        );
    }
    return auth;
}
