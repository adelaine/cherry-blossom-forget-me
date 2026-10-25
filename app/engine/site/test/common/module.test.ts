/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { siteModules } from "../../src/common/module.ts";
import { modules, moduleStyles } from "../../src/modules.ts";
import { credentials } from "../../src/workspace/credentials.tsx";
import { sql } from "../../src/tools/sql.tsx";

test("the module inventory registers workspace features before the available tools", () => {
	assert.deepEqual(
		modules.map((module) => [module.id, module.placement, module.slot]),
		[
			["credentials", "feature", "setup"],
			["suiteapps", "feature", "suiteapps"],
			["settings", "feature", "settings"],
			["deployment", "feature", "deployment"],
			["sql", "tool", undefined],
			["sftp", "tool", undefined],
			["playwright", "tool", undefined],
		],
	);
});

test("registration preserves the supplied inventory and rejects competing module identities", () => {
	const inventory = [credentials, sql];
	assert.equal(siteModules(inventory), inventory);
	assert.throws(
		() => siteModules([credentials, { ...sql, id: "credentials" }]),
		/Duplicate site module: credentials/,
	);
});

test("module styles include the shared workspace and tool styles in cascade order", () => {
	let preceding = -1;
	for (const selector of [
		".credential-steps{",
		".suiteapp-block{",
		"#settings-section{",
		".sftp-connection-grid{",
	]) {
		const position = moduleStyles.indexOf(selector);
		assert.ok(
			position > preceding,
			`${selector} must follow the previous module's styles.`,
		);
		preceding = position;
	}
});
