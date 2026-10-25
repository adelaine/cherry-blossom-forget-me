/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerState } from "../../src/common/state.ts";
import { playwright } from "../../src/tools/playwright.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

const config = {
	suiteapps: [],
	vms: [{ account: "000071", url: "fixture.vm.eng.netsuite.com" }],
	playwright: {
		enabled: true,
		project: "fixture/test-pw",
		browser: "container" as const,
		testFile: "",
		workers: 1,
	},
};

function readyState(
	changes: Partial<ServerState["playwright"]> = {},
	text = JSON.stringify(config),
): ServerState {
	return serverState({
		config: text,
		playwright: {
			...serverState().playwright,
			project: config.playwright.project,
			settings: config.playwright,
			enabled: true,
			available: true,
			canRun: true,
			...changes,
		},
	});
}

test("Playwright saves edited settings, reports results, and cancels the next active run", async (t) => {
	let state = readyState();
	const actions: { path: string; data: Record<string, unknown> }[] = [];
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (
				[
					"/api/settings",
					"/api/playwright/run",
					"/api/playwright/cancel",
				].includes(request.path)
			) {
				const data = JSON.parse(String(request.options?.body)) as Record<
					string,
					unknown
				>;
				actions.push({ path: request.path, data });
				if (request.path === "/api/settings") {
					const saved = JSON.parse(String(data.config)) as typeof config;
					state = readyState(
						{ settings: saved.playwright },
						String(data.config),
					);
				} else {
					const running = request.path === "/api/playwright/run";
					state = readyState(
						{
							settings: state.playwright.settings,
							state: running ? "running" : "failed",
							canRun: !running,
							log: running
								? "Starting selected tests…"
								: "Run stopped by the developer.",
						},
						state.config,
					);
				}
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [playwright]);
	t.after(view.cleanup);
	assert.equal(view.element("playwright-run").disabled, false);
	view.element("playwright-file").value = " tests/login.spec.ts ";
	await view.element("playwright-file").input();
	view.element("playwright-workers").value = "3";
	await view.element("playwright-workers").input();
	assert.equal(view.element("playwright-run").disabled, true);
	assert.match(
		view.element("playwright-message").textContent,
		/Save before running/,
	);
	await view.element("playwright-save").click();
	const submitted = JSON.parse(
		String(actions[0]!.data.config),
	) as typeof config;
	assert.equal(actions[0]!.path, "/api/settings");
	assert.deepEqual(submitted.playwright, {
		...config.playwright,
		testFile: "tests/login.spec.ts",
		workers: 3,
	});
	assert.deepEqual(submitted.vms, config.vms);
	assert.equal(view.element("playwright-run").disabled, false);
	await view.element("playwright-run").click();
	assert.equal(actions[1]!.path, "/api/playwright/run");
	assert.deepEqual(actions[1]!.data, { config: state.config });
	assert.equal(view.element("playwright-run").disabled, true);
	assert.equal(view.element("playwright-save").disabled, true);
	assert.equal(view.element("playwright-cancel").disabled, false);
	assert.match(
		view.element("playwright-message").textContent,
		/tests are running/,
	);
	state = readyState(
		{
			settings: state.playwright.settings,
			state: "succeeded",
			log: "\x1b[32m2 passed <selected>\x1b[0m",
		},
		state.config,
	);
	await updateSite(fixture.runtime.refresh);
	assert.match(view.element("playwright-message").textContent, /tests passed/);
	assert.match(view.element("playwright-log").innerHTML, /ansi-fg-2/);
	assert.match(
		view.element("playwright-log").innerHTML,
		/2 passed &lt;selected&gt;/,
	);
	assert.equal(view.element("playwright-run").disabled, false);
	assert.equal(view.element("playwright-cancel").disabled, true);
	await view.element("playwright-run").click();
	await view.element("playwright-cancel").click();
	assert.equal(actions[3]!.path, "/api/playwright/cancel");
	assert.deepEqual(actions[3]!.data, {});
	assert.match(
		view.element("playwright-message").textContent,
		/tests failed or were stopped/,
	);
	assert.match(
		view.element("playwright-log").innerHTML,
		/Run stopped by the developer/,
	);
	assert.equal(view.element("playwright-run").disabled, false);
	assert.equal(view.element("playwright-cancel").disabled, true);
});

test("Playwright request errors retain edited settings and leave the controls usable", async (t) => {
	const state = readyState();
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/playwright/run")
				return Response.json(
					{ error: "The test runner is busy. Wait for its results." },
					{ status: 409 },
				);
			if (request.path === "/api/settings")
				return Response.json(
					{ error: "The test project is not available in this workspace." },
					{ status: 400 },
				);
			return state;
		},
	});
	const view = await renderSite(fixture, [playwright]);
	t.after(view.cleanup);
	await view.element("playwright-run").click();
	assert.match(
		view.element("playwright-message").textContent,
		/test runner is busy/,
	);
	assert.equal(view.element("playwright-run").disabled, false);
	await updateSite(fixture.runtime.refresh);
	assert.match(
		view.element("playwright-message").textContent,
		/test runner is busy/,
	);
	view.element("playwright-project").value = "changed/test-pw";
	await view.element("playwright-project").input();
	await view.element("playwright-save").click();
	assert.equal(view.element("playwright-project").value, "changed/test-pw");
	assert.match(
		view.element("playwright-message").textContent,
		/project is not available/,
	);
	assert.equal(view.element("playwright-project").disabled, false);
	assert.equal(view.element("playwright-save").disabled, false);
	assert.equal(view.element("playwright-run").disabled, true);
});
