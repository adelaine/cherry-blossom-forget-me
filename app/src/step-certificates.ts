import { spawnSync } from "node:child_process";
import {
    createPrivateKey,
    createPublicKey,
    X509Certificate,
} from "node:crypto";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./step-config.js";

export function verifyCertificates(
    publicPath = "/config/certs/public.pem",
    privatePath = "/config/certs/private.pem",
): string {
    if (!existsSync(publicPath) || !existsSync(privatePath)) {
        throw new Error(
            "Certificate files were not mounted. Check their paths in suiteapps-to-install.json.",
        );
    }
    try {
        const publicKey = new X509Certificate(
            readFileSync(publicPath),
        ).publicKey.export({ type: "spki", format: "der" });
        const privateKey = createPublicKey(
            createPrivateKey(readFileSync(privatePath)),
        ).export({ type: "spki", format: "der" });
        if (!publicKey.equals(privateKey)) throw new Error("mismatch");
    } catch {
        throw new Error(
            "The public and private certificate files do not match or cannot be read.",
        );
    }
    return privatePath;
}

export function prepareCertificates(
    config: Config,
    directory = "/config/.ssh",
    configPath = "/config/suiteapps-to-install.json",
): boolean {
    const certificates = config.certificates;
    const paths = [certificates?.public, certificates?.private];
    const missing = paths.map(
        (path) => path == null || (typeof path === "string" && !path.trim()),
    );
    if (missing.every((value) => !value)) return false;
    if (!missing.every(Boolean)) {
        throw new Error(
            "Specify both public and private certificate paths, or leave both empty to generate certificates.",
        );
    }

    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const publicPath = join(directory, "public.pem");
    const privatePath = join(directory, "private.pem");
    const publicExists = existsSync(publicPath);
    const privateExists = existsSync(privatePath);
    if (publicExists !== privateExists) {
        throw new Error(
            "The .ssh folder contains only one certificate file. Restore the matching pair before continuing.",
        );
    }

    const generated = !publicExists;
    if (generated) {
        const created: string[] = [];
        try {
            for (const [path, mode] of [
                [privatePath, 0o600],
                [publicPath, 0o644],
            ] as const) {
                writeFileSync(path, "", { flag: "wx", mode });
                created.push(path);
            }
            const result = spawnSync(
                "openssl",
                [
                    "req",
                    "-new",
                    "-x509",
                    "-newkey",
                    "rsa:4096",
                    "-sha256",
                    "-nodes",
                    "-days",
                    "365",
                    "-subj",
                    "/CN=SuiteCloud Development",
                    "-keyout",
                    privatePath,
                    "-out",
                    publicPath,
                ],
                { encoding: "utf8" },
            );
            if (result.error) throw result.error;
            if (result.status !== 0)
                throw new Error("OpenSSL could not generate the certificates.");
            verifyCertificates(publicPath, privatePath);
        } catch (error) {
            for (const path of created) rmSync(path, { force: true });
            throw error;
        }
    } else {
        verifyCertificates(publicPath, privatePath);
    }
    chmodSync(privatePath, 0o600);
    config.certificates = {
        ...certificates,
        public: ".ssh/public.pem",
        private: ".ssh/private.pem",
        id: generated ? "" : (certificates?.id ?? ""),
    };
    writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n");
    return generated;
}
