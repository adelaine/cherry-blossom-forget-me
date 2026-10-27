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
	let connectionRequest: { connectionId: string } | undefined;
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/credentials") {
				const input = JSON.parse(String(request.options?.body));
				if (input.connectionId) {
					connectionRequest = input;
					const persisted = JSON.parse(state.config) as typeof config;
					persisted.vms.unshift(persisted.vms.splice(1, 1)[0]!);
					state.config = JSON.stringify(persisted);
					state.authentication.method = "browser";
					return state;
				}
				saved = JSON.parse(String(request.options?.body)) as NonNullable<
					typeof saved
				>;
				state.config = saved.config;
				state.authentication.method = saved.authenticationMethod as
					"browser" | "certificates";
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
	const connection = {
		authId: "saved-connection",
		sdkVersion: "fixture-sdk.jar",
		company: "Saved company",
		role: "Administrator",
		account: config.vms[1].account,
		url: config.vms[1].url,
		connected: true,
	};
	state.authentication.accounts = { saved: connection };
	await updateSite(() => {
		fixture.runtime.saved(state, fixture.runtime.configText);
	});
	const selector = view.element("saved-connections");
	const vmInput = view.element("vm");
	const domainDraft = vmInput.value;
	const accountDraft = view.element("vm-account").value;
	view.element("token").value = "unsaved-token";
	await view.element("token").input();
	const setupForm = view.root
		.querySelectorAll("article")
		.find((node) => node.getAttribute("class") === "credentials-card")!;
	selector.value = "saved";
	await selector.change();
	assert.deepEqual(connectionRequest, { connectionId: "saved" });
	const selected = JSON.parse(state.config) as typeof config;
	assert.deepEqual(selected.vms[0], config.vms[1]);
	assert.equal(selected.vms.length, 2);
	assert.equal(setupForm.hidden, false);
	assert.equal(view.element("vm"), vmInput);
	assert.equal(vmInput.value, domainDraft);
	assert.equal(view.element("vm-account").value, accountDraft);
	assert.equal(view.element("token").value, "unsaved-token");
	assert.equal(fixture.runtime.credentialEditing, false);
	assert.equal(
		view.root
			.querySelectorAll("blockquote")
			.some(
				(node) => node.getAttribute("id") === "connection-deployment-status",
			),
		false,
	);
	state.authentication.accounts.saved = {
		...connection,
		lastSuccessfulDeployment: {
			suiteapp: "bank-feeds",
			completedAt: "2026-10-26T00:00:00.000Z",
		},
	};
	await updateSite(() => fixture.runtime.accept(state));
	assert.match(
		view.element("connection-deployment-status").textContent,
		/Successful deployment access to Saved company/,
	);
	selector.value = "";
	await selector.change();
	assert.equal(
		view.root
			.querySelectorAll("blockquote")
			.some(
				(node) => node.getAttribute("id") === "connection-deployment-status",
			),
		false,
	);
	assert.equal(setupForm.hidden, false);
	assert.equal(view.element("vm"), vmInput);
	assert.equal(vmInput.value, domainDraft);
	assert.equal(view.element("vm-account").value, accountDraft);
	assert.equal(view.element("token").value, "unsaved-token");
	assert.equal(view.element("vm-account").disabled, false);
	assert.equal(fixture.runtime.credentialEditing, true);
	await view.element("reset-credentials").click();
	assert.equal(view.element("vm").value, connection.url);
	assert.equal(view.element("vm-account").value, connection.account);
	assert.equal(view.element("token").value, "");
	assert.equal(setupForm.hidden, false);
	assert.equal(fixture.runtime.credentialEditing, false);
	assert.equal(fixture.requests.at(-1)!.path, "/api/state");
});
