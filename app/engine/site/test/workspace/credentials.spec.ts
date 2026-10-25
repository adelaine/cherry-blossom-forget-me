/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import { credentials } from "../../src/workspace/credentials.tsx";
import { settings } from "../../src/workspace/settings.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

test("Current VM preserves accounts, synchronizes JSON edits, and saves the selected authentication method", async (t) => {
	const config = {
		suiteapps: [],
		vms: [
			{ account: "000072", url: "old.vm.eng.netsuite.com" },
			{ account: "000073", url: "second.vm.eng.netsuite.com" },
		],
	};
	const state = serverState({
		config: JSON.stringify(config),
		authentication: { method: "certificates" },
	});
	let saved: { config: string; authenticationMethod: string } | undefined;
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/credentials") {
				saved = JSON.parse(String(request.options?.body)) as NonNullable<
					typeof saved
				>;
				state.config = saved.config;
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [credentials, settings]);
	t.after(view.cleanup);
	assert.equal(view.element("vm").value, config.vms[0].url);
	view.element("vm").value = "new.vm.eng.netsuite.com";
	await view.element("vm").input();
	const edited = JSON.parse(view.element("config").value) as typeof config;
	assert.equal(edited.vms[0].url, "new.vm.eng.netsuite.com");
	assert.equal(edited.vms[0].account, "000072");
	assert.deepEqual(edited.vms[1], config.vms[1]);
	await view.element("credentials").click();
	assert.ok(saved);
	assert.deepEqual(JSON.parse(saved.config), edited);
	assert.equal(saved.authenticationMethod, "certificates");
	edited.vms[0].url = "json.vm.eng.netsuite.com";
	view.element("config").value = JSON.stringify(edited);
	await view.element("config").input();
	await updateSite(() => fixture.runtime.accept(state));
	assert.equal(view.element("vm").value, edited.vms[0].url);
	view.element("config").value = "invalid JSON";
	await view.element("config").input();
	await view.element("vm").input();
	assert.equal(view.element("config").value, "invalid JSON");
	assert.match(
		view.element("credential-message").textContent,
		/Fix the configuration JSON/,
	);
});
