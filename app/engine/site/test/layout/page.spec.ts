/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import { credentials } from "../../src/workspace/credentials.tsx";
import { settings } from "../../src/workspace/settings.tsx";
import { deployment } from "../../src/workspace/deployment.tsx";
import { sql } from "../../src/tools/sql.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

test("Stop app renders the stop result and explains blocked closure", async (t) => {
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
				const view = await renderSite(fixture, [credentials, deployment]);
				scenario.after(view.cleanup);
				await view.element("stop").click();
				if (success) {
					assert.equal(view.element("stop").disabled, true);
					assert.equal(view.element("app-message").hidden, false);
					assert.match(
						view.element("app-message").textContent,
						/Attempting to close this page/,
					);
					await updateSite(() => [...fixture.timers.values()][0]!.callback());
					assert.match(
						view.element("app-message").textContent,
						/browser kept this page open/,
					);
				} else {
					assert.equal(view.element("stop").disabled, false);
					assert.match(
						view.element("app-message").textContent,
						/Deployment is running/,
					);
				}
			},
		);
	}
});

test("connection feedback preserves edits and disables actions until recovery", async (t) => {
	let offline = false;
	const state = serverState();
	const fixture = createRuntimeFixture({
		state,
		respond() {
			if (offline) throw new Error("fetch failed");
			return state;
		},
	});
	const view = await renderSite(fixture, [credentials, settings, sql]);
	t.after(view.cleanup);
	view.element("config").value = "unsaved edits";
	await view.element("config").input();
	offline = true;
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("connection-error").hidden, false);
	assert.match(
		view.element("connection-error").textContent,
		/Start the launcher again/,
	);
	assert.equal(view.element("config").value, "unsaved edits");
	assert.equal(view.element("save").disabled, true);
	assert.equal(view.element("sql-run").disabled, true);
	await updateSite(() => fixture.runtime.accept(state));
	assert.equal(view.element("save").disabled, true);
	offline = false;
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("connection-error").hidden, true);
	assert.equal(view.element("config").value, "unsaved edits");
	assert.equal(view.element("save").disabled, false);
	assert.equal(view.element("download").disabled, false);
});

test("page composition places configuration after deployment on the Deploy panel", async (t) => {
	const view = await renderSite(createRuntimeFixture(), [
		settings,
		sql,
		deployment,
	]);
	t.after(view.cleanup);
	const deployPanel = view.element("deployment-panel");
	const html = deployPanel.innerHTML;
	assert.ok(
		html.indexOf("Configuration JSON") > html.indexOf("Deploy SuiteApps"),
	);
	assert.equal(deployPanel.hidden, false);
	assert.equal(view.element("sql-panel").hidden, true);
	assert.ok(!html.includes("SQL queries"));
});
