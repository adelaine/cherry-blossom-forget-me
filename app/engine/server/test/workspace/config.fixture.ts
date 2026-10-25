import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

export function withConfigFixture(action: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "suitecontainer-certificates-"));
	if (
		!resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
		!basename(directory).startsWith("suitecontainer-certificates-")
	) {
		throw new Error(
			"Fixture cleanup must stay inside its temporary directory.",
		);
	}
	try {
		writeFileSync(
			join(directory, "auth.json"),
			JSON.stringify({ "gitlab-token": "fixture-token" }),
		);
		action(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export const suiteapp = {
	url: "git@gitlab.eng.netsuite.com:team/project.git",
	directory: "project",
	branch: "release/1.0",
};
export const vms = [{ account: "12345", url: "scrumbox.netsuite.com" }];
