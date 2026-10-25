import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scrypt,
} from "node:crypto";

const validateInput = (password: string, salt: string): void => {
	if (!password || Buffer.byteLength(password) > 1024)
		throw new Error(
			"Enter the answer to the password hint (maximum 1024 bytes).",
		);
	if (!salt || Buffer.byteLength(salt) > 1024)
		throw new Error(
			"Set SQL_PASSWORD_SALT before generating or unlocking credentials.",
		);
};

const deriveKey = async (password: string, salt: string): Promise<Buffer> => {
	validateInput(password, salt);
	return new Promise((resolve, reject) =>
		scrypt(
			password,
			salt,
			32,
			{ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 },
			(error, key) => (error ? reject(error) : resolve(key)),
		),
	);
};

export const encryptSqlPassword = async (
	sqlPassword: string,
	unlockPassword: string,
	salt: string,
): Promise<string> => {
	if (
		!sqlPassword ||
		Buffer.byteLength(sqlPassword) > 4096 ||
		/[\r\n\0"]/.test(sqlPassword)
	)
		throw new Error(
			"Enter a SQL password without line breaks or double quotes (maximum 4096 bytes).",
		);
	const iv = randomBytes(12);
	const key = await deriveKey(unlockPassword, salt);
	try {
		const cipher = createCipheriv("aes-256-gcm", key, iv);
		cipher.setAAD(Buffer.from("suitecontainer-sql-v1"));
		const encrypted = Buffer.concat([
			cipher.update(sqlPassword, "utf8"),
			cipher.final(),
		]);
		return [
			"sql-v1",
			iv.toString("base64url"),
			cipher.getAuthTag().toString("base64url"),
			encrypted.toString("base64url"),
		].join(":");
	} finally {
		key.fill(0);
	}
};

export const decryptSqlPassword = async (
	encrypted: string,
	unlockPassword: string,
	salt: string,
): Promise<Buffer> => {
	validateInput(unlockPassword, salt);
	const parts = encrypted.split(":");
	if (
		encrypted.length > 8192 ||
		parts.length !== 4 ||
		parts[0] !== "sql-v1" ||
		parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
	)
		throw new Error(
			"The encrypted SQL password is invalid. Generate a new encrypted string.",
		);
	const [iv, tag, ciphertext] = parts
		.slice(1)
		.map((part) => Buffer.from(part, "base64url"));
	if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 4096)
		throw new Error(
			"The encrypted SQL password is invalid. Generate a new encrypted string.",
		);
	const key = await deriveKey(unlockPassword, salt);
	let partial: Buffer | undefined;
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAAD(Buffer.from("suitecontainer-sql-v1"));
		decipher.setAuthTag(tag);
		partial = decipher.update(ciphertext);
		return Buffer.concat([partial, decipher.final()]);
	} catch {
		throw new Error(
			"Could not unlock the saved SQL password. Check your answer to the password hint, or enter your SQL password directly.",
		);
	} finally {
		key.fill(0);
		partial?.fill(0);
	}
};
