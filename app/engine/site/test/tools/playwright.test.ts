/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerState } from "../../src/common/state.ts";
import { playwright } from "../../src/tools/playwright.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

function readyState(
	changes: Partial<ServerState["playwright"]> = {},
): ServerState {
	return serverState({
		config: "{ unfinished workspace configuration",
		playwright: {
			...serverState().playwright,
			available: true,
			canRun: true,
			...changes,
		},
	});
}

test("Playwright reports results and cancels without reading or saving project settings", async (t) => {
	let state = readyState();
	const actions: { path: string; data: unknown }[] = [];
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/playwright/cancel") {
				actions.push({
					path: request.path,
					data: JSON.parse(String(request.options?.body)),
				});
				state = readyState({
					state: "failed",
					log: "Run stopped by the developer.",
				});
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [playwright]);
	t.after(view.cleanup);
	assert.match(view.element("playwright-message").textContent, /Ready to run/);
	assert.equal(view.element("playwright-cancel").disabled, true);
	assert.doesNotMatch(
		view.root.innerHTML,
		/id="playwright-(?:project|enabled|browser|file|workers|save)"/,
	);
	state = readyState({ state: "running", log: "Starting tests…" });
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("playwright-cancel").disabled, false);
	await view.element("playwright-cancel").click();
	assert.deepEqual(actions, [{ path: "/api/playwright/cancel", data: {} }]);
	assert.equal(fixture.runtime.configText, state.config);
	assert.match(
		view.element("playwright-message").textContent,
		/failed or were stopped/,
	);
	assert.equal(view.element("playwright-cancel").disabled, true);
	state = readyState({
		state: "succeeded",
		log: "\x1b[32m2 passed <selected>\x1b[0m",
	});
	await updateSite(fixture.runtime.refresh);
	assert.match(view.element("playwright-message").textContent, /tests passed/);
	assert.match(view.element("playwright-log").innerHTML, /ansi-fg-2/);
	assert.match(
		view.element("playwright-log").innerHTML,
		/2 passed &lt;selected&gt;/,
	);
});

test("Playwright cancellation errors leave the active runner controls usable", async (t) => {
	const state = readyState({ state: "running" });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/playwright/cancel")
				return Response.json(
					{ error: "The runner could not cancel the active run." },
					{ status: 409 },
				);
			return state;
		},
	});
	const view = await renderSite(fixture, [playwright]);
	t.after(view.cleanup);
	await view.element("playwright-cancel").click();
	assert.match(
		view.element("playwright-message").textContent,
		/could not cancel/,
	);
	assert.equal(view.element("playwright-cancel").disabled, false);
	await updateSite(fixture.runtime.refresh);
	assert.match(
		view.element("playwright-message").textContent,
		/could not cancel/,
	);
	assert.equal(fixture.runtime.configText, state.config);
});
