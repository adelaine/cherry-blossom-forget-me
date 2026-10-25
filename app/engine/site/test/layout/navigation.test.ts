/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { renderSite } from "../browser-harness.ts";
import { createRuntimeFixture } from "../runtime-fixture.ts";

test("Jump to links follow the registered inventory and point to rendered sections", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const navigation = view.root.querySelector("nav");
	assert.ok(navigation);
	assert.equal(navigation.getAttribute("aria-label"), "Jump to a section");
	const links = navigation.querySelectorAll("a");
	assert.deepEqual(
		links.map((link) => [link.textContent, link.href]),
		[
			["Setup", "#credentials-section"],
			["SuiteApps", "#suiteapps-section"],
			["Deploy", "#deployment-section"],
			["SQL", "#sql-section"],
			["SFTP", "#sftp-section"],
			["Playwright", "#playwright-section"],
		],
	);
	for (const link of links) assert.ok(view.element(link.hash.slice(1)));
});

test("tool navigation opens collapsed details and scrolls beneath the section bar", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const navigation = view.root.querySelector("nav");
	assert.ok(navigation);
	navigation.offsetHeight = 48;
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
		assert.equal(target.style.scrollMarginTop, "calc(48px + 1rem)");
		assert.deepEqual(target.scrollOptions, { block: "start" });
	}
});

test("Setup navigation opens the VM details before scrolling to credentials", async (t) => {
	const view = await renderSite(createRuntimeFixture());
	t.after(view.cleanup);
	const vm = view.element("vm-section");
	vm.open = false;
	const link = view.root
		.querySelector("nav")!
		.querySelectorAll("a")
		.find((node) => node.hash === "#credentials-section");
	assert.ok(link);
	await link.click();
	assert.equal(vm.open, true);
	assert.deepEqual(view.element("credentials-section").scrollOptions, {
		block: "start",
	});
});
