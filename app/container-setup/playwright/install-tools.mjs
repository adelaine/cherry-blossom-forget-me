/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

// Monthly releases are retained for two years; update the version and checksums together.
const release = "autobuild-2026-09-30-13-08";
const version = "n9.0.2-17-g2a571b6068";
const builds = {
	x64: {
		platform: "linux64",
		sha256: "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269",
	},
	arm64: {
		platform: "linuxarm64",
		sha256: "91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46",
	},
};
const build = builds[process.arch];
if (process.platform !== "linux" || !build) {
	throw new Error(
		`Unsupported browser runner platform: ${process.platform}/${process.arch}`,
	);
}
const filename = `ffmpeg-${version}-${build.platform}-gpl-9.0.tar.xz`;
const url = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${release}/${filename}`;
const directory = mkdtempSync(join(tmpdir(), "suitecontainer-ffmpeg-"));
try {
	console.log(`Installing full FFmpeg ${version} for ${process.arch}...`);
	const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
	if (!response.ok) {
		throw new Error(
			`FFmpeg download failed (${response.status}). Check access to GitHub release downloads.`,
		);
	}
	const archive = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(archive).digest("hex") !== build.sha256) {
		throw new Error(
			"FFmpeg archive checksum mismatch. The downloaded binaries were not installed.",
		);
	}
	const archivePath = join(directory, "ffmpeg.tar.xz");
	writeFileSync(archivePath, archive);
	const extracted = spawnSync("tar", ["-xJf", archivePath, "-C", directory], {
		stdio: "inherit",
	});
	if (extracted.error) throw extracted.error;
	if (extracted.status !== 0)
		throw new Error("Could not extract the verified FFmpeg archive.");
	const root = join(
		directory,
		readdirSync(directory).find((name) => name.startsWith("ffmpeg-")),
	);
	for (const binary of ["ffmpeg", "ffprobe"]) {
		const target = join("/usr/local/bin", binary);
		copyFileSync(join(root, "bin", binary), target);
		chmodSync(target, 0o755);
	}
	const licenses = "/usr/local/share/licenses/suitecontainer-ffmpeg";
	mkdirSync(licenses, { recursive: true });
	copyFileSync(join(root, "LICENSE.txt"), join(licenses, "LICENSE.txt"));
	writeFileSync(
		join(licenses, "release.json"),
		`${JSON.stringify({ url, sha256: build.sha256 }, null, 2)}\n`,
	);
	symlinkSync(
		chromium.executablePath(),
		"/usr/local/bin/suitecontainer-chromium",
	);
} finally {
	rmSync(directory, { recursive: true, force: true });
}
