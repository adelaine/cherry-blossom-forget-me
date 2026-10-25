/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { createServerLifecycle } from "../../src/main.ts";
import { createServices } from "../../src/common/services.ts";
import { ServiceError } from "../../src/common/errors.ts";
import { createWorkspaceFixture } from "../workspace.fixture.ts";

function lifecycleFixture() {
	const workspace = createWorkspaceFixture();
	const lifecycle = createServerLifecycle({
		configDirectory: workspace.root,
		mode: "development",
	});
	return {
		lifecycle,
		async close() {
			await lifecycle.dispose();
			workspace.close();
		},
	};
}

test("service replacement waits for operations, active Playwright, and managed SFTP", async (t) => {
	const fixture = lifecycleFixture();
	t.after(fixture.close);
	const { lifecycle } = fixture;
	const original = lifecycle.services;
	let loads = 0;
	const loader = async () => {
		loads++;
		return { createServices };
	};
	const operation = lifecycle.operations.reserve("sql", ["target"]);
	assert.equal(await lifecycle.restartServices(loader), false);
	lifecycle.operations.running(operation.id);
	assert.equal(await lifecycle.restartServices(loader), false);
	lifecycle.operations.finish(operation.id, { output: "done" });

	Object.defineProperty(original.playwright, "active", {
		configurable: true,
		value: true,
	});
	assert.equal(await lifecycle.restartServices(loader), false);
	Reflect.deleteProperty(original.playwright, "active");
	Object.defineProperty(original.sftp, "active", {
		configurable: true,
		value: true,
	});
	assert.equal(await lifecycle.restartServices(loader), false);
	Reflect.deleteProperty(original.sftp, "active");
	assert.equal(loads, 0);
	assert.equal(lifecycle.services, original);
	assert.equal(await lifecycle.restartServices(loader), true);
	assert.equal(loads, 1);
});

test("idle service replacement preserves identity, authentication, operation history, and the runner", async (t) => {
	const fixture = lifecycleFixture();
	t.after(fixture.close);
	const { lifecycle } = fixture;
	const original = lifecycle.services;
	const identity = {
		instanceId: lifecycle.instanceId,
		session: lifecycle.session,
		token: lifecycle.token,
		passkey: lifecycle.passkey,
	};
	const operation = lifecycle.operations.reserve("sql", ["target"]);
	lifecycle.operations.finish(operation.id, { output: "retained" });
	const operations = lifecycle.operations;
	const shared = lifecycle.shared;
	shared.generatedCertificates = true;
	shared.secrets.add("retained-secret");
	lifecycle.setRestartPending("Service changes are pending.");
	const disposeRunner = original.playwright.dispose.bind(original.playwright);
	const runnerShutdown: boolean[] = [];
	t.mock.method(
		original.playwright,
		"dispose",
		async (shutdownRunner = true) => {
			runnerShutdown.push(shutdownRunner);
			await disposeRunner(shutdownRunner);
		},
	);
	const loadedFactory: typeof createServices = (
		options,
		coordinator,
		state,
	) => {
		assert.equal(options, lifecycle.options);
		assert.equal(coordinator, operations);
		assert.equal(state, shared);
		return createServices(options, coordinator, state);
	};
	assert.equal(
		await lifecycle.restartServices(async () => ({
			createServices: loadedFactory,
		})),
		true,
	);
	assert.notEqual(lifecycle.services, original);
	assert.deepEqual(runnerShutdown, [false]);
	assert.deepEqual(
		{
			instanceId: lifecycle.instanceId,
			session: lifecycle.session,
			token: lifecycle.token,
			passkey: lifecycle.passkey,
		},
		identity,
	);
	assert.equal(lifecycle.operations, operations);
	assert.deepEqual(operations.get(operation.id).result, { output: "retained" });
	assert.equal(lifecycle.shared, shared);
	assert.equal(shared.generatedCertificates, true);
	assert.equal(shared.secrets.has("retained-secret"), true);
	assert.equal(operations.restartPending, "");
});

test("work accepted while a replacement module loads keeps the existing services alive", async (t) => {
	const fixture = lifecycleFixture();
	t.after(fixture.close);
	const { lifecycle } = fixture;
	const original = lifecycle.services;
	let loaded = () => {};
	const ready = new Promise<void>((resolve) => {
		loaded = resolve;
	});
	let loads = 0;
	const loader = async () => {
		loads++;
		await ready;
		return { createServices };
	};
	const first = lifecycle.restartServices(loader);
	const concurrent = lifecycle.restartServices(loader);
	const operation = lifecycle.operations.reserve("deployment", ["target"]);
	loaded();
	assert.equal(await first, false);
	assert.equal(await concurrent, false);
	assert.equal(loads, 1);
	assert.equal(lifecycle.services, original);
	lifecycle.operations.finish(operation.id, { finished: true });
	assert.equal(await lifecycle.restartServices(loader), true);
});

test("failed replacement retains the existing services and reports a redacted restart reason", async (t) => {
	const fixture = lifecycleFixture();
	t.after(fixture.close);
	const { lifecycle } = fixture;
	const original = lifecycle.services;
	assert.equal(
		await lifecycle.restartServices(async () => {
			throw new Error(`Cannot load service with ${lifecycle.token}`);
		}),
		false,
	);
	assert.equal(lifecycle.services, original);
	assert.match(lifecycle.operations.restartPending, /Service restart failed/);
	assert.match(lifecycle.operations.restartPending, /Relaunch SuiteContainer/);
	assert.equal(
		lifecycle.operations.restartPending.includes(lifecycle.token),
		false,
	);
});

test("stop protects preparing deployment and running SQL until their work completes", async (t) => {
	for (const kind of ["deployment", "sql"]) {
		await t.test(kind, async (scenario) => {
			const fixture = lifecycleFixture();
			scenario.after(fixture.close);
			const { lifecycle } = fixture;
			let stopped = 0;
			lifecycle.stopHandler = () => {
				stopped++;
			};
			const operation = lifecycle.operations.reserve(kind, ["target"]);
			if (kind === "sql") lifecycle.operations.running(operation.id);
			assert.throws(
				() => lifecycle.stop(),
				(error: unknown) => {
					assert.ok(error instanceof ServiceError);
					assert.equal(error.code, "operation_conflict");
					assert.equal(error.status, 409);
					assert.equal(error.details.operationId, operation.id);
					return true;
				},
			);
			assert.equal(lifecycle.stopping, false);
			assert.equal(stopped, 0);
			lifecycle.operations.finish(operation.id, { finished: true });
			lifecycle.stop();
			lifecycle.stop();
			assert.equal(stopped, 1);
		});
	}
});

test("disposal is shared by simultaneous callers and waits for service cleanup", async (t) => {
	const fixture = lifecycleFixture();
	t.after(fixture.close);
	const { lifecycle } = fixture;
	const disposeServices = lifecycle.services.dispose;
	let release = () => {};
	const cleanupReady = new Promise<void>((resolve) => {
		release = resolve;
	});
	let calls = 0;
	t.mock.method(lifecycle.services, "dispose", async () => {
		calls++;
		await cleanupReady;
		await disposeServices();
	});
	const first = lifecycle.dispose();
	const second = lifecycle.dispose();
	assert.equal(first, second);
	assert.equal(lifecycle.stopping, true);
	assert.equal(calls, 1);
	let finished = false;
	void first.then(() => {
		finished = true;
	});
	await Promise.resolve();
	assert.equal(finished, false);
	release();
	await first;
	assert.equal(finished, true);
	assert.equal(
		await lifecycle.restartServices(async () => ({ createServices })),
		false,
	);
});
