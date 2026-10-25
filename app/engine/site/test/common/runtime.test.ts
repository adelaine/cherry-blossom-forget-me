/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import { ACTIVITY_GRACE_MS } from "../../../server/src/common/inactivity.ts";
import {
	createRuntimeFixture,
	flushRequests,
	serverState,
} from "../runtime-fixture.ts";

test("heartbeat follows trusted activity and preserves drafts through connection loss", async (t) => {
	let offline = false;
	const state = serverState();
	const fixture = createRuntimeFixture({
		state,
		respond() {
			if (offline) throw new Error("fetch failed");
			return state;
		},
	});
	t.after(fixture.cleanup);
	const { runtime } = fixture;
	runtime.start();
	await flushRequests();
	assert.ok(
		[...fixture.intervals.values()].some(
			(interval) => interval.delay === 30_000,
		),
	);
	const beats = () =>
		fixture.requests.filter((request) => request.path === "/api/heartbeat")
			.length;
	assert.equal(beats(), 1);
	fixture.setNow(ACTIVITY_GRACE_MS - 30_000);
	await runtime.heartbeat();
	assert.equal(beats(), 2);
	fixture.setNow(ACTIVITY_GRACE_MS);
	await runtime.refresh();
	await runtime.heartbeat();
	assert.equal(beats(), 2);
	fixture.activity("scroll", false);
	await runtime.heartbeat();
	assert.equal(beats(), 2);
	fixture.activity("input", true);
	await flushRequests();
	assert.equal(beats(), 3);
	fixture.setNow(ACTIVITY_GRACE_MS * 2);
	await runtime.heartbeat();
	assert.equal(beats(), 3);
	runtime.changeConfig("unsaved edits");
	offline = true;
	await runtime.refresh();
	assert.equal(runtime.connectionFailed, true);
	assert.match(runtime.connectionMessage, /Start the launcher again/);
	assert.equal(runtime.configText, "unsaved edits");
	assert.equal(runtime.disabled, true);
	runtime.accept(state);
	assert.equal(runtime.disabled, true);
	assert.equal(fixture.closes, 0);
	const closing = [...fixture.timers.values()].find(
		(timer) => timer.delay === 5000,
	);
	assert.ok(closing);
	closing.callback();
	assert.equal(fixture.closes, 1);
	offline = false;
	await runtime.refresh();
	assert.equal(runtime.connectionFailed, false);
	assert.equal(runtime.configText, "unsaved edits");
	assert.equal(runtime.disabled, false);
	offline = true;
	fixture.activity("click", true);
	await flushRequests();
	const scheduled = fixture.timers.size;
	await runtime.refresh();
	assert.equal(fixture.timers.size, scheduled);
	assert.equal(runtime.connectionFailed, true);
});

test("stop schedules closure only after success and keeps failed requests usable", async (t) => {
	for (const success of [true, false]) {
		await t.test(
			success ? "successful stop" : "rejected stop",
			async (scenario) => {
				const state = serverState();
				const fixture = createRuntimeFixture({
					state,
					respond(request) {
						return request.path === "/api/stop" && !success
							? Response.json(
									{ error: "Deployment is running." },
									{ status: 409 },
								)
							: state;
					},
				});
				scenario.after(fixture.cleanup);
				const { runtime } = fixture;
				runtime.start();
				await flushRequests();
				await runtime.stop();
				assert.equal(fixture.closes, 0);
				if (success) {
					assert.equal(fixture.timers.size, 1);
					const timer = [...fixture.timers.values()][0]!;
					assert.equal(timer.delay, 5000);
					assert.match(runtime.stopMessage, /Attempting to close this page/);
					assert.equal(runtime.stopped, true);
					const stoppedRequests = fixture.requests.length;
					await runtime.refresh();
					runtime.accept(state);
					assert.equal(fixture.requests.length, stoppedRequests);
					assert.match(runtime.stopMessage, /Attempting to close this page/);
					timer.callback();
					assert.equal(fixture.closes, 1);
					assert.match(runtime.stopMessage, /browser kept this page open/);
				} else {
					assert.equal(fixture.timers.size, 0);
					assert.equal(runtime.stopped, false);
					assert.match(runtime.actionError, /Deployment is running/);
					const activeRequests = fixture.requests.length;
					await runtime.refresh();
					assert.equal(fixture.requests.length, activeRequests + 1);
					assert.match(runtime.actionError, /Deployment is running/);
				}
			},
		);
	}
});
