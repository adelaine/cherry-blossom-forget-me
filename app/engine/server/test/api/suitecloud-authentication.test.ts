/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import type { Auth } from "../../src/common/auth.ts";
import type { Target } from "../../src/common/context.ts";
import type { Operation } from "../../src/common/operations.ts";
import { browserAccountKey } from "../../src/workspace/suitecloud-auth.ts";
import { SuiteCloudAuthenticationService } from "../../src/workspace/services/SuiteCloudAuthenticationService.ts";
import { createBrowserLoginFixture } from "../workspace/suitecloud-auth.fixture.ts";

test(
	"browser sign-in persists the selected account and role for the installed SDK",
	{ timeout: 5000 },
	async (t) => {
		const fixture = createBrowserLoginFixture(t);
		const { app, config } = fixture;
		const otherKey = browserAccountKey(config.vms[0]!);
		const otherAccount = {
			authId: "retained-account",
			sdkVersion: basename(fixture.sdk),
			company: "Other company",
			role: "Other role",
			...config.vms[0]!,
		};
		app.lifecycle.services.credentials.write({
			"gitlab-token": "fixture-token",
			"suitecloud-authentication": {
				method: "browser",
				accounts: { [otherKey]: otherAccount },
			},
		});
		const targets = await app.request<{ targets: Target[] }>("/api/targets");
		const selected = targets.body.targets[1]!;
		const response = await app.post<{ operationId: string; url: string }>(
			"suitecloud/login",
			{ targetId: selected.id },
		);
		assert.equal(response.status, 200);
		assert.equal(response.body.url, fixture.loginUrl);
		const id = response.body.operationId;
		const operation = app.lifecycle.operations.get(id);
		assert.equal(operation.kind, "suitecloud-authentication");
		assert.equal(operation.state, "running");
		assert.equal(operation.cancelSupported, true);
		assert.deepEqual(operation.targets, [selected.id]);
		const { args, options } = fixture.started();
		assert.ok(args.includes(fixture.sdk));
		assert.ok(args.includes("authenticate"));
		assert.equal(args[args.indexOf("-url") + 1], selected.url);
		assert.ok(
			options.env?.JAVA_TOOL_OPTIONS?.includes(
				join(app.credentials, "suitecloud"),
			),
		);
		assert.equal(
			options.env?.SUITECLOUD_FALLBACK_PASSKEY,
			readFileSync(join(app.credentials, "suitecloud/passkey"), "utf8"),
		);
		const temporary = fixture.handoffDirectory();
		await fixture.complete({
			status: "SUCCESS",
			data: {
				accountInfo: {
					companyId: selected.account,
					companyName: "Selected company",
					roleName: "Developer",
				},
			},
		});
		const completed = await app.request<Operation>("/api/operations/" + id);
		assert.equal(completed.body.state, "succeeded");
		assert.deepEqual(completed.body.result, {
			company: "Selected company",
			role: "Developer",
		});
		const stored = JSON.parse(readFileSync(app.authPath, "utf8")) as Auth;
		assert.equal(stored["gitlab-token"], "fixture-token");
		assert.deepEqual(
			stored["suitecloud-authentication"]!.accounts![otherKey],
			otherAccount,
		);
		const selectedKey = browserAccountKey(config.vms[1]!);
		const account =
			stored["suitecloud-authentication"]!.accounts![selectedKey]!;
		assert.equal(account.account, selected.account);
		assert.equal(account.url, selected.url);
		assert.equal(account.company, "Selected company");
		assert.equal(account.role, "Developer");
		assert.equal(account.sdkVersion, basename(fixture.sdk));
		assert.match(
			account.authId,
			new RegExp(`^browser_${selectedKey}_[a-f0-9]{8}$`),
		);
		const services = app.lifecycle.services;
		const restored = new SuiteCloudAuthenticationService(
			services.configuration,
			services.credentials,
			services.suiteapps,
		);
		assert.equal(restored.status().accounts[selectedKey]!.connected, true);
		assert.equal(existsSync(temporary), false);
		assert.equal(app.lifecycle.operations.busy(), false);
		const discovery = await app.post<{ operationId: string; url: string }>(
			"suitecloud/login",
			{ url: selected.url },
		);
		assert.equal(discovery.status, 200);
		await fixture.complete({
			status: "SUCCESS",
			data: {
				accountInfo: {
					companyId: "000099",
					companyName: "Discovered company",
					roleName: "Administrator",
				},
			},
		});
		assert.equal(
			app.lifecycle.operations.get(discovery.body.operationId).state,
			"succeeded",
		);
		const discovered = app.lifecycle.services.configuration.read();
		assert.deepEqual((discovered.vms as typeof config.vms)[0], {
			account: "000099",
			url: selected.url,
		});
		assert.deepEqual((discovered.vms as typeof config.vms)[1], config.vms[1]);
		const savedConnection =
			app.lifecycle.services.authentication.status().accounts[
				browserAccountKey({ account: "000099", url: selected.url })
			];
		assert.equal(savedConnection?.company, "Discovered company");
		const discoveredVm = { account: "000099", url: selected.url };
		services.credentials.recordDeployment(discoveredVm, "bank-feeds");
		services.credentials.recordDeployment(config.vms[0]!, "retired-app");
		const remembered =
			services.credentials.read()["suitecloud-authentication"]!.accounts!;
		fixture.setAuthentications(
			Object.values(remembered)
				.filter((account) => account.authId !== otherAccount.authId)
				.map((account) => account.authId),
		);
		const reconciled = new SuiteCloudAuthenticationService(
			services.configuration,
			services.credentials,
			services.suiteapps,
		).status();
		assert.equal(reconciled.accounts[otherKey], undefined);
		assert.equal(
			services.credentials.read()["suitecloud-authentication"]!.accounts![
				otherKey
			],
			undefined,
		);
		assert.equal(
			services.credentials.read()["suitecloud-deployments"]?.[otherKey],
			undefined,
		);
		assert.equal(
			reconciled.accounts[browserAccountKey(discoveredVm)]!
				.lastSuccessfulDeployment?.suiteapp,
			"bank-feeds",
		);
	},
);

test(
	"cancelling browser sign-in terminates its worker and releases the reservation",
	{ timeout: 5000 },
	async (t) => {
		const fixture = createBrowserLoginFixture(t);
		const { app } = fixture;
		const targets = await app.request<{ targets: Target[] }>("/api/targets");
		const before = readFileSync(app.authPath, "utf8");
		const login = await app.post<{ operationId: string }>("suitecloud/login", {
			targetId: targets.body.targets[1]!.id,
		});
		assert.equal(login.status, 200);
		const id = login.body.operationId;
		const temporary = fixture.handoffDirectory();
		assert.equal(app.lifecycle.operations.busy(), true);
		const cancelled = await app.post<Operation>(
			"operations/" + id + "/cancel",
			{},
		);
		assert.equal(cancelled.status, 200);
		assert.equal(cancelled.body.state, "cancelled");
		assert.equal(
			app.lifecycle.services.authentication.status().state,
			"cancelled",
		);
		assert.equal(fixture.started().child.signalCode, "SIGTERM");
		assert.equal(existsSync(temporary), false);
		assert.equal(readFileSync(app.authPath, "utf8"), before);
		assert.equal(app.lifecycle.operations.busy(), false);
		const next = app.lifecycle.operations.reserve("sql", []);
		app.lifecycle.operations.finish(next.id, {});
	},
);

test(
	"SDK sign-in failure retains a readable redacted error and cleans its handoff",
	{ timeout: 5000 },
	async (t) => {
		const fixture = createBrowserLoginFixture(t);
		const { app } = fixture;
		const targets = await app.request<{ targets: Target[] }>("/api/targets");
		const login = await app.post<{ operationId: string }>("suitecloud/login", {
			targetId: targets.body.targets[1]!.id,
		});
		const temporary = fixture.handoffDirectory();
		await fixture.complete({
			status: "ERROR",
			errorMessages: [`Login was not completed at ${fixture.loginUrl}`],
		});
		const failed = await app.request<Operation>(
			"/api/operations/" + login.body.operationId,
		);
		assert.equal(failed.body.state, "failed");
		assert.match(
			failed.body.error!.error,
			/Login was not completed at \[redacted\]/,
		);
		assert.equal(
			app.lifecycle.services.authentication.status().error,
			failed.body.error!.error,
		);
		assert.equal(
			app.lifecycle.services.credentials.read()["suitecloud-authentication"],
			undefined,
		);
		assert.equal(existsSync(temporary), false);
		assert.equal(app.lifecycle.operations.busy(), false);
	},
);
