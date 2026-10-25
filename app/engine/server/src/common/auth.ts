import { readFileSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface Auth {
	"suitecloud-authentication"?: {
		method: "browser" | "certificates";
		accounts?: Record<
			string,
			{
				authId: string;
				sdkVersion: string;
				company: string;
				role: string;
				account: string;
				url: string;
			}
		>;
	};
	"gitlab-token"?: string;
	sftp?: { port: number; username: string; password: string; path?: string };
	"suitecloud-certificates"?: { public: string; private: string; id: string };
}

export const readAuth = (path = "/config/credentials/auth.json"): Auth => {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(
			"Cannot read credentials/auth.json. Create it from credentials/auth.example.json and check its JSON syntax.",
		);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("credentials/auth.json must contain an object.");
	}
	const auth = value as Auth;
	if (
		auth.sftp !== undefined &&
		(!auth.sftp ||
			typeof auth.sftp !== "object" ||
			Array.isArray(auth.sftp) ||
			!Number.isInteger(auth.sftp.port) ||
			auth.sftp.port < 1024 ||
			auth.sftp.port > 65535 ||
			typeof auth.sftp.username !== "string" ||
			!/^[a-z_][a-z0-9_-]{0,31}$/.test(auth.sftp.username) ||
			["root", "nobody"].includes(auth.sftp.username) ||
			typeof auth.sftp.password !== "string" ||
			/[\r\n\0]/.test(auth.sftp.password) ||
			(auth.sftp.path !== undefined &&
				(typeof auth.sftp.path !== "string" ||
					/[,\r\n\0\t]/.test(auth.sftp.path))))
	) {
		throw new Error(
			"Set sftp.port (1024-65535), sftp.username, and a single-line sftp.password in credentials/auth.json.",
		);
	}
	if (
		auth.sftp?.path?.trim() &&
		!posix.isAbsolute(auth.sftp.path) &&
		!win32.isAbsolute(auth.sftp.path)
	) {
		throw new Error("Set sftp.path to an absolute path to the local folder.");
	}
	if (
		auth["gitlab-token"] !== undefined &&
		typeof auth["gitlab-token"] !== "string"
	) {
		throw new Error("Set gitlab-token to a string in credentials/auth.json.");
	}
	if (
		auth["suitecloud-certificates"] !== undefined &&
		(!auth["suitecloud-certificates"] ||
			typeof auth["suitecloud-certificates"] !== "object" ||
			Array.isArray(auth["suitecloud-certificates"]) ||
			!["public", "private", "id"].every(
				(key) =>
					typeof (auth["suitecloud-certificates"] as Record<string, unknown>)[
						key
					] === "string",
			))
	) {
		throw new Error(
			"Set suitecloud-certificates.public, suitecloud-certificates.private, and suitecloud-certificates.id to strings in credentials/auth.json.",
		);
	}
	return auth;
};
