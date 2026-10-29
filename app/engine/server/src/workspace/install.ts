import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cloneRepos, run } from "./clone.ts";
import { readConfig } from "./config.ts";
import { prepareCertificates } from "./certificates.ts";
import { deployFromApi } from "./deployment-client.ts";
import { prepareToken, removeToken } from "./gitlab-token.ts";
import { launchMounts, prepareConfiguration } from "./launch.ts";
import { prepareWebMounts, webPathRequests, webSshTarget } from "./mounts.ts";
import { startWebServer } from "../main.ts";

export const main = (
	args: string[] = process.argv.slice(2),
): number | Promise<number> => {
	if (args[0] === "--deploy") return deployFromApi(args.slice(1));
	if (args[0] === "--serve") {
		startWebServer();
		return 0;
	}
	if (args[0] === "--web-ssh-target") {
		console.log(webSshTarget("/project"));
		return 0;
	}
	if (args[0] === "--web-mounts" || args[0] === "--web-paths") {
		const hostRoot = process.env.SUITECONTAINER_HOST_ROOT;
		if (!hostRoot)
			throw new Error("The launcher must supply SUITECONTAINER_HOST_ROOT.");
		const platform = process.env.SUITECONTAINER_HOST_PLATFORM ?? "linux";
		console.log(
			(args[0] === "--web-mounts" ? prepareWebMounts : webPathRequests)(
				"/project",
				hostRoot,
				platform,
			).join("\n"),
		);
		return 0;
	}
	const prepareLaunch = args[0] === "--prepare-launch";
	const launchMountsOnly = args[0] === "--launch-mounts";
	const projectRoot = "/project";
	if (prepareLaunch && prepareConfiguration(projectRoot)) return 10;
	const validateOnly = args[0] === "--validate";
	const certificatePathsOnly = args[0] === "--certificate-paths";
	const prepareCertificatesOnly =
		args[0] === "--prepare-certificates" || prepareLaunch;
	const localPathsOnly = args[0] === "--local-paths";
	const configPath = validateOnly
		? args[1]
		: prepareLaunch || launchMountsOnly
			? join(projectRoot, "config/suitecontainer.json")
			: (process.env.SUITECONTAINER_CONFIG ?? "/config/suitecontainer.json");
	const authPath =
		prepareLaunch || launchMountsOnly
			? join(projectRoot, "credentials/auth.json")
			: (process.env.SUITECONTAINER_AUTH ?? "/config/credentials/auth.json");
	const config = readConfig(
		configPath ?? "",
		certificatePathsOnly || launchMountsOnly,
		authPath,
	);

	if (launchMountsOnly) {
		const hostRoot = process.env.SUITECONTAINER_HOST_ROOT;
		if (!hostRoot)
			throw new Error("The launcher must supply SUITECONTAINER_HOST_ROOT.");
		console.log(
			launchMounts(
				config,
				hostRoot,
				process.env.SUITECONTAINER_HOST_PLATFORM ?? "linux",
			).join("\n"),
		);
		return 0;
	}

	if (localPathsOnly) {
		for (const repo of config.suiteapps) {
			if (repo.localPath) console.log(`${repo.directory}\t${repo.localPath}`);
		}
		return 0;
	}

	if (config.suiteapps.length === 0 && !certificatePathsOnly) {
		console.log(
			"There are no SuiteApps to install in config/suitecontainer.json.",
		);
		return prepareCertificatesOnly ? 10 : 0;
	}
	if (validateOnly) {
		const label =
			config.suiteapps.length === 1 ? "SuiteApp is" : "SuiteApps are";
		console.log(`${config.suiteapps.length} ${label} listed and valid.`);
		return 0;
	}
	if (prepareCertificatesOnly) {
		const generated = prepareLaunch
			? prepareCertificates(config, join(projectRoot, "credentials"), authPath)
			: prepareCertificates(config);
		if (generated) {
			console.log(
				"Generated credentials/public.pem and credentials/private.pem in SuiteContainer home.",
			);
			console.log(
				"Upload credentials/public.pem in NetSuite OAuth 2.0 Client Credentials Setup for SuiteCloud Development Integration, then set suitecloud-certificates.id in credentials/auth.json to the assigned certificate ID and run the start script again.",
			);
			// The launchers treat this status as a successful stop for registration.
			return 10;
		}
		if (prepareLaunch)
			mkdirSync(join(projectRoot, "repos"), { recursive: true });
		return 0;
	}
	if (certificatePathsOnly) {
		console.log(config.certificates!.public);
		console.log(config.certificates!.private);
		return 0;
	}

	try {
		if (config.suiteapps.some((repo) => !repo.localPath))
			prepareToken(authPath);
		cloneRepos(config.suiteapps);
		console.log("Ready. Type exit when you are done.");
		run("bash", []);
	} finally {
		removeToken();
	}
	return 0;
};

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
