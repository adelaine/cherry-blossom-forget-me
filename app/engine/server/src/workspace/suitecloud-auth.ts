/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Vm } from "../common/config.ts";

/** Identify an account and domain without mixing credentials across targets. */
export function browserAccountKey(vm: Vm): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				vm.account.trim().toLowerCase(),
				vm.url.trim().toLowerCase(),
			]),
		)
		.digest("hex")
		.slice(0, 24);
}

/** Resolve the SDK installed with the CLI, without pinning its version. */
export function suitecloudSdk(): string {
	const directory = join(homedir(), ".suitecloud-sdk", "cli");
	const name = readdirSync(directory)
		.filter((file) => file.endsWith(".jar"))
		.sort()
		.at(-1);
	if (!name)
		throw new Error("SuiteCloud SDK is unavailable. Relaunch SuiteContainer.");
	return join(directory, name);
}

/** Keep browser credentials and their encryption key in the mounted private directory. */
export function browserEnvironment(
	directory = "/config/credentials",
): NodeJS.ProcessEnv {
	const home = join(directory, "suitecloud");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const path = join(home, "passkey");
	if (!existsSync(path))
		writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600 });
	chmodSync(path, 0o600);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		SUITECLOUD_FALLBACK_PASSKEY: readFileSync(path, "utf8").trim(),
	};
	delete env.SUITECLOUD_CI;
	delete env.SUITECLOUD_CI_PASSKEY;
	env.JAVA_TOOL_OPTIONS = `-Duser.home=${home}`;
	return env;
}
