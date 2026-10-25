import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationFixture } from "./application.fixture.ts";
import { browserAccountKey } from "../../src/workspace/suitecloud-auth.ts";

test("completes a deployment", async (t) => {
	const workers = mkdtempSync(join(tmpdir(), "suitecontainer-worker-"));
	const workerScript = join(workers, "worker.cjs");
	writeFileSync(workerScript, "console.log('All SuiteApps were deployed.');");
	const config = {
		suiteapps: [
			{
				directory: "app",
				url: "https://gitlab.eng.netsuite.com/team/app.git",
			},
			{
				directory: "later-app",
				url: "https://gitlab.eng.netsuite.com/team/later-app.git",
			},
		],
		vms: [{ account: "000071", url: "scrumbox.vm.eng.netsuite.com" }],
	};
	const app = createApplicationFixture(config, { workerScript });
	t.mock.method(app.lifecycle.services.credentials, "certificateState", () => ({
		hasExisting: true,
		error: "",
		publicPath: join(app.credentials, "public.pem"),
		privatePath: join(app.credentials, "private.pem"),
	}));
	try {
		const credentials = await app.post("credentials", {
			authenticationMethod: "certificates",
			public: "credentials/public.pem",
			private: "credentials/private.pem",
			id: "certificate-id",
			token: "fixture-token",
		});
		assert.equal(credentials.status, 200);
		const deployment = await app.post("deploy", {
			config: JSON.stringify(config),
		});
		assert.equal(deployment.status, 202);
		assert.equal((await app.finish("run")).state, "succeeded");
		assert.equal(
			app.lifecycle.services.credentials.read()["suitecloud-deployments"],
			undefined,
		);
		writeFileSync(
			workerScript,
			`process.send(${JSON.stringify({
				type: "suiteapp-deployed",
				...config.vms[0],
				suiteapp: "app",
			})}); process.exitCode = 1;`,
		);
		assert.equal(
			(await app.post("deploy", { config: JSON.stringify(config) })).status,
			202,
		);
		assert.equal((await app.finish("run")).state, "failed");
		const key = browserAccountKey(config.vms[0]!);
		const success =
			app.lifecycle.services.credentials.read()["suitecloud-deployments"]?.[
				key
			];
		assert.equal(success?.suiteapp, "app");
		assert.ok(success?.completedAt);
		writeFileSync(workerScript, "process.exitCode = 1;");
		assert.equal(
			(await app.post("deploy", { config: JSON.stringify(config) })).status,
			202,
		);
		assert.equal((await app.finish("run")).state, "failed");
		assert.deepEqual(
			app.lifecycle.services.credentials.read()["suitecloud-deployments"]?.[
				key
			],
			success,
		);
	} finally {
		await app.close();
		rmSync(workers, { recursive: true, force: true });
	}
});
