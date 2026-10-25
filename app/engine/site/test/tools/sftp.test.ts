/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import type { ServerState } from "../../src/common/state.ts";
import { sftp } from "../../src/tools/sftp.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

type LocalSftp = Exclude<ServerState["sftp"], { mode: string }>;

function localState(changes: Partial<LocalSftp> = {}): ServerState {
	return serverState({
		sftp: {
			...(serverState().sftp as LocalSftp),
			username: "developer",
			port: 8022,
			passwordPresent: true,
			...changes,
		},
	});
}

test("SFTP saves edited settings, starts its tunnel, and stops without resending credentials", async (t) => {
	let state = localState();
	const actions: Record<string, unknown>[] = [];
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/sftp") {
				const input = JSON.parse(String(request.options?.body)) as Record<
					string,
					unknown
				>;
				actions.push(input);
				if (input.action === "stop") state = localState();
				else
					state = localState({
						username: String(input.username),
						port: Number(input.port),
						path: String(input.path),
						state: input.action === "start" ? "running" : "stopped",
						hostKey: input.action === "start" ? "ssh-ed25519 fixture-key" : "",
						tunnel: {
							state: input.action === "start" ? "running" : "stopped",
							error: "",
						},
					});
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [sftp]);
	t.after(view.cleanup);
	assert.equal(view.element("sftp-stop").disabled, true);
	view.element("sftp-user").value = " edited_user ";
	await view.element("sftp-user").input();
	view.element("sftp-port").value = "8122";
	await view.element("sftp-port").input();
	view.element("sftp-path").value = " /shared/imports ";
	await view.element("sftp-path").input();
	view.element("sftp-password").value = "private-sftp-password";
	await view.element("sftp-password").input();
	await view.element("sftp-save").click();
	assert.deepEqual(actions[0], {
		action: "save",
		confirmReplace: false,
		username: "edited_user",
		port: 8122,
		path: "/shared/imports",
		password: "private-sftp-password",
	});
	assert.equal(view.element("sftp-password").value, "");
	assert.match(view.element("sftp-message").textContent, /SFTP settings saved/);
	await view.element("sftp-start").click();
	assert.equal(actions[1]!.action, "start");
	assert.equal(actions[1]!.password, undefined);
	assert.equal(view.element("sftp-start").disabled, true);
	assert.equal(view.element("sftp-stop").disabled, false);
	assert.equal(view.element("sftp-user").disabled, true);
	assert.equal(
		view.element("sftp-host-key").textContent,
		"ssh-ed25519 fixture-key",
	);
	assert.match(view.element("sftp-message").textContent, /SFTP is running/);
	await updateSite(() =>
		fixture.runtime.accept(
			localState({
				state: "running",
				tunnel: { state: "failed", error: "SSH forwarding was refused." },
			}),
		),
	);
	assert.match(
		view.element("sftp-message").textContent,
		/SSH forwarding was refused/,
	);
	await view.element("sftp-stop").click();
	assert.deepEqual(actions[2], { action: "stop" });
	assert.equal(view.element("sftp-start").disabled, false);
	assert.equal(view.element("sftp-stop").disabled, true);
	assert.equal(view.element("sftp-user").disabled, false);
	assert.match(view.element("sftp-message").textContent, /SFTP is stopped/);
});

test("a rejected SFTP start retains edited credentials and explains relaunch requirements", async (t) => {
	const fixture = createRuntimeFixture({
		state: localState(),
		respond(request) {
			return request.path === "/api/sftp"
				? Response.json(
						{ error: "SSH could not reach the selected scrumbox." },
						{ status: 400 },
					)
				: localState();
		},
	});
	const view = await renderSite(fixture, [sftp]);
	t.after(view.cleanup);
	view.element("sftp-user").value = "my_user";
	await view.element("sftp-user").input();
	view.element("sftp-password").value = "unsaved-password";
	await view.element("sftp-password").input();
	await view.element("sftp-start").click();
	assert.equal(view.element("sftp-user").value, "my_user");
	assert.equal(view.element("sftp-password").value, "unsaved-password");
	assert.equal(view.element("sftp-start").disabled, false);
	assert.equal(view.element("sftp-save").disabled, false);
	assert.match(view.element("sftp-message").textContent, /SSH could not reach/);
	await updateSite(() =>
		fixture.runtime.accept(localState({ relaunch: true })),
	);
	assert.equal(view.element("sftp-start").disabled, true);
	assert.match(view.element("sftp-message").textContent, /Relaunch required/);
});

test("target SFTP exposes verified connection fields after start and retains a stop action", async (t) => {
	const defaults = serverState().sftp;
	let state = serverState({
		sftp: {
			...defaults,
			mode: "remote",
			target: "fixture.vm.eng.netsuite.com",
			state: "stopped",
			probe: "ready",
			connection: undefined,
			uploadUrl: "",
			recreateAvailable: false,
			canStart: true,
			canStop: false,
		},
	});
	const actions: string[] = [];
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/sftp") {
				const { action } = JSON.parse(String(request.options?.body)) as {
					action: string;
				};
				actions.push(action);
				assert.ok("mode" in state.sftp);
				state = serverState({
					sftp: {
						...state.sftp,
						state: action === "start" ? "running" : "stopped",
						connection:
							action === "start"
								? {
										username: "target_user",
										port: 8022,
										hostKey: "ssh-ed25519 target-key",
									}
								: undefined,
						uploadUrl:
							action === "start"
								? "sftp://fixture.vm.eng.netsuite.com:8022"
								: "",
						canStop: action === "start",
					},
				});
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [sftp]);
	t.after(view.cleanup);
	assert.equal(view.element("sftp-folder").hidden, true);
	assert.match(
		view.element("sftp-message").textContent,
		/Target SSH access verified/,
	);
	await view.element("sftp-start").click();
	assert.equal(view.element("sftp-upload").hidden, false);
	assert.equal(
		view.element("sftp-upload-url").textContent,
		"sftp://fixture.vm.eng.netsuite.com:8022",
	);
	assert.equal(view.element("sftp-netsuite-user").textContent, "target_user");
	assert.equal(view.element("sftp-netsuite-port").textContent, "8022");
	assert.equal(
		view.element("sftp-host-key").textContent,
		"ssh-ed25519 target-key",
	);
	assert.match(
		view.element("sftp-message").textContent,
		/SFTP access verified/,
	);
	assert.equal(view.element("sftp-stop").disabled, false);
	await view.element("sftp-stop").click();
	assert.deepEqual(actions, ["start", "stop"]);
	assert.equal(view.element("sftp-upload").hidden, true);
});
