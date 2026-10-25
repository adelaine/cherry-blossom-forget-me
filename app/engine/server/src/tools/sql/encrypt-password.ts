import { emitKeypressEvents } from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { encryptSqlPassword } from "./password-crypto.ts";
import { SQL_PASSWORD_SALT } from "./settings.ts";

const hiddenPrompt = async (label: string): Promise<string> => {
	if (!process.stdin.isTTY || !process.stdout.isTTY)
		throw new Error(
			"Run this utility in a terminal, or use --stdin to read JSON from standard input.",
		);
	process.stdout.write(label);
	emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);
	process.stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const done = (error?: Error) => {
			process.stdin.removeListener("keypress", onKey);
			process.stdin.setRawMode(false);
			process.stdin.pause();
			process.stdout.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onKey = (
			text: string,
			key: { name?: string; ctrl?: boolean; meta?: boolean },
		) => {
			if (key.ctrl && key.name === "c") return done(new Error("Cancelled."));
			if (key.name === "return" || key.name === "enter") return done();
			if (key.name === "backspace") {
				value = Array.from(value).slice(0, -1).join("");
				return;
			}
			if (
				!key.ctrl &&
				!key.meta &&
				text &&
				Array.from(text).every((character) => {
					const code = character.charCodeAt(0);
					return code >= 0x20 && code !== 0x7f;
				})
			)
				value += text;
		};
		process.stdin.on("keypress", onKey);
	});
};

export const generateEncryptedPassword = async (
	args = process.argv.slice(2),
): Promise<void> => {
	if (args.some((arg) => arg !== "--stdin"))
		throw new Error(
			"Usage: node app/engine/server/src/tools/sql/encrypt-password.ts [--stdin]",
		);
	let sqlPassword: string, unlockPassword: string;
	if (args.includes("--stdin")) {
		// For automation only: {sqlPassword, unlockPassword}. Never log input.
		let input = "";
		for await (const chunk of process.stdin) {
			input += chunk;
			if (Buffer.byteLength(input) > 16384)
				throw new Error("Input is too large.");
		}
		let data: unknown;
		try {
			data = JSON.parse(input);
		} catch {
			throw new Error(
				"Expected JSON with sqlPassword and unlockPassword strings.",
			);
		}
		if (
			!data ||
			typeof data !== "object" ||
			typeof (data as Record<string, unknown>).sqlPassword !== "string" ||
			typeof (data as Record<string, unknown>).unlockPassword !== "string"
		)
			throw new Error(
				"Expected JSON with sqlPassword and unlockPassword strings.",
			);
		({ sqlPassword, unlockPassword } = data as {
			sqlPassword: string;
			unlockPassword: string;
		});
	} else {
		sqlPassword = await hiddenPrompt("Default SQL password (hidden): ");
		unlockPassword = await hiddenPrompt("Answer to password hint (hidden): ");
		if (
			(await hiddenPrompt("Confirm answer to password hint (hidden): ")) !==
			unlockPassword
		)
			throw new Error("Password hints do not match.");
	}
	const encrypted = await encryptSqlPassword(
		sqlPassword,
		unlockPassword,
		SQL_PASSWORD_SALT,
	);
	console.log(encrypted);
	if (!args.includes("--stdin"))
		console.log(
			"Save this encrypted string with your SQL credentials. Keep SQL_PASSWORD_SALT unchanged and the password hint separate.",
		);
};

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	generateEncryptedPassword().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
