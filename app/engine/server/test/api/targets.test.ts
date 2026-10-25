/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { Target } from "../../src/common/context.ts";
import {
	createApplicationFixture,
	type ApiError,
} from "./application.fixture.ts";

interface TargetsResponse {
	instanceId: string;
	targets: Target[];
}

const config = {
	suiteapps: [],
	vms: [
		{ account: "000071", url: "first.vm.eng.netsuite.com" },
		{ account: "000072", url: "second.vm.eng.netsuite.com" },
	],
};

test("target discovery and selected preflight preserve saved multi-target configuration", async (t) => {
	const app = createApplicationFixture(config);
	t.after(app.close);
	const saved = readFileSync(app.configPath, "utf8");
	const response = await app.request<TargetsResponse>(
		"/api/targets",
		{},
		"bearer",
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.instanceId, app.lifecycle.instanceId);
	assert.deepEqual(
		response.body.targets.map(({ account, url }) => ({ account, url })),
		config.vms,
	);
	assert.notEqual(response.body.targets[0]!.id, response.body.targets[1]!.id);
	const selected = response.body.targets[1]!;
	const draft = { ...config, vms: config.vms.toReversed() };
	const validation = await app.post<{ valid: boolean; targets: Target[] }>(
		"validate",
		{ config: draft, targetId: selected.id },
		"bearer",
	);
	assert.equal(validation.status, 200);
	assert.equal(validation.body.valid, true);
	assert.deepEqual(
		validation.body.targets.map((target) => target.id),
		response.body.targets.toReversed().map((target) => target.id),
	);
	const readiness = await app.request<{
		ready: boolean;
		blockers: { code: string; target: string }[];
	}>("/api/readiness?target=" + selected.id, {}, "bearer");
	assert.equal(readiness.status, 200);
	assert.equal(readiness.body.ready, false);
	assert.equal(readiness.body.blockers[0]!.code, "suiteapps_missing");
	assert.equal(readiness.body.blockers[0]!.target, selected.id);
	assert.equal(readFileSync(app.configPath, "utf8"), saved);
});

test("a removed target returns a structured selection error without starting an operation", async (t) => {
	const app = createApplicationFixture(config);
	t.after(app.close);
	const listed = await app.request<TargetsResponse>(
		"/api/targets",
		{},
		"bearer",
	);
	const removed = listed.body.targets[1]!;
	writeFileSync(
		app.configPath,
		JSON.stringify({ ...config, vms: [config.vms[0]] }),
	);
	const response = await app.post<ApiError>(
		"sql",
		{
			targetId: removed.id,
			account: "TEST_USER",
			database: "test.service",
			password: "fixture-password",
			sql: "SELECT 1 FROM dual;",
		},
		"bearer",
	);
	assert.equal(response.status, 404);
	assert.equal(response.body.code, "target_not_found");
	assert.equal(response.body.retryable, false);
	assert.deepEqual(response.body.details, {});
	assert.match(response.body.error, /no longer configured/);
	assert.equal(app.lifecycle.operations.list().length, 0);
});
