/* Copyright (c) 2026, Oracle and/or its affiliates. */
import test from "node:test";
import assert from "node:assert/strict";
import type { ServerState } from "../../src/common/state.ts";
import { credentials } from "../../src/workspace/credentials.tsx";
import { settings } from "../../src/workspace/settings.tsx";
import { sql } from "../../src/tools/sql.tsx";
import { renderSite, updateSite } from "../browser-harness.ts";
import { createRuntimeFixture, serverState } from "../runtime-fixture.ts";

interface SqlPayload {
	config: string;
	host?: string;
	account: string;
	password?: string;
	unlock?: string;
	database: string;
}

const sqlConfig = {
	suiteapps: [],
	vms: [
		{ account: "000071", url: "first.vm.eng.netsuite.com" },
		{ account: "000072", url: "second.vm.eng.netsuite.com" },
	],
};
const password = "test/$& secret";

test("SQL preserves edits, uses Current VM, renders text, and retains request errors", async (t) => {
	const idle = serverState({
		config: JSON.stringify(sqlConfig),
		sql: {
			defaults: { user: "TEST_ACCOUNT", service: "test.service" },
			passwordHint: "<a riddle & hint>",
		},
	});
	let response: ServerState = idle;
	let sent: SqlPayload | undefined;
	let reject = false;
	const fixture = createRuntimeFixture({
		state: idle,
		respond(request) {
			if (request.path === "/api/sql") {
				sent = JSON.parse(String(request.options?.body)) as SqlPayload;
				if (reject)
					return Response.json(
						{ error: "Connection input is invalid." },
						{ status: 400 },
					);
				response = serverState({
					...idle,
					sql: {
						...idle.sql,
						state: "running",
						host: sqlConfig.vms[0].url,
						database: sent.database,
					},
				});
			}
			return response;
		},
	});
	const view = await renderSite(fixture, [credentials, settings, sql]);
	t.after(view.cleanup);
	assert.equal(view.element("sql-account").value, "TEST_ACCOUNT");
	assert.equal(view.element("sql-password").value, "");
	assert.equal(
		view.element("sql-password-hint").textContent,
		"<a riddle & hint>",
	);
	view.element("sql-account").value = "OTHER_ACCOUNT";
	await view.element("sql-account").input();
	view.element("sql-password").value = password;
	await view.element("sql-password").input();
	view.element("sql-statement").value = "select 'hello' from dual;";
	await view.element("sql-statement").input();
	assert.equal(view.element("sql-run").disabled, false);
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-account").value, "OTHER_ACCOUNT");
	await view.element("sql-run").click();
	assert.ok(sent);
	assert.equal(sent.host, undefined);
	assert.equal(JSON.parse(sent.config).vms[0].url, sqlConfig.vms[0].url);
	assert.equal(sent.account, "OTHER_ACCOUNT");
	assert.equal(sent.password, password);
	assert.equal(view.element("sql-run").disabled, true);
	assert.equal(view.element("sql-password").disabled, true);
	assert.equal(view.element("stop").disabled, true);
	response = serverState({
		...idle,
		sql: {
			...response.sql,
			state: "succeeded",
			output: "<script>query data</script>",
		},
	});
	await updateSite(fixture.runtime.refresh);
	assert.equal(
		view.element("sql-output").textContent,
		"<script>query data</script>",
	);
	assert.equal(
		view.element("sql-output").innerHTML,
		"&lt;script&gt;query data&lt;/script&gt;",
	);
	assert.equal(view.element("sql-run").disabled, false);
	assert.equal(view.element("sql-password").value, password);
	const changed = {
		...sqlConfig,
		vms: [{ ...sqlConfig.vms[0], url: "" }, sqlConfig.vms[1]],
	};
	view.element("config").value = JSON.stringify(changed);
	await view.element("config").input();
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-run").disabled, true);
	view.element("vm").value = "changed.vm.eng.netsuite.com";
	await view.element("vm").input();
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-run").disabled, false);
	reject = true;
	await view.element("sql-run").click();
	assert.equal(
		JSON.parse(sent.config).vms[0].url,
		"changed.vm.eng.netsuite.com",
	);
	await updateSite(fixture.runtime.refresh);
	assert.match(
		view.element("sql-message").textContent,
		/Connection input is invalid/,
	);
});

test("SQL offers masked manual and unlock fields and sends only the chosen credential", async (t) => {
	const state = serverState({
		config: '{"vms":[{"url":"scrumbox.vm.eng.netsuite.com"}]}',
		sql: {
			defaults: { user: "TEST_USER", service: "test.service" },
			passwordHint: "hint",
			hasDefaultPassword: true,
		},
	});
	let sent: SqlPayload | undefined;
	const fixture = createRuntimeFixture({
		state,
		respond(request) {
			if (request.path === "/api/sql")
				sent = JSON.parse(String(request.options?.body)) as SqlPayload;
			return state;
		},
	});
	const view = await renderSite(fixture, [sql]);
	t.after(view.cleanup);
	view.element("sql-statement").value = "SELECT 1 FROM dual;";
	await view.element("sql-statement").input();
	view.element("sql-password").value = "manual-password";
	await view.element("sql-password").input();
	assert.equal(view.element("sql-run").disabled, false);
	await view.element("sql-run").click();
	assert.ok(sent);
	assert.equal(sent.password, "manual-password");
	assert.equal(sent.unlock, undefined);
	view.element("sql-unlock").value = "unlock-string";
	await view.element("sql-unlock").input();
	assert.equal(view.element("sql-password").value, "");
	assert.equal(view.element("sql-run").disabled, false);
	await view.element("sql-run").click();
	assert.equal(sent.unlock, "unlock-string");
	assert.equal(sent.password, undefined);
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-unlock").value, "unlock-string");
	view.element("sql-password").value = "another-manual-password";
	await view.element("sql-password").input();
	assert.equal(view.element("sql-unlock").value, "");
	state.sql.hasDefaultPassword = false;
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-unlock").disabled, true);
	assert.equal(view.element("sql-run").disabled, false);
	assert.match(view.root.innerHTML, /id="sql-unlock" type="password"/);
	assert.match(
		view.root.innerHTML,
		/<div class="grid"><div><label for="sql-password">[\s\S]*?<div><label for="sql-unlock">[\s\S]*?<\/div><\/div>/,
	);
	view.element("sql-account").value = "MANUAL_USER";
	await view.element("sql-account").input();
	state.sql.defaults = { user: "UPDATED_USER", service: "updated.service" };
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-account").value, "MANUAL_USER");
	assert.equal(view.element("sql-database").value, "updated.service");
	state.config = '{"vms":[{"url":"other.vm.eng.netsuite.com"}]}';
	state.sql.defaults = { user: "OTHER_USER", service: "other.service" };
	await updateSite(fixture.runtime.refresh);
	assert.equal(view.element("sql-account").value, "OTHER_USER");
	assert.equal(view.element("sql-database").value, "other.service");
});
