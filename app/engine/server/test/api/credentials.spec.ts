import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "../main.fixture.ts";

test("saves credentials", async () => {
	const app = await fixture();
	try {
		await app.post("credentials", { token: "fixture-token" });
		assert.equal(
			JSON.parse(readFileSync(app.authPath, "utf8"))["gitlab-token"],
			"fixture-token",
		);
	} finally {
		await app.close();
	}
});
