import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cloneRepos, run } from "./step-clone.js";
import { readConfig } from "./step-config.js";
import { deployRepos } from "./step-deploy.js";
import {
    prepareCertificates,
    verifyCertificates,
} from "./step-certificates.js";
import { prepareToken, removeToken } from "./step-token.js";

export function main(args: string[] = process.argv.slice(2)): void {
    const validateOnly = args[0] === "--validate";
    const certificatePathsOnly = args[0] === "--certificate-paths";
    const deploy = args[0] === "--deploy";
    const prepareCertificatesOnly = args[0] === "--prepare-certificates";
    const configPath = validateOnly
        ? args[1]
        : "/config/suiteapps-to-install.json";
    const config = readConfig(configPath ?? "", certificatePathsOnly || deploy);

    if (config.suiteapps.length === 0 && !certificatePathsOnly) {
        console.log(
            "There are no SuiteApps to install in suiteapps-to-install.json.",
        );
        return;
    }
    if (validateOnly) {
        const label =
            config.suiteapps.length === 1 ? "SuiteApp is" : "SuiteApps are";
        console.log(`${config.suiteapps.length} ${label} listed and valid.`);
        return;
    }
    if (prepareCertificatesOnly) {
        const generated = prepareCertificates(config);
        if (generated) {
            console.log(
                "Generated .ssh/public.pem and .ssh/private.pem in the repository root.",
            );
            console.log(
                "Upload .ssh/public.pem in NetSuite OAuth 2.0 Client Credentials Setup for SuiteCloud Development Integration, then set certificates.id in suiteapps-to-install.json to the assigned certificate ID and run the start script again.",
            );
        }
        return;
    }
    if (certificatePathsOnly) {
        console.log(config.certificates!.public);
        console.log(config.certificates!.private);
        return;
    }

    const privateKeyPath = deploy ? verifyCertificates() : null;
    try {
        prepareToken();
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
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
