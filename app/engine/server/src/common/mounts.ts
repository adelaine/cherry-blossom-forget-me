/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { posix, win32 } from "node:path";
import type { SshSettings } from "./ssh.ts";

export interface MountRecord {
	hostRoot: string;
	platform: string;
	local: Record<string, string>;
	certificates: Record<string, string>;
	sftp?: string;
	ssh?: SshSettings;
}

export const hostPath = (record: MountRecord, path: string): string => {
	const paths = record.platform === "win32" ? win32 : posix;
	const resolved = paths.resolve(record.hostRoot, path);
	return record.platform === "win32" ? resolved.toLowerCase() : resolved;
};

export const credentialPath = (
	record: MountRecord,
	path: string,
): string | null => {
	const paths = record.platform === "win32" ? win32 : posix;
	const relative = paths.relative(
		paths.resolve(record.hostRoot, "credentials"),
		paths.resolve(record.hostRoot, path),
	);
	if (
		relative &&
		!relative.startsWith(`..${paths.sep}`) &&
		relative !== ".." &&
		!paths.isAbsolute(relative)
	) {
		return posix.join("/config/credentials", ...relative.split(paths.sep));
	}
	return record.certificates[hostPath(record, path)] ?? null;
};
