import { createHash } from "node:crypto";
import { validateConfig, type Config, type Vm } from "../step-config.ts";
import { hasLocalCheckout } from "../step-clone.ts";
import { credentialPath, hostPath, type MountRecord } from "../web-mounts.ts";
import type { Auth } from "../step-auth.ts";
import { configObject, type ConfigurationService } from "./configuration.ts";
import type { CredentialsService } from "./credentials.ts";
import { message, ServiceError } from "./errors.ts";

export interface Target {
    id: string;
    account: string;
    url: string;
    displayName: string;
}
export interface Blocker {
    code: string;
    message: string;
    capability: string;
    target?: string;
}
export const mountChanges = (
    config: Config,
    auth: Auth,
    record: MountRecord,
    allowUnusedExternal = false,
): boolean => {
    const local = Object.fromEntries(
        config.suiteapps
            .filter((repo) => repo.localPath)
            .map((repo) => [repo.directory, hostPath(record, repo.localPath!)]),
    );
    const names = new Set([
        ...Object.keys(local),
        ...Object.keys(record.local),
    ]);
    if ([...names].some((name) => local[name] !== record.local[name]))
        return true;
    const usedExternal = new Set<string>();
    const missing = ["public", "private"].some((key) => {
        const path =
            auth["suitecloud-certificates"]?.[key as "public" | "private"];
        if (
            typeof path === "string" &&
            record.certificates[hostPath(record, path)]
        )
            usedExternal.add(hostPath(record, path));
        return (
            typeof path === "string" &&
            !!path.trim() &&
            !credentialPath(record, path)
        );
    });
    return (
        missing ||
        (!allowUnusedExternal &&
            Object.keys(record.certificates).some(
                (path) => !usedExternal.has(path),
            ))
    );
};

export class SuiteAppsService {
    readonly configuration: ConfigurationService;
    readonly credentials: CredentialsService;
    constructor(
        configuration: ConfigurationService,
        credentials: CredentialsService,
    ) {
        this.configuration = configuration;
        this.credentials = credentials;
    }
    validate(value: unknown): Config {
        return validateConfig(
            configObject(value),
            false,
            this.credentials.read(),
        );
    }
    targets(value: unknown = this.configuration.read()): Target[] {
        const config = configObject(value);
        const vms = config.vms;
        if (!Array.isArray(vms))
            throw new Error('The file needs a "vms" list.');
        const seen = new Set<string>();
        return vms.map((vm: Vm) => {
            if (
                !vm ||
                typeof vm.account !== "string" ||
                typeof vm.url !== "string"
            )
                throw new Error("Each target needs an account and URL.");
            const account = vm.account.trim();
            const url = vm.url
                .trim()
                .replace(/^https?:\/\//i, "")
                .replace(/\/+$/, "")
                .toLowerCase();
            const id = createHash("sha256")
                .update(JSON.stringify([account.toLowerCase(), url]))
                .digest("hex")
                .slice(0, 24);
            if (seen.has(id))
                throw new ServiceError(
                    "ambiguous_target",
                    "Duplicate account and target URL identities must be removed before choosing a target.",
                );
            seen.add(id);
            return { id, account, url, displayName: `${account} — ${url}` };
        });
    }
    select(
        targetId: unknown,
        value: unknown = this.configuration.read(),
    ): Config {
        if (typeof targetId !== "string" || !targetId)
            throw new ServiceError(
                "target_required",
                "Choose an explicit targetId from /api/targets.",
            );
        const config = configObject(value);
        const targets = this.targets(config);
        const selected = targets.findIndex((target) => target.id === targetId);
        if (selected < 0)
            throw new ServiceError(
                "target_not_found",
                "The selected target is no longer configured.",
                404,
            );
        return { ...config, vms: [(config.vms as Vm[])[selected]] } as Config;
    }
    readiness(value: unknown = this.configuration.read(), targetId?: unknown) {
        try {
            const selected =
                targetId === undefined ? value : this.select(targetId, value);
            const auth = this.credentials.read();
            const config = this.validate(selected);
            this.targets(config);
            if (!config.suiteapps.length)
                throw new ServiceError(
                    "suiteapps_missing",
                    "Add at least one SuiteApp before deploying.",
                );
            if (config.PM_MODE) {
                const missing = config.suiteapps.find(
                    (repo) =>
                        !repo.localPath && !hasLocalCheckout(repo.directory),
                );
                if (missing)
                    throw new ServiceError(
                        "checkout_missing",
                        `Place a local checkout in repos/${missing.directory} or set its localPath in Settings before deploying.`,
                    );
            }
            if (
                mountChanges(
                    config,
                    auth,
                    this.configuration.mounts,
                    this.credentials.shared.generatedCertificates,
                )
            )
                throw new ServiceError(
                    "restart_required",
                    "Relaunch required: local repositories or certificate paths need different mounts.",
                );
            const cert = this.credentials.certificateState(auth);
            if (cert.error)
                throw new ServiceError("certificate_required", cert.error);
            config.certificates = auth["suitecloud-certificates"];
            validateConfig(config, true);
            if (
                !config.PM_MODE &&
                config.suiteapps.some((repo) => !repo.localPath) &&
                !auth["gitlab-token"]?.trim()
            )
                throw new ServiceError(
                    "gitlab_token_required",
                    "Paste a GitLab token in Credentials and click Save credentials to copy SuiteApps from GitLab.",
                );
            const blockers: Blocker[] = [];
            if (this.configuration.operations.restartPending)
                blockers.push({
                    code: "service_restart_pending",
                    message: this.configuration.operations.restartPending,
                    capability: "deployment",
                });
            if (this.configuration.operations.busy())
                blockers.push({
                    code: "operation_conflict",
                    message: "Another operation is running.",
                    capability: "deployment",
                });
            return {
                ready: !blockers.length,
                error: blockers[0]?.message ?? "",
                blockers,
                config,
                auth,
                cert,
            };
        } catch (error) {
            const code =
                error instanceof ServiceError
                    ? error.code
                    : /certificate ID/.test(message(error))
                      ? "certificate_registration_required"
                      : "invalid_configuration";
            return {
                ready: false,
                error: message(error),
                blockers: [
                    {
                        code,
                        message: message(error),
                        capability: "deployment",
                        ...(typeof targetId === "string"
                            ? { target: targetId }
                            : {}),
                    },
                ] as Blocker[],
            };
        }
    }
}
