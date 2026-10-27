/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = "/opt/suitecontainer-playwright";
const model = join(root, "kokoro-model");
const licenses = "/usr/local/share/licenses/suitecontainer-kokoro";
const revision = "1939ad2a8e416c0acfeecc08a694d14ef25f2231";
const repository = "onnx-community/Kokoro-82M-v1.0-ONNX";
const voice = "bf_isabella";
const sources = [];

// Update the model revision and all checksums together.
for (const [filename, sha256, destination] of [
	[
		"config.json",
		"df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f",
		model,
	],
	[
		"tokenizer.json",
		"77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34",
		model,
	],
	[
		"tokenizer_config.json",
		"be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20",
		model,
	],
	[
		"onnx/model_quantized.onnx",
		"fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478",
		model,
	],
	[
		"voices/bf_isabella.bin",
		"3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f",
		join(root, "node_modules/kokoro-js"),
	],
]) {
	const url = `https://huggingface.co/${repository}/resolve/${revision}/${filename}`;
	console.log(`Installing Kokoro asset ${filename}...`);
	const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
	if (!response.ok)
		throw new Error(
			`Kokoro asset download failed (${response.status}): ${filename}`,
		);
	const contents = Buffer.from(await response.arrayBuffer());
	if (createHash("sha256").update(contents).digest("hex") !== sha256) {
		throw new Error(`Kokoro asset checksum mismatch: ${filename}`);
	}
	const target = join(destination, filename);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
	sources.push({ url, sha256 });
}

mkdirSync(licenses, { recursive: true });
copyFileSync(
	join(root, "node_modules/kokoro-js/LICENSE"),
	join(licenses, "LICENSE"),
);
writeFileSync(
	join(licenses, "release.json"),
	`${JSON.stringify({ runtime: "kokoro-js@1.2.1", model: "Kokoro-82M-v1.0", revision, voice, sources }, null, 2)}\n`,
);
