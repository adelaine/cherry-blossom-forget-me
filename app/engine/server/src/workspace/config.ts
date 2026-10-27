import { readFileSync } from "node:fs";
import { readAuth } from "../common/auth.ts";

import type { Config } from "../common/config.ts";
const invalidConfig: (message: string) => never = (message) => {
	throw new Error(
		`${message} Update ${message.includes("credentials/auth.json") ? "credentials/auth.json" : "config/suitecontainer.json"} and run the start script again.`,
	);
};

export const gitlabHttpsUrl = (raw: unknown): string | null => {
	if (typeof raw !== "string") return null;
	let projectPath: string;
	const ssh = raw.match(/^git@gitlab\.eng\.netsuite\.com:([A-Za-z0-9._/-]+)$/i);
	if (ssh) {
		projectPath = ssh[1];
	} else {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return null;
		}
		if (
			parsed.protocol !== "https:" ||
			parsed.hostname !== "gitlab.eng.netsuite.com" ||
			parsed.port ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash
		)
			return null;
		projectPath = parsed.pathname.slice(1);
	}
	projectPath = projectPath.replace(/\.git$/i, "");
	if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(projectPath)) return null;
	return `https://gitlab.eng.netsuite.com/${projectPath}.git`;
};

export const validBranch = (branch: unknown): boolean => {
	return (
		typeof branch === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) &&
		!branch.includes("..") &&
		!branch.includes("//") &&
		!branch
			.split("/")
			.some(
				(part) =>
					part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
			)
	);
};

export const validateConfig = (
	value: unknown,
	requireDeploymentSettings = false,
): Config => {
	if (
		!value ||
		typeof value !== "object" ||
		!Array.isArray((value as Config).suiteapps)
	) {
		invalidConfig('The file needs a "suiteapps" list.');
	}
	const config = value as Config;
	if (
		config.status !== undefined &&
		(!config.status ||
			typeof config.status !== "object" ||
			Array.isArray(config.status) ||
			(config.status["deploy-start-ok"] !== undefined &&
				![0, 1].includes(config.status["deploy-start-ok"])))
	) {
		invalidConfig("Set status.deploy-start-ok to 0 or 1.");
	}
	if (
		config.status?.theme !== undefined &&
		!["light", "dark"].includes(config.status.theme)
	) {
		invalidConfig(
			'Set status.theme to "light" or "dark", or remove it to use the system theme.',
		);
	}
	if (config.suiteapps.length > 0) {
		if (!Array.isArray(config.vms) || config.vms.length === 0)
			invalidConfig('The file needs a nonempty "vms" list.');
		for (const [index, vm] of config.vms.entries()) {
			if (
				!vm ||
				typeof vm !== "object" ||
				Array.isArray(vm) ||
				typeof vm.account !== "string" ||
				!/^[A-Za-z0-9_-]+$/.test(vm.account) ||
				typeof vm.url !== "string" ||
				!/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(vm.url) ||
				!vm.url.endsWith(".netsuite.com")
			) {
				invalidConfig(
					`VM ${index + 1} needs an account ID and a NetSuite domain.`,
				);
			}
		}
	}
	if (
		requireDeploymentSettings &&
		config.authentication?.method !== "browser"
	) {
		const certs = config.certificates;
		if (
			!certs ||
			!(["public", "private"] as const).every(
				(key) =>
					typeof certs[key] === "string" &&
					certs[key].trim() &&
					!/[\r\n]/.test(certs[key]),
			)
		) {
			invalidConfig(
				"credentials/auth.json needs public and private certificate paths.",
			);
		}
		if (!/^[A-Za-z0-9_-]+$/.test(certs.id || "")) {
			invalidConfig("credentials/auth.json needs the NetSuite certificate ID.");
		}
	}

	const seen = new Set<string>();
	for (const [index, repo] of config.suiteapps.entries()) {
		if (
			!repo ||
			typeof repo !== "object" ||
			Array.isArray(repo) ||
			(!repo.localPath && !gitlabHttpsUrl(repo.url))
		) {
			invalidConfig(
				`SuiteApp ${index + 1} needs a localPath or a GitLab HTTPS or SSH URL from gitlab.eng.netsuite.com.`,
			);
		}
		if (
			typeof repo.directory !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo.directory) ||
			[".", ".."].includes(repo.directory) ||
			seen.has(repo.directory.toLowerCase())
		) {
			invalidConfig(
				`SuiteApp ${index + 1} needs a unique "directory" name without spaces or slashes.`,
			);
		}
		if (repo.branch !== undefined && !validBranch(repo.branch)) {
			invalidConfig(`SuiteApp ${index + 1} has an invalid "branch" name.`);
		}
		if (
			repo.localPath !== undefined &&
			(typeof repo.localPath !== "string" ||
				/[,\r\n\t]/.test(repo.localPath) ||
				(repo.localPath.length > 0 && !repo.localPath.trim()))
		) {
			invalidConfig(`SuiteApp ${index + 1} has an invalid "localPath".`);
		}
		if (repo.localPath && repo.branch !== undefined) {
			invalidConfig(
				`SuiteApp ${index + 1} cannot set both "localPath" and "branch".`,
			);
		}
		if (repo.url !== undefined && !gitlabHttpsUrl(repo.url)) {
			invalidConfig(`SuiteApp ${index + 1} has an invalid GitLab URL.`);
		}
		seen.add(repo.directory.toLowerCase());
	}
	return config;
};

export const readConfig = (
	path: string,
	requireDeploymentSettings = false,
	authPath = "/config/credentials/auth.json",
): Config => {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		invalidConfig("The JSON file could not be read or has a syntax error.");
	}
	const auth = readAuth(authPath);
	const config = validateConfig(value);
	config.certificates = auth["suitecloud-certificates"];
	config.authentication = auth["suitecloud-authentication"] ?? {
		method: "browser",
	};
	return validateConfig(config, requireDeploymentSettings);
};
