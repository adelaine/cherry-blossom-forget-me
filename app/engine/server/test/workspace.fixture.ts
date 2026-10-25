/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create the filesystem state shared by application and transport tests. */
export function createWorkspaceFixture(
	config: Record<string, unknown> = {
		suiteapps: [],
		vms: [{ account: "000071", url: "" }],
	},
) {
	const root = mkdtempSync(join(tmpdir(), "suitecontainer-server-test-"));
	const credentials = join(root, "credentials");
	const configPath = join(root, "suitecontainer.json");
	const authPath = join(credentials, "auth.json");
	mkdirSync(credentials);
	writeFileSync(configPath, JSON.stringify(config));
	writeFileSync(authPath, "{}");
	writeFileSync(
		join(credentials, "web-mounts.json"),
		JSON.stringify({
			hostRoot: "/project",
			platform: "linux",
			local: {},
			certificates: {},
		}),
	);
	return {
		root,
		credentials,
		configPath,
		authPath,
		close() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
