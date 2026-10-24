import type { Services } from "../../../server/src/services/system.ts";

export type ServerState = ReturnType<Services["status"]>;
export type Configuration = Record<string, unknown>;

export const parseConfiguration = (text: string): Configuration => {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid configuration.");
	return value as Configuration;
};

export const targetHost = (text: string): string => {
	try {
		const vm = (
			parseConfiguration(text).vms as { url?: unknown }[] | undefined
		)?.[0];
		const host = vm?.url;
		return typeof host === "string" &&
			/^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/.test(host) &&
			host.endsWith(".netsuite.com")
			? host
			: "";
	} catch {
		return "";
	}
};

export const errorMessage = (error: unknown): string => {
	return error instanceof Error ? error.message : String(error);
};
