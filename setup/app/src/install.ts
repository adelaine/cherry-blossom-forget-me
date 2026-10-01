import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cloneRepos, run } from "./step-clone.ts";
import { readConfig } from "./step-config.ts";
import { deployRepos } from "./step-deploy.ts";
import {
    prepareCertificates,
    verifyCertificates,
} from "./step-certificates.ts";
import { prepareToken, removeToken } from "./step-token.ts";

export function main(args: string[] = process.argv.slice(2)): number {
    const validateOnly = args[0] === "--validate";
    const certificatePathsOnly = args[0] === "--certificate-paths";
    const deploy = args[0] === "--deploy";
    const prepareCertificatesOnly = args[0] === "--prepare-certificates";
    const localPathsOnly = args[0] === "--local-paths";
    const configPath = validateOnly
        ? args[1]
        : "/config/suitecontainer.config.json";
    const config = readConfig(configPath ?? "", certificatePathsOnly || deploy);

    if (localPathsOnly) {
        for (const repo of config.suiteapps) {
            if (repo.localPath)
                console.log(`${repo.directory}\t${repo.localPath}`);
        }
        return 0;
    }

    if (config.suiteapps.length === 0 && !certificatePathsOnly) {
        console.log(
            "There are no SuiteApps to install in suitecontainer.config.json.",
        );
        return 0;
    }
    if (validateOnly) {
        const label =
            config.suiteapps.length === 1 ? "SuiteApp is" : "SuiteApps are";
        console.log(`${config.suiteapps.length} ${label} listed and valid.`);
        return 0;
    }
    if (prepareCertificatesOnly) {
        const generated = prepareCertificates(config);
        if (generated) {
            console.log(
                "Generated credentials/public.pem and credentials/private.pem in the repository root.",
            );
            console.log(
                "Upload credentials/public.pem in NetSuite OAuth 2.0 Client Credentials Setup for SuiteCloud Development Integration, then set suitecloud-certificates.id in credentials/auth.json to the assigned certificate ID and run the start script again.",
            );
            // The launchers treat this status as a successful stop for registration.
            return 10;
        }
        return 0;
    }
    if (certificatePathsOnly) {
        console.log(config.certificates!.public);
        console.log(config.certificates!.private);
        return 0;
    }

    const privateKeyPath = deploy ? verifyCertificates() : null;
    try {
        if (config.suiteapps.some((repo) => !repo.localPath)) prepareToken();
        cloneRepos(config.suiteapps);
        if (deploy) {
            deployRepos(config, privateKeyPath!);
        } else {
            console.log("Ready. Type exit when you are done.");
            run("bash", []);
        }
    } finally {
        removeToken();
    }
    return 0;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
