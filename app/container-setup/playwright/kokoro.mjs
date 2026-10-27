#!/usr/bin/env node
/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { env, RawAudio } from "@huggingface/transformers";
import { KokoroTTS, TextSplitterStream } from "kokoro-js";

async function main() {
	const { values } = parseArgs({
		options: {
			help: { type: "boolean", short: "h" },
			output_file: { type: "string", short: "f" },
			voice: { type: "string" },
			speed: { type: "string", default: "1" },
		},
	});
	if (values.help) {
		console.log(`Usage: kokoro --output_file narration.wav [--voice bf_isabella] [--speed 1] < narration.txt

Reads UTF-8 text from stdin and writes a 24 kHz WAV using the bundled local Kokoro model.
KOKORO_MODEL selects the model directory; KOKORO_VOICE defaults to bf_isabella (Isabella, British English).`);
		return;
	}
	if (!values.output_file) throw new Error("--output_file is required.");
	const speed = Number(values.speed);
	if (!Number.isFinite(speed) || speed <= 0)
		throw new Error("--speed must be a positive number.");
	const text = readFileSync(0, "utf8").trim();
	if (!text) throw new Error("Narration text on stdin must not be empty.");

	// Synthesis must never fetch a model or tokenizer at runtime.
	env.allowRemoteModels = false;
	env.allowLocalModels = true;
	env.localModelPath = "";
	env.useFSCache = false;
	const model =
		process.env.KOKORO_MODEL || "/opt/suitecontainer-playwright/kokoro-model";
	const voice = values.voice || process.env.KOKORO_VOICE || "bf_isabella";
	const tts = await KokoroTTS.from_pretrained(model, {
		dtype: "q8",
		device: "cpu",
	});
	try {
		const chunks = [];
		let length = 0;
		const sentences = new TextSplitterStream();
		sentences.push(text);
		sentences.close();
		for await (const { audio, phonemes } of tts.stream(sentences, {
			voice,
			speed,
		})) {
			const { input_ids } = tts.tokenizer(phonemes, { truncation: false });
			if (input_ids.dims.at(-1) > 512) {
				throw new Error(
					"A narration sentence is too long. Split it into shorter sentences before synthesis.",
				);
			}
			chunks.push(audio.audio);
			length += audio.audio.length;
		}
		if (!length) throw new Error("Kokoro did not generate audio.");
		const samples = new Float32Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			samples.set(chunk, offset);
			offset += chunk.length;
		}
		await new RawAudio(samples, 24_000).save(values.output_file);
		console.log(values.output_file);
	} finally {
		await tts.model.dispose();
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
