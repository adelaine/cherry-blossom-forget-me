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
	} finally {
		await app.close();
	}
});
