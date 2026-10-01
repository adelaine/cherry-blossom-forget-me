import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function downloadFailureMessage(output) {
    if (/TAR_BAD_ARCHIVE|TAR_ENTRY_INVALID/.test(output)) {
        return "Package download did not return a valid archive. A Banyan login page can cause this. Check that Banyan is connected and signed in, then run the launcher again.";
    }
    if (/\b(?:ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)\b/.test(output)) {
        return "Could not connect to the package registry. Check your network and Banyan connection, then run the launcher again.";
    }
    if (/\b(?:UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED)\b/.test(output)) {
        return "Could not verify the package registry certificate. Check your Banyan connection and company CA certificates, then run the launcher again.";
    }
    return "";
}

export function runNpm(args) {
    const child = spawn("npm", args, { stdio: ["inherit", "inherit", "pipe"] });
    let recentOutput = "";
    let failureMessage = "";
    let launchFailed = false;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
        if (failureMessage) return;
        recentOutput = (recentOutput + chunk).slice(-32_768);
        failureMessage = downloadFailureMessage(recentOutput);
        if (failureMessage) {
            // Stop npm retries when access fails or a login page replaces a download.
            console.error(`\n${failureMessage}`);
            child.kill();
        } else {
            process.stderr.write(chunk);
        }
    });
    child.on("error", (error) => {
        launchFailed = true;
        console.error(`Could not start npm: ${error.message}`);
    });
    child.on("close", (code) => {
        process.exitCode = failureMessage || launchFailed ? 1 : (code ?? 1);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    runNpm(process.argv.slice(2));
}
