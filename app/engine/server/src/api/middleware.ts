/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { timingSafeEqual } from "node:crypto";
import type { ServerLifecycle } from "../main.ts";
import {
	ServiceError,
	structuredError,
	errorStatus,
} from "../common/errors.ts";
import type { ApiApp } from "./operations.ts";

const equal = (supplied: string, expected: string): boolean => {
	const left = Buffer.from(supplied);
	const right = Buffer.from(expected);
	return (
		!!expected && left.length === right.length && timingSafeEqual(left, right)
	);
};

/** Apply the existing public headers and loopback host protection. */
export function publicMiddleware(
	app: ApiApp,
	lifecycle: ServerLifecycle,
): void {
	const failure = (error: unknown) =>
		structuredError(error, (text) =>
			lifecycle.services.credentials.redact(text),
		);
	app.use("*", async (c, next) => {
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		c.header("Cache-Control", "no-store");
		c.header(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
				(lifecycle.options.mode === "development"
					? "connect-src 'self' ws:; "
					: "") +
				"frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
		);
		const internalHealth =
			c.req.path === "/health" &&
			equal(
				c.req.header("authorization")?.replace(/^Bearer /, "") ?? "",
				lifecycle.runnerToken,
			);
		if (
			!internalHealth &&
			!/^(?:localhost|127\.0\.0\.1):\d+$/.test(c.req.header("host") ?? "")
		)
			return c.json(
				failure(
					new ServiceError(
						"invalid_host",
						"Open the app through its localhost address.",
						403,
					),
				),
				403,
			);
		await next();
	});
}

/** Authenticate API traffic and parse bounded request bodies. */
export function authenticatedMiddleware(
	app: ApiApp,
	lifecycle: ServerLifecycle,
): void {
	const failure = (error: unknown) =>
		structuredError(error, (text) =>
			lifecycle.services.credentials.redact(text),
		);
	app.use("*", async (c, next) => {
		const browser = c.req.header("x-session-token");
		const authorization = c.req.header("authorization");
		const origin = c.req.header("origin");
		if (browser !== undefined && authorization !== undefined)
			return c.json(
				failure(
					new ServiceError(
						"conflicting_credentials",
						"Supply only one authentication mechanism.",
						401,
					),
				),
				401,
			);
		const bearer = authorization !== undefined;
		const authenticated = bearer
			? /^Bearer [^\s]+$/.test(authorization) &&
				equal(authorization.slice(7), lifecycle.token)
			: equal(browser ?? "", lifecycle.session);
		if (!authenticated) {
			const status = bearer ? 401 : 403;
			return c.json(
				failure(
					new ServiceError(
						"authentication_required",
						bearer
							? "Read the current instance descriptor and access-token file, then authenticate with Bearer."
							: "Reopen the page using the launcher URL.",
						status,
					),
				),
				status,
			);
		}
		if (
			(origin !== undefined && origin !== "http://" + c.req.header("host")) ||
			(!bearer && c.req.method !== "GET" && origin === undefined)
		)
			return c.json(
				failure(
					new ServiceError(
						"invalid_origin",
						"Use the same origin as the application.",
						403,
					),
				),
				403,
			);
		await next();
		if (c.res.status < 400) lifecycle.heartbeat.heartbeat();
	});
	app.use("/api/*", async (c, next) => {
		if (c.req.method === "POST") {
			if (lifecycle.stopping)
				throw new ServiceError(
					"instance_stopping",
					"The app is stopping. Relaunch to continue.",
					409,
					true,
				);
			const chunks: Uint8Array[] = [];
			let length = 0;
			const reader = c.req.raw.body?.getReader();
			if (reader) {
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						length += value.byteLength;
						if (length > 128 * 1024) {
							await reader.cancel();
							throw new ServiceError(
								"request_too_large",
								"Settings are too large (maximum 128 KiB).",
							);
						}
						chunks.push(value);
					}
				} finally {
					reader.releaseLock();
				}
			}
			const input: unknown = JSON.parse(
				Buffer.concat(chunks).toString("utf8") || "{}",
			);
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error("Expected settings as an object.");
			if (lifecycle.stopping)
				throw new ServiceError(
					"instance_stopping",
					"The app is stopping.",
					409,
					true,
				);
			c.set("input", input as Record<string, unknown>);
		}
		await next();
	});
}

/** Format unknown routes and service errors through one HTTP boundary. */
export function errorHandlers(app: ApiApp, lifecycle: ServerLifecycle): void {
	const failure = (error: unknown) =>
		structuredError(error, (text) =>
			lifecycle.services.credentials.redact(text),
		);
	app.notFound((c) =>
		c.json(failure(new ServiceError("not_found", "Page not found.", 404)), 404),
	);
	app.onError((error, c) => {
		const status = errorStatus(error);
		return c.json(failure(error), status as 400);
	});
}
