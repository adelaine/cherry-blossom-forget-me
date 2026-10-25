/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerState } from "../../src/common/state.ts";
import { credentials } from "../../src/workspace/credentials.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

interface LoginPopup {
	opener: unknown;
	location: { replace(url: string): void };
	close(): void;
}

const config = {
	suiteapps: [],
	vms: [
		{ account: "000071", url: "first.vm.eng.netsuite.com" },
		{ account: "000072", url: "second.vm.eng.netsuite.com" },
	],
};
const operationId = "00000000-0000-4000-8000-000000000001.login";

function popupFixture() {
	const redirects: string[] = [];
	let closes = 0;
	const popup: LoginPopup = {
		opener: {},
		location: {
			replace(url) {
				redirects.push(url);
			},
		},
		close() {
			closes++;
		},
	};
	return {
		popup,
		redirects,
		get closes() {
			return closes;
		},
	};
}

function installPopup(
	fixture: ReturnType<typeof createRuntimeFixture>,
	popup: LoginPopup | null,
	onOpen: (url: string, target: string) => void = () => {},
) {
	Object.defineProperty(fixture.environment.window, "open", {
		value(url: string, target: string) {
			onOpen(url, target);
			return popup;
		},
	});
}

test("browser sign-in opens synchronously, saves the current VM, and shows the connected account", async (t) => {
	const popup = popupFixture();
	const calls: string[] = [];
	let state = serverState({ config: JSON.stringify(config) });
	let saved: { config: string; authenticationMethod: string } | undefined;
	let finishSaving = (_state: ServerState) => {};
	const saving = new Promise<ServerState>((resolve) => {
		finishSaving = resolve;
	});
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/credentials") {
				calls.push("save");
				assert.equal(popup.popup.opener, null);
				saved = JSON.parse(String(request.options?.body)) as NonNullable<
					typeof saved
				>;
				return saving;
			}
			if (request.path === "/api/targets") {
				calls.push("targets");
				return {
					targets: [
						{ ...config.vms[1], id: "other-target" },
						{
							account: config.vms[0]!.account,
							url: "edited.vm.eng.netsuite.com",
							id: "selected-target",
						},
					],
				};
			}
			if (request.path === "/api/suitecloud/login") {
				calls.push("login");
				assert.deepEqual(JSON.parse(String(request.options?.body)), {
					targetId: "selected-target",
				});
				state = serverState({
					config: saved!.config,
					authentication: { state: "running", operationId },
				});
				return {
					operationId,
					url: "https://edited.vm.eng.netsuite.com/login?session=fixture",
				};
			}
			return state;
		},
	});
	installPopup(fixture, popup.popup, (url, target) => {
		assert.equal(url, "about:blank");
		assert.equal(target, "suitecloud-authentication");
		calls.push("open");
	});
	const view = await renderSite(fixture, [credentials]);
	t.after(view.cleanup);
	view.element("vm").value = "edited.vm.eng.netsuite.com";
	await view.element("vm").input();
	const signingIn = view.element("suitecloud-sign-in").click();
	assert.deepEqual(calls, ["open", "save"]);
	assert.equal(popup.popup.opener, null);
	assert.ok(saved);
	assert.equal(saved.authenticationMethod, "browser");
	const submitted = JSON.parse(saved.config) as typeof config;
	assert.equal(submitted.vms[0]!.url, "edited.vm.eng.netsuite.com");
	assert.equal(submitted.vms[0]!.account, config.vms[0]!.account);
	assert.deepEqual(submitted.vms[1], config.vms[1]);
	finishSaving(serverState({ config: saved.config }));
	await signingIn;
	assert.deepEqual(calls, ["open", "save", "targets", "login"]);
	assert.deepEqual(popup.redirects, [
		"https://edited.vm.eng.netsuite.com/login?session=fixture",
	]);
	assert.equal(popup.closes, 0);
	assert.equal(view.element("suitecloud-sign-in").disabled, true);
	assert.match(
		view.element("credential-message").textContent,
		/Complete the SuiteCloud sign-in in the browser tab/,
	);
	await updateSite(() =>
		fixture.runtime.accept(
			serverState({
				config: saved!.config,
				authentication: {
					state: "succeeded",
					operationId,
					accounts: {
						selected: {
							authId: "browser-selected",
							sdkVersion: "fixture-sdk.jar",
							company: "Fixture company",
							role: "Developer",
							account: config.vms[0]!.account,
							url: "edited.vm.eng.netsuite.com",
							connected: true,
						},
					},
				},
			}),
		),
	);
	assert.equal(
		view.element("suitecloud-authentication-status").textContent,
		"Signed in to Fixture company as Developer.",
	);
	assert.equal(view.element("suitecloud-sign-in").disabled, false);
});

test("cancelling sign-in targets its current operation and restores the sign-in controls", async (t) => {
	let state = serverState({
		config: JSON.stringify(config),
		authentication: { state: "running", operationId },
	});
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === `/api/operations/${operationId}/cancel`) {
				assert.equal(request.options?.method, "POST");
				assert.deepEqual(JSON.parse(String(request.options?.body)), {});
				state = serverState({
					config: state.config,
					authentication: { state: "cancelled", operationId },
				});
				return { id: operationId, state: "cancelled" };
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [credentials]);
	t.after(view.cleanup);
	const cancel = view.root
		.querySelectorAll("button")
		.find((button) => button.textContent === "Cancel sign-in");
	assert.ok(cancel);
	assert.equal(cancel.hidden, false);
	assert.equal(view.element("suitecloud-sign-in").disabled, true);
	await cancel.click();
	assert.equal(
		fixture.requests.filter(
			(request) => request.path === `/api/operations/${operationId}/cancel`,
		).length,
		1,
	);
	assert.equal(fixture.requests.at(-1)!.path, "/api/state");
	assert.equal(fixture.runtime.snapshot?.authentication.state, "cancelled");
	assert.equal(cancel.hidden, true);
	assert.equal(view.element("suitecloud-sign-in").disabled, false);
	assert.equal(
		view.element("credential-message").textContent,
		"Sign-in cancelled.",
	);
});

test("failed browser sign-in closes the unused popup and shows the server's explanation", async (t) => {
	const popup = popupFixture();
	const state = serverState({ config: JSON.stringify(config) });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/targets")
				return { targets: [{ ...config.vms[0], id: "selected-target" }] };
			if (request.path === "/api/suitecloud/login")
				return Response.json(
					{ error: "SuiteCloud could not start. Relaunch SuiteContainer." },
					{ status: 400 },
				);
			return state;
		},
	});
	installPopup(fixture, popup.popup);
	const view = await renderSite(fixture, [credentials]);
	t.after(view.cleanup);
	await view.element("suitecloud-sign-in").click();
	assert.equal(popup.closes, 1);
	assert.deepEqual(popup.redirects, []);
	assert.equal(view.element("suitecloud-sign-in").disabled, false);
	assert.match(
		view.element("credential-message").textContent,
		/Relaunch SuiteContainer/,
	);
});

test("a blocked popup explains how to continue before sending a sign-in request", async (t) => {
	const fixture = createRuntimeFixture({
		state: serverState({ config: JSON.stringify(config) }),
	});
	installPopup(fixture, null);
	const view = await renderSite(fixture, [credentials]);
	t.after(view.cleanup);
	const previousRequests = fixture.requests.length;
	await view.element("suitecloud-sign-in").click();
	assert.equal(fixture.requests.length, previousRequests);
	assert.match(view.element("credential-message").textContent, /Allow pop-ups/);
	assert.equal(view.element("suitecloud-sign-in").disabled, false);
});
