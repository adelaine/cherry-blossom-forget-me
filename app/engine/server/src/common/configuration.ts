/* Copyright (c) 2026, Oracle and/or its affiliates. */
export const configObject = (value: unknown): Record<string, unknown> => {
	const parsed =
		typeof value === "string" ? JSON.parse(value) : structuredClone(value);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Configuration must be a JSON object.");
	return parsed as Record<string, unknown>;
};
