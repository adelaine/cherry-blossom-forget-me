export function authenticationError(
    output: string,
    project: string,
    domain: string,
): string {
    const details = output.trim();
    const tlsFailure =
        /fatal alert|SSLHandshakeException|PKIX|TLS handshake|unable to find valid certification path/i.test(
            details,
        );
    const trustFailure = /PKIX|unable to find valid certification path/i.test(
        details,
    );
    const lines = [
        `SuiteCloud authentication failed for ${project}.`,
        `Target: ${domain}`,
        "",
        "SuiteCloud reported:",
        details || "The CLI exited without an error message.",
        "",
        "What to check:",
    ];
    if (tlsFailure) {
        lines.push(
            "1. Check the VM url in suitecontainer.config.json. Use the actual scrumbox hostname, without https:// or a path.",
            `2. Connect to the required VPN and check that https://${domain} opens in your browser. The Podman container must also be able to reach it.`,
            trustFailure
                ? "3. Java could not validate the server certificate. Check the server certificate chain and install the required company CA certificates in the container's Java trust store."
                : "3. Check the scrumbox HTTPS service, any VPN/proxy TLS interception, and compatibility with the container's Java TLS settings. A server or proxy sent a fatal TLS alert; this message alone does not identify the cause.",
            "This TLS error does not establish that your SuiteCloud authentication certificate or certificate ID is wrong.",
        );
    } else {
        lines.push(
            "1. Check the VM account and url in suitecontainer.config.json.",
            "2. Check suitecloud-certificates.id in credentials/auth.json against the certificate uploaded to the target account.",
            "3. Confirm that the uploaded public certificate matches your private key and that its NetSuite mapping uses SuiteCloud Development Integration with an enabled entity and appropriate role.",
        );
    }
    lines.push(
        "Authentication did not complete. Fix the issue above and run the start script again.",
    );
    return lines.join("\n");
}
