/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import { OperationsService } from "../../src/common/operations.ts";
import { ServiceError } from "../../src/common/errors.ts";
import { ConfigurationService } from "../../src/workspace/services/configuration.ts";
import { CredentialsService } from "../../src/workspace/services/credentials.ts";
import { createWorkspaceFixture } from "../workspace.fixture.ts";

function deferred() {
	let complete = () => {};
	const promise = new Promise<void>((resolve) => {
		complete = resolve;
	});
	return { promise, resolve: complete };
}

test("preparation reserves the operation slot until failure or completion releases it", () => {
	const operations = new OperationsService();
	const preparing = operations.reserve("deployment", ["target-a"]);
	assert.equal(preparing.state, "preparing");
	assert.equal(operations.busy(), true);
	assert.throws(() => operations.reserve("sql", ["target-b"]), {
		code: "operation_conflict",
		status: 409,
		retryable: true,
		details: { operationId: preparing.id, kind: "deployment" },
	});
	operations.fail(preparing.id, new Error("Preparation could not finish."));
	assert.equal(operations.get(preparing.id).state, "failed");
	assert.equal(operations.busy(), false);
	const next = operations.reserve("sql", ["target-b"]);
	operations.running(next.id);
	assert.equal(operations.get(next.id).state, "running");
	assert.equal(operations.busy(), true);
	operations.finish(next.id, { rows: 1 });
	assert.equal(operations.busy(), false);
	assert.deepEqual(operations.get(next.id).result, { rows: 1 });
	assert.ok(operations.get(next.id).started);
	assert.ok(operations.get(next.id).finished);
});

test("supported cancellation awaits worker cleanup and unsupported work stays reserved", async () => {
	const operations = new OperationsService();
	const cleanup = deferred();
	let cancellations = 0;
	const cancellable = operations.reserve(
		"playwright",
		["target-a"],
		async () => {
			cancellations++;
			await cleanup.promise;
		},
	);
	assert.equal(cancellable.cancelSupported, true);
	operations.running(cancellable.id);
	const cancelling = operations.cancel(cancellable.id);
	assert.equal(cancellations, 1);
	assert.equal(operations.busy(), true);
	cleanup.resolve();
	const cancelled = await cancelling;
	assert.equal(cancelled.state, "cancelled");
	assert.deepEqual(cancelled.result, { cancelled: true });
	assert.equal(operations.busy(), false);
	await operations.cancel(cancellable.id);
	assert.equal(cancellations, 1);
	const protectedOperation = operations.reserve("deployment", ["target-a"]);
	assert.equal(protectedOperation.cancelSupported, false);
	await assert.rejects(operations.cancel(protectedOperation.id), {
		code: "cancellation_unsupported",
		status: 409,
	});
	assert.equal(operations.get(protectedOperation.id).state, "preparing");
	assert.equal(operations.busy(), true);
	operations.finish(protectedOperation.id, {});
});

test("equivalent idempotent requests share preparation and follow the original operation", async () => {
	const operations = new OperationsService();
	const preparation = deferred();
	const started = deferred();
	let executions = 0;
	let operationId = "";
	const execute = async () => {
		executions++;
		operationId = operations.reserve("sql", ["target-a"]).id;
		started.resolve();
		await preparation.promise;
		return { status: 202, value: { operationId } };
	};
	const original = operations.idempotent(
		"request-a",
		"/api/sql",
		{ targetId: "target-a", connection: { user: "fixture", service: "db" } },
		execute,
	);
	await started.promise;
	const duplicate = operations.idempotent(
		"request-a",
		"/api/sql",
		{
			connection: { service: "db", user: "fixture", optional: undefined },
			targetId: "target-a",
		},
		execute,
	);
	assert.equal(executions, 1);
	assert.equal(operations.busy(), true);
	await assert.rejects(
		operations.idempotent(
			"request-a",
			"/api/sql",
			{ targetId: "target-b" },
			execute,
		),
		{ code: "idempotency_conflict", status: 409 },
	);
	preparation.resolve();
	assert.deepEqual(await duplicate, await original);
	operations.running(operationId);
	operations.finish(operationId, { rows: 3 });
	const completed = await operations.idempotent(
		"request-a",
		"/api/sql",
		{ targetId: "target-a", connection: { user: "fixture", service: "db" } },
		execute,
	);
	assert.deepEqual(completed, {
		status: 202,
		value: {
			instanceId: operations.instanceId,
			operationId,
			operation: operations.get(operationId),
		},
	});
	assert.equal(executions, 1);
	const completedId = operationId;
	const independent = await operations.idempotent(
		"request-b",
		"/api/sql",
		{ targetId: "target-a", connection: { user: "fixture", service: "db" } },
		execute,
	);
	assert.equal(executions, 2);
	assert.notEqual(operationId, completedId);
	assert.deepEqual(independent.value, { operationId });
	operations.finish(operationId, { rows: 3 });
});

test("completed history retains 100 operations and preserves active work without replaying expired requests", async () => {
	const operations = new OperationsService();
	let executions = 0;
	let originalId = "";
	const execute = () => {
		executions++;
		const operation = operations.reserve("sql", ["target-a"]);
		originalId = operation.id;
		operations.finish(operation.id, { sequence: 0 });
		return { status: 202, value: { operationId: operation.id } };
	};
	await operations.idempotent(
		"original",
		"/api/sql",
		{ sql: "select 1" },
		execute,
	);
	for (let sequence = 1; sequence <= 100; sequence++) {
		const operation = operations.reserve("sql", ["target-a"]);
		operations.finish(operation.id, { sequence });
	}
	assert.equal(operations.list().length, 100);
	assert.deepEqual(operations.list()[0]!.result, { sequence: 1 });
	assert.deepEqual(operations.list().at(-1)!.result, { sequence: 100 });
	assert.throws(() => operations.get(originalId), {
		code: "operation_not_found",
		status: 404,
	});
	const active = operations.reserve("deployment", ["target-b"]);
	assert.equal(operations.list().length, 101);
	assert.equal(operations.get(active.id).state, "preparing");
	await assert.rejects(
		operations.idempotent("original", "/api/sql", { sql: "select 1" }, execute),
		{ code: "idempotency_expired", status: 410 },
	);
	assert.equal(executions, 1);
	operations.finish(active.id, { deployed: true });
	assert.equal(operations.list().length, 100);
	assert.equal(operations.get(active.id).state, "succeeded");
});

test("idempotent failure outcomes stay redacted and expire after the 100-response retry window", async () => {
	const secret = "fixture-token";
	const operations = new OperationsService(undefined, (text) =>
		text.replaceAll(secret, "[redacted]"),
	);
	let executions = 0;
	const execute = () => {
		executions++;
		throw new ServiceError(
			"worker_unavailable",
			`Cannot connect with ${secret}.`,
			503,
			true,
			{
				targetId: "target-a",
			},
		);
	};
	const original = await operations.idempotent(
		"failed",
		"/api/sql",
		{},
		execute,
	);
	assert.deepEqual(original, {
		status: 503,
		value: {
			error: "Cannot connect with [redacted].",
			code: "worker_unavailable",
			retryable: true,
			details: { targetId: "target-a" },
		},
	});
	assert.deepEqual(
		await operations.idempotent("failed", "/api/sql", {}, execute),
		original,
	);
	assert.equal(executions, 1);
	for (let sequence = 1; sequence <= 100; sequence++)
		await operations.idempotent(
			`saved-${sequence}`,
			"/api/configuration",
			{},
			() => ({
				status: 200,
				value: { sequence },
			}),
		);
	await assert.rejects(
		operations.idempotent("failed", "/api/sql", {}, execute),
		{
			code: "idempotency_expired",
			status: 410,
		},
	);
	assert.equal(executions, 1);
	assert.deepEqual(
		await operations.idempotent("saved-100", "/api/configuration", {}, execute),
		{ status: 200, value: { sequence: 100 } },
	);
});

test("logs retain at most 512 KiB with UTF-8-safe truncation and incremental cursors", () => {
	const operations = new OperationsService();
	const operation = operations.reserve("sql", ["target-a"]);
	operations.append(operation.id, "α🙂");
	const first = operations.logs(operation.id);
	assert.equal(first.nextCursor, "6");
	assert.equal(operations.logs(operation.id, "1").log, "🙂");
	const output = "🙂".repeat(131_073) + "!";
	operations.append(operation.id, output);
	const retained = operations.logs(operation.id, first.nextCursor);
	assert.equal(retained.truncated, true);
	assert.ok(Buffer.byteLength(retained.log) <= 512 * 1024);
	assert.equal(retained.log, "🙂".repeat(131_071) + "!");
	assert.equal(retained.nextCursor, String(6 + Buffer.byteLength(output)));
	operations.append(operation.id, "tail");
	const increment = operations.logs(operation.id, retained.nextCursor);
	assert.equal(increment.log, "tail");
	assert.equal(increment.truncated, false);
	assert.equal(increment.nextCursor, String(Number(retained.nextCursor) + 4));
	operations.finish(operation.id, {});
});

test("streamed logs withhold split secrets and private keys and redact operation failures", (t) => {
	const workspace = createWorkspaceFixture();
	t.after(workspace.close);
	let credentials: CredentialsService;
	const operations = new OperationsService(
		undefined,
		(text, active) => credentials.redact(text, active),
		() => {},
		(state, text, final) => credentials.redactChunk(state, text, final),
	);
	credentials = new CredentialsService(
		new ConfigurationService(workspace.root, operations),
		{
			generatedCertificates: false,
			secrets: new Set(),
		},
	);
	const secret = "fixture-private-token";
	credentials.write({ "gitlab-token": secret });
	const operation = operations.reserve("sql", ["target-a"]);
	operations.append(operation.id, "starting token=fixture-pri");
	assert.equal(operations.logs(operation.id).log, "starting token=");
	operations.append(operation.id, "vate-token\n-----BEGIN PRI");
	assert.equal(
		operations.logs(operation.id).log,
		"starting token=[redacted]\n",
	);
	operations.append(
		operation.id,
		"VATE KEY-----\nfixture-key-material\n-----END PRIVATE",
	);
	assert.equal(
		operations.logs(operation.id).log,
		"starting token=[redacted]\n[private key redacted]",
	);
	operations.append(operation.id, " KEY-----\nfinished fixt");
	operations.fail(
		operation.id,
		new ServiceError("worker_failed", `Cannot use ${secret}.`, 502, true),
	);
	assert.equal(
		operations.logs(operation.id).log,
		"starting token=[redacted]\n[private key redacted]\nfinished [redacted]",
	);
	assert.deepEqual(operations.get(operation.id).error, {
		error: "Cannot use [redacted].",
		code: "worker_failed",
		retryable: true,
		details: {},
	});
});
