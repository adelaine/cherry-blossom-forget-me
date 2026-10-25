/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerState } from "../../src/common/state.ts";
import { settings } from "../../src/workspace/settings.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import {
	createRuntimeFixture,
	flushRequests,
	serverState,
} from "../runtime-fixture.ts";

const config = {
	suiteapps: [],
	vms: [{ account: "000071", url: "fixture.vm.eng.netsuite.com" }],
	custom: "saved setting",
};

test("configuration checks preserve the draft until an accepted save applies the server response", async (t) => {
	let checked = "";
	let submitted = "";
	let finishSaving = (_state: ServerState) => {};
	const saving = new Promise<ServerState>((resolve) => {
		finishSaving = resolve;
	});
	const state = serverState({ config: JSON.stringify(config) });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/check") {
				checked = (
					JSON.parse(String(request.options?.body)) as { config: string }
				).config;
				return serverState({ config: JSON.stringify(config), ready: false });
			}
			if (request.path === "/api/settings") {
				submitted = (
					JSON.parse(String(request.options?.body)) as { config: string }
				).config;
				return saving;
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [settings]);
	t.after(view.cleanup);
	const draft = JSON.stringify(
		{ ...config, custom: "unsaved setting" },
		null,
		4,
	);
	view.element("config").value = draft;
	await view.element("config").input();
	await updateSite(fixture.runtime.refresh);
	assert.equal(checked, draft);
	assert.equal(view.element("config").value, draft);
	assert.equal(fixture.runtime.editing, true);
	assert.match(
		view.element("settings-message").textContent,
		/Settings changed/,
	);
	const pendingSave = view.element("save").click();
	await flushRequests();
	const normalized = JSON.stringify(JSON.parse(draft));
	try {
		assert.equal(submitted, draft);
		assert.equal(fixture.runtime.pending.has("settings"), true);
		assert.equal(fixture.runtime.editing, true);
	} finally {
		finishSaving(serverState({ config: normalized, ready: true }));
		await pendingSave;
	}
	assert.equal(view.element("config").value, normalized);
	assert.equal(fixture.runtime.editing, false);
	assert.equal(fixture.runtime.snapshot?.ready, true);
	assert.equal(view.element("settings-message").textContent, "Settings saved.");
	assert.equal(view.element("save").disabled, false);
});

test("an earlier save response cannot replace edits made while it was pending", async (t) => {
	let submitted = "";
	let finishSaving = (_state: ServerState) => {};
	const saving = new Promise<ServerState>((resolve) => {
		finishSaving = resolve;
	});
	const state = serverState({ config: JSON.stringify(config) });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/settings") {
				submitted = (
					JSON.parse(String(request.options?.body)) as { config: string }
				).config;
				return saving;
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [settings]);
	t.after(view.cleanup);
	const first = JSON.stringify({ ...config, custom: "first edit" });
	view.element("config").value = first;
	await view.element("config").input();
	const pendingSave = view.element("save").click();
	await flushRequests();
	const latest = JSON.stringify({ ...config, custom: "newer edit" });
	try {
		assert.equal(submitted, first);
		view.element("config").value = latest;
		await view.element("config").input();
	} finally {
		finishSaving(serverState({ config: first }));
		await pendingSave;
	}
	assert.equal(fixture.runtime.snapshot?.config, first);
	assert.equal(view.element("config").value, latest);
	assert.equal(fixture.runtime.editing, true);
	assert.equal(view.element("save").disabled, false);
});

test("rejected JSON remains editable with the server validation message", async (t) => {
	const state = serverState({ config: JSON.stringify(config) });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			return request.path === "/api/settings"
				? Response.json(
						{ error: "Invalid JSON. Fix the configuration before saving." },
						{ status: 400 },
					)
				: state;
		},
	});
	const view = await renderSite(fixture, [settings]);
	t.after(view.cleanup);
	view.element("config").value = '{"suiteapps": [';
	await view.element("config").input();
	await view.element("save").click();
	assert.equal(view.element("config").value, '{"suiteapps": [');
	assert.equal(fixture.runtime.editing, true);
	assert.match(
		view.element("settings-message").textContent,
		/Invalid JSON. Fix the configuration/,
	);
	assert.equal(view.element("config").disabled, false);
	assert.equal(view.element("save").disabled, false);
	assert.equal(fixture.runtime.pending.has("settings"), false);
});
