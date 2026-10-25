/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Target } from "../../src/common/context.ts";
import type { Operation } from "../../src/common/operations.ts";
import {
	createApplicationFixture,
	type ApiError,
} from "./application.fixture.ts";

interface SqlOperation extends Operation {
	result: {
		state: "succeeded" | "failed";
		output: string;
		host: string;
		database: string;
	};
}

const config = {
	suiteapps: [],
	vms: [
		{ account: "000071", url: "first.vm.eng.netsuite.com" },
		{ account: "000072", url: "second.vm.eng.netsuite.com" },
	],
};

test("a targetId SQL request returns an operation, results, and incremental logs without changing saved targets", async (t) => {
	const workers = mkdtempSync(
		join(tmpdir(), "suitecontainer-operation-worker-"),
	);
	const worker = join(workers, "worker.cjs");
	writeFileSync(
		worker,
		String.raw`
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
    console.log("connected to " + input.match(/@"\/\/([^:]+):/)[1]);
    console.log("selected one row");
    console.log(input.match(/^prompt (SUITECONTAINER_SQL_[a-f0-9]+)$/m)[1]);
});
`,
	);
	const app = createApplicationFixture(config, {
		sqlCommand: process.execPath,
		sqlArgs: [worker],
	});
	t.after(async () => {
		await app.close();
		rmSync(workers, { recursive: true, force: true });
	});
	const saved = readFileSync(app.configPath, "utf8");
	const targets = await app.request<{ targets: Target[] }>(
		"/api/targets",
		{},
		"bearer",
	);
	const target = targets.body.targets[1]!;
	const payload = {
		targetId: target.id,
		account: "TEST_USER",
		database: "test.service",
		password: "fixture-SQL-password",
		sql: "SELECT 1 FROM dual;",
	};
	const request = {
		method: "POST",
		headers: { "Idempotency-Key": "selected-target-sql" },
		body: JSON.stringify(payload),
	};
	const response = await app.request<{
		operationId: string;
		instanceId: string;
	}>("/api/sql", request, "bearer");
	assert.equal(response.status, 202);
	assert.equal(response.body.instanceId, app.lifecycle.instanceId);
	const id = response.body.operationId;
	assert.ok(id.startsWith(app.lifecycle.instanceId + "."));
	await app.finish("sql");
	const operation = await app.request<SqlOperation>(
		"/api/operations/" + id,
		{},
		"bearer",
	);
	assert.equal(operation.status, 200);
	assert.equal(operation.body.state, "succeeded");
	assert.deepEqual(operation.body.targets, [target.id]);
	assert.equal(operation.body.cancelSupported, false);
	assert.equal(operation.body.result.state, "succeeded");
	assert.equal(operation.body.result.host, config.vms[1]!.url);
	assert.equal(operation.body.result.database, "test.service");
	assert.ok(
		operation.body.result.output.includes("connected to " + target.url),
	);
	assert.match(operation.body.result.output, /selected one row/);
	const logs = await app.request<{
		log: string;
		nextCursor: string;
		truncated: boolean;
	}>("/api/operations/" + id + "/logs", {}, "bearer");
	assert.equal(logs.status, 200);
	assert.equal(logs.body.log, operation.body.result.output);
	assert.equal(logs.body.truncated, false);
	const following = await app.request<{ log: string; nextCursor: string }>(
		"/api/operations/" + id + "/logs?cursor=" + logs.body.nextCursor,
		{},
		"bearer",
	);
	assert.equal(following.status, 200);
	assert.equal(following.body.log, "");
	assert.equal(following.body.nextCursor, logs.body.nextCursor);
	const retried = await app.request<{
		operationId: string;
		operation: Operation;
	}>("/api/sql", request, "bearer");
	assert.equal(retried.status, 202);
	assert.equal(retried.body.operationId, id);
	assert.equal(retried.body.operation.state, "succeeded");
	assert.equal(app.lifecycle.operations.list().length, 1);
	assert.equal(readFileSync(app.configPath, "utf8"), saved);
});

test("a failed SQL worker keeps its operation result available with its credential redacted", async (t) => {
	const workers = mkdtempSync(
		join(tmpdir(), "suitecontainer-operation-failure-"),
	);
	const worker = join(workers, "worker.cjs");
	writeFileSync(
		worker,
		String.raw`
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
    console.log("ORA-01017: invalid credential " + input.match(/^connect [^/]+\/"([^"]+)"/m)[1]);
    process.exitCode = 1;
});
`,
	);
	const app = createApplicationFixture(config, {
		sqlCommand: process.execPath,
		sqlArgs: [worker],
	});
	t.after(async () => {
		await app.close();
		rmSync(workers, { recursive: true, force: true });
	});
	const targets = await app.request<{ targets: Target[] }>(
		"/api/targets",
		{},
		"bearer",
	);
	const password = "private-worker-password";
	const response = await app.post<{ operationId: string }>(
		"sql",
		{
			targetId: targets.body.targets[0]!.id,
			account: "TEST_USER",
			database: "test.service",
			password,
			sql: "SELECT 1 FROM dual;",
		},
		"bearer",
	);
	assert.equal(response.status, 202);
	await app.finish("sql");
	const operation = await app.request<SqlOperation>(
		"/api/operations/" + response.body.operationId,
		{},
		"bearer",
	);
	assert.equal(operation.status, 200);
	assert.equal(operation.body.state, "failed");
	assert.equal(operation.body.result.state, "failed");
	assert.match(
		operation.body.result.output,
		/ORA-01017: invalid credential \[redacted\]/,
	);
	assert.ok(!JSON.stringify(operation.body).includes(password));
	const logs = await app.request<{ log: string }>(
		"/api/operations/" + response.body.operationId + "/logs",
		{},
		"bearer",
	);
	assert.equal(logs.body.log, operation.body.result.output);
	assert.equal(app.lifecycle.operations.busy(), false);
});

test("the cancellation endpoint invokes supported cancellation and returns the retained operation", async (t) => {
	const app = createApplicationFixture();
	t.after(app.close);
	let cancelled = 0;
	const operation = app.lifecycle.operations.reserve(
		"playwright",
		[],
		async () => {
			cancelled++;
		},
	);
	app.lifecycle.operations.running(operation.id);
	const before = await app.request<Operation>(
		"/api/operations/" + operation.id,
		{},
		"bearer",
	);
	assert.equal(before.body.cancelSupported, true);
	const response = await app.post<Operation>(
		"operations/" + operation.id + "/cancel",
		{},
		"bearer",
	);
	assert.equal(response.status, 200);
	assert.equal(response.body.id, operation.id);
	assert.equal(response.body.state, "cancelled");
	assert.equal(cancelled, 1);
	const retained = await app.request<Operation>(
		"/api/operations/" + operation.id,
		{},
		"bearer",
	);
	assert.equal(retained.status, 200);
	assert.equal(retained.body.state, "cancelled");
	assert.deepEqual(retained.body.result, { cancelled: true });
	assert.equal(app.lifecycle.operations.busy(), false);
});

test("a previous-instance operation returns operation_lost without suggesting a retry", async (t) => {
	const app = createApplicationFixture();
	t.after(app.close);
	const previousId =
		"00000000-0000-4000-8000-000000000000.11111111-1111-4111-8111-111111111111";
	const response = await app.request<ApiError>(
		"/api/operations/" + previousId,
		{},
		"bearer",
	);
	assert.equal(response.status, 410);
	assert.equal(response.body.code, "operation_lost");
	assert.equal(response.body.retryable, false);
	assert.deepEqual(response.body.details, {});
	assert.match(response.body.error, /previous backend instance/);
});
