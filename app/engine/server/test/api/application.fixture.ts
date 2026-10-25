/* Copyright (c) 2026, Oracle and/or its affiliates. */
import {
	createApplication,
	createServerLifecycle,
	type ServerLifecycle,
	type ServerOptions,
} from "../../src/main.ts";
import { createWorkspaceFixture } from "../workspace.fixture.ts";

interface ApiResponse<T> {
	status: number;
	ok: boolean;
	headers: Headers;
	body: T;
}

export interface ApiError {
	error: string;
	code: string;
	retryable: boolean;
	details: Record<string, unknown>;
}

type Authentication = "browser" | "bearer" | "none";
type ServerState = ReturnType<ServerLifecycle["services"]["status"]>;

/** Exercise the real API and services without opening a network listener. */
export function createApplicationFixture(
	config?: Record<string, unknown>,
	options: ServerOptions = {},
) {
	const workspace = createWorkspaceFixture(config);
	const lifecycle = createServerLifecycle({
		...options,
		configDirectory: workspace.root,
	});
	const app = createApplication(lifecycle);
	const origin = "http://127.0.0.1:8080";
	const headers = {
		Host: "127.0.0.1:8080",
		"Content-Type": "application/json",
	};
	async function request<T>(
		path: string,
		init: RequestInit = {},
		authentication: Authentication = "browser",
	): Promise<ApiResponse<T>> {
		const requestHeaders = new Headers(headers);
		if (authentication === "browser") {
			requestHeaders.set("X-Session-Token", lifecycle.session);
			requestHeaders.set("Origin", origin);
		} else if (authentication === "bearer") {
			requestHeaders.set("Authorization", "Bearer " + lifecycle.token);
		}
		new Headers(init.headers).forEach((value, name) => {
			requestHeaders.set(name, value);
		});
		const response = await app.request(origin + path, {
			...init,
			headers: requestHeaders,
		});
		return {
			status: response.status,
			ok: response.ok,
			headers: response.headers,
			body: (await response.json()) as T,
		};
	}
	return {
		...workspace,
		lifecycle,
		request,
		post<T = unknown>(
			path: string,
			input: object,
			authentication: Authentication = "browser",
		) {
			return request<T>(
				"/api/" + path,
				{ method: "POST", body: JSON.stringify(input) },
				authentication,
			);
		},
		async finish<K extends "run" | "sql">(kind: K) {
			for (let attempt = 0; attempt < 100; attempt++) {
				const response = await request<ServerState>("/api/state");
				if (!response.ok) {
					throw new Error(
						`State request failed (${response.status}): ${JSON.stringify(response.body)}`,
					);
				}
				const next = response.body[kind];
				if (next.state !== "running") return next;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error("Worker did not finish.");
		},
		async close() {
			await lifecycle.dispose();
			workspace.close();
		},
	};
}
