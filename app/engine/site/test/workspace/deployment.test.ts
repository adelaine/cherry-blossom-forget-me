/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import { deployment } from "../../src/workspace/deployment.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

test("deployment validation explains running deployment and SQL preparation", async (t) => {
	const fixture = createRuntimeFixture();
	const view = await renderSite(fixture, [deployment]);
	t.after(view.cleanup);
	await updateSite(() =>
		fixture.runtime.accept(serverState({ run: { state: "running" } })),
	);
	assert.match(view.element("validation").textContent, /Deployment is running/);
	await updateSite(() =>
		fixture.runtime.accept(serverState({ sql: { state: "running" } })),
	);
	assert.match(view.element("validation").textContent, /SQL is running/);
	await updateSite(() =>
		fixture.runtime.accept(serverState({ sql: { preparing: true } })),
	);
	assert.match(
		view.element("validation").textContent,
		/Unlocking the saved SQL password/,
	);
});
