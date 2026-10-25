/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { suiteapps } from "../../src/workspace/suiteapps.tsx";
import { renderSite, type TestNode } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

interface SuiteApp {
	url: string;
	directory: string;
	branch?: string;
	localPath?: string;
	custom?: { deploy: boolean };
}

interface Configuration {
	suiteapps: SuiteApp[];
	vms: { account: string; url: string }[];
	custom: string;
}

const config: Configuration = {
	suiteapps: [
		{
			url: "https://gitlab.example/team/first.git",
			directory: "first",
			branch: "main",
			localPath: "C:\\work\\first",
			custom: { deploy: true },
		},
		{
			url: "git@gitlab.example:team/second.git",
			directory: "second",
			branch: "release/1",
		},
	],
	vms: [{ account: "000071", url: "fixture.vm.eng.netsuite.com" }],
	custom: "preserve this setting",
};

function field(root: TestNode, index: number, name: "url" | "branch") {
	const input = root
		.querySelectorAll("input")
		.find(
			(node) =>
				node.dataset.index === String(index) && node.dataset.field === name,
		);
	assert.ok(input, `SuiteApp ${index + 1} must have a ${name} field.`);
	return input;
}

test("SuiteApp edits, additions, and removals save without losing checkout metadata or other settings", async (t) => {
	let state = serverState({ config: JSON.stringify(config) });
	let saved: Configuration | undefined;
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/settings") {
				const body = JSON.parse(String(request.options?.body)) as {
					config: string;
				};
				saved = JSON.parse(body.config) as Configuration;
				state = serverState({ config: body.config, ready: true });
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [suiteapps]);
	t.after(view.cleanup);
	const rows = view.element("suiteapp-blocks");
	assert.equal(field(rows, 0, "url").value, config.suiteapps[0]!.url);
	assert.equal(field(rows, 0, "branch").value, "main");
	assert.match(rows.textContent, /Local checkout: C:\\work\\first/);
	field(rows, 0, "url").value =
		" https://gitlab.example/team/renamed.git?ref=release ";
	await field(rows, 0, "url").input();
	field(rows, 0, "branch").value = " release/2 ";
	await field(rows, 0, "branch").input();
	let draft = JSON.parse(fixture.runtime.configText) as Configuration;
	assert.equal(
		draft.suiteapps[0]!.url,
		"https://gitlab.example/team/renamed.git?ref=release",
	);
	assert.equal(draft.suiteapps[0]!.directory, "renamed");
	assert.equal(draft.suiteapps[0]!.branch, "release/2");
	assert.equal(draft.suiteapps[0]!.localPath, config.suiteapps[0]!.localPath);
	assert.deepEqual(draft.suiteapps[0]!.custom, { deploy: true });
	assert.deepEqual(draft.suiteapps[1], config.suiteapps[1]);
	await view.element("add-suiteapp").click();
	const added = field(rows, 2, "url");
	assert.equal(added.ownerDocument.activeElement, added);
	added.value = "git@gitlab.example:team/third.git";
	await added.input();
	field(rows, 1, "branch").value = "";
	await field(rows, 1, "branch").input();
	assert.equal(
		(JSON.parse(fixture.runtime.configText) as Configuration).suiteapps[1]!
			.branch,
		undefined,
	);
	const remove = rows
		.querySelectorAll("button")
		.find(
			(button) => button.getAttribute("aria-label") === "Remove SuiteApp 2",
		);
	assert.ok(remove);
	await remove.click();
	draft = JSON.parse(fixture.runtime.configText) as Configuration;
	assert.equal(draft.suiteapps.length, 2);
	assert.equal(draft.suiteapps[0]!.directory, "renamed");
	assert.deepEqual(draft.suiteapps[1], {
		url: "git@gitlab.example:team/third.git",
		directory: "third",
	});
	assert.deepEqual(draft.vms, config.vms);
	assert.equal(draft.custom, config.custom);
	assert.match(
		view.element("suiteapps-message").textContent,
		/SuiteApps changed/,
	);
	await view.element("save-suiteapps").click();
	assert.deepEqual(saved, draft);
	assert.equal(fixture.runtime.editing, false);
	assert.equal(fixture.runtime.snapshot?.ready, true);
	assert.equal(
		view.element("suiteapps-message").textContent,
		"SuiteApps saved.",
	);
	assert.equal(view.element("save-suiteapps").disabled, false);
});

test("a rejected SuiteApp save keeps the edited row available for correction and retry", async (t) => {
	let reject = true;
	let state = serverState({ config: JSON.stringify(config) });
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/settings") {
				if (reject)
					return Response.json(
						{ error: "Choose a branch available in this repository." },
						{ status: 400 },
					);
				const body = JSON.parse(String(request.options?.body)) as {
					config: string;
				};
				state = serverState({ config: body.config });
			}
			return state;
		},
	});
	const view = await renderSite(fixture, [suiteapps]);
	t.after(view.cleanup);
	const branch = field(view.element("suiteapp-blocks"), 0, "branch");
	branch.value = "release/candidate";
	await branch.input();
	const draft = fixture.runtime.configText;
	await view.element("save-suiteapps").click();
	assert.equal(fixture.runtime.configText, draft);
	assert.equal(branch.value, "release/candidate");
	assert.equal(fixture.runtime.editing, true);
	assert.match(
		view.element("suiteapps-message").textContent,
		/Choose a branch available/,
	);
	assert.equal(view.element("save-suiteapps").disabled, false);
	reject = false;
	await view.element("save-suiteapps").click();
	assert.equal(fixture.runtime.editing, false);
	assert.equal(
		view.element("suiteapps-message").textContent,
		"SuiteApps saved.",
	);
});
