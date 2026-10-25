import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApplicationFixture } from "./application.fixture.ts";

test("saves credentials", async () => {
	const app = createApplicationFixture();
	try {
		const response = await app.post("credentials", { token: "fixture-token" });
		assert.equal(response.status, 200);
		assert.equal(
			JSON.parse(readFileSync(app.authPath, "utf8"))["gitlab-token"],
			"fixture-token",
		);
		const credentials = app.lifecycle.services.credentials;
		credentials.write({
			...credentials.read(),
			"suitecloud-authentication": {
				method: "certificates",
				accounts: {
					saved: {
						authId: "saved-auth",
						sdkVersion: "fixture-sdk.jar",
						company: "Saved company",
						role: "Administrator",
						account: "000099",
						url: "saved.vm.eng.netsuite.com",
					},
				},
			},
		});
		const selected = await app.post("credentials", { connectionId: "saved" });
		assert.equal(selected.status, 200);
		assert.deepEqual(
			(app.lifecycle.services.configuration.read().vms as unknown[])[0],
			{
				account: "000099",
				url: "saved.vm.eng.netsuite.com",
			},
		);
		assert.equal(
			credentials.read()["suitecloud-authentication"]?.method,
			"browser",
		);
		assert.equal(credentials.read()["gitlab-token"], "fixture-token");
	} finally {
		await app.close();
	}
});
