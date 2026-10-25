/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import {
	createApplicationFixture,
	type ApiError,
} from "./application.fixture.ts";

test("agents discover capabilities and send bearer mutations without a browser session or Origin", async (t) => {
	const app = createApplicationFixture();
	t.after(app.close);
	const capabilities = await app.request<{
		instanceId: string;
		capabilities: { path: string }[];
	}>("/api/capabilities", {}, "bearer");
	assert.equal(capabilities.status, 200);
	assert.equal(capabilities.body.instanceId, app.lifecycle.instanceId);
	assert.ok(
		capabilities.body.capabilities.some(({ path }) => path === "/api/sql"),
	);
	const heartbeat = await app.post<{ alive: boolean }>(
		"heartbeat",
		{},
		"bearer",
	);
	assert.equal(heartbeat.status, 200);
	assert.deepEqual(heartbeat.body, { alive: true });
});

test("an invalid bearer receives a structured authentication error without private credentials", async (t) => {
	const app = createApplicationFixture();
	t.after(app.close);
	const response = await app.request<ApiError>(
		"/api/state",
		{ headers: { Authorization: "Bearer invalid-access-token" } },
		"bearer",
	);
	assert.equal(response.status, 401);
	assert.equal(response.body.code, "authentication_required");
	assert.equal(response.body.retryable, false);
	assert.deepEqual(response.body.details, {});
	const body = JSON.stringify(response.body);
	assert.ok(!body.includes(app.lifecycle.token));
	assert.ok(!body.includes(app.lifecycle.session));
});

test("browser mutations retain same-origin protection when bearer access is available", async (t) => {
	const app = createApplicationFixture();
	t.after(app.close);
	for (const origin of [undefined, "http://other.example:8080"]) {
		const headers = new Headers({ "X-Session-Token": app.lifecycle.session });
		if (origin) headers.set("Origin", origin);
		const response = await app.request<ApiError>(
			"/api/heartbeat",
			{ method: "POST", headers, body: "{}" },
			"none",
		);
		assert.equal(response.status, 403);
		assert.equal(response.body.code, "invalid_origin");
	}
});
