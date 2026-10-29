/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cloneRepos } from "./clone.ts";
import { readConfig, validateConfig } from "./config.ts";
import { deployRepos } from "./deploy.ts";
import { verifyCertificates } from "./certificates.ts";
import { prepareToken, removeToken } from "./gitlab-token.ts";

/** Execute a private configuration snapshot under DeploymentService ownership. */
export function runDeploymentWorker(): number {
	if (!process.send || process.env.SUITECONTAINER_NONINTERACTIVE !== "1")
		throw new Error(
			"Deployment workers must be started by SuiteContainer's deployment service.",
		);
	const configPath = process.env.SUITECONTAINER_CONFIG;
	const authPath = process.env.SUITECONTAINER_AUTH;
	if (!configPath || !authPath)
		throw new Error(
			"The deployment service must supply configuration and credential snapshots.",
		);
	const config = readConfig(configPath, false, authPath);
	validateConfig(config, true);
	const privateKeyPath =
		config.authentication?.method !== "browser"
			? verifyCertificates(
					process.env.SUITECONTAINER_PUBLIC_KEY,
					process.env.SUITECONTAINER_PRIVATE_KEY,
				)
			: null;
	try {
		if (config.suiteapps.some((repo) => !repo.localPath))
			prepareToken(authPath);
		cloneRepos(config.suiteapps);
		deployRepos(config, privateKeyPath!);
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
		process.exitCode = runDeploymentWorker();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
