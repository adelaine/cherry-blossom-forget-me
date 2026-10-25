/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { renderSite } from "../browser-harness.ts";
import { createRuntimeFixture } from "../runtime-fixture.ts";

test("page links follow the registered inventory and point to rendered sections", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const navigation = view.root.querySelector("nav");
	assert.ok(navigation);
	assert.equal(navigation.getAttribute("aria-label"), "SuiteContainer");
	const links = navigation.querySelectorAll("a");
	assert.deepEqual(
		links.map((link) => [link.textContent, link.href]),
		[
			["NS Account", "#credentials-section"],
			["SuiteApps", "#suiteapps-section"],
			["Deploy", "#deployment-section"],
			["SQL", "#sql-section"],
			["SFTP", "#sftp-section"],
			["Playwright", "#playwright-section"],
		],
	);
	for (const link of links) assert.ok(view.element(link.hash.slice(1)));
	assert.equal(links[0].getAttribute("aria-current"), "page");
	assert.equal(view.element("setup-page").hidden, false);
	assert.equal(view.element("deployment-page").hidden, true);
});

test("tool navigation opens the selected page and preserves mounted drafts", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const navigation = view.root.querySelector("nav");
	assert.ok(navigation);
	view.element("sql-statement").value = "select 1 from dual";
	await view.element("sql-statement").input();
	for (const id of ["sql-section", "sftp-section", "playwright-section"]) {
		const target = view.element(id);
		target.open = false;
		const link = navigation
			.querySelectorAll("a")
			.find((node) => node.hash === "#" + id);
		assert.ok(link);
		const event = await link.click();
		assert.equal(event.defaultPrevented, true);
		assert.equal(target.open, true);
		assert.equal(view.element(id.replace("-section", "-page")).hidden, false);
		assert.equal(view.element("setup-page").hidden, true);
		assert.equal(link.getAttribute("aria-current"), "page");
	}
	assert.equal(view.element("sql-page").hidden, true);
	assert.equal(view.element("sftp-page").hidden, true);
	assert.equal(view.element("sql-statement").value, "select 1 from dual");
});

test("NS Account navigation preserves its accordion state and Help does nothing", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const vm = view.element("vm-section");
	vm.open = false;
	const links = view.root.querySelector("nav")!.querySelectorAll("a");
	await links.find((node) => node.hash === "#deployment-section")!.click();
	assert.equal(view.element("deployment-page").hidden, false);
	const link = links.find((node) => node.hash === "#credentials-section");
	assert.ok(link);
	await link.click();
	assert.equal(vm.open, false);
	assert.equal(view.element("setup-page").hidden, false);
	assert.equal(view.element("deployment-page").hidden, true);
	await view.element("help").click();
	assert.equal(view.element("setup-page").hidden, false);
});
