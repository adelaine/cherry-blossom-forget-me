import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./main.fixture.ts";

test("serves the deployment page", async () => {
    const app = await fixture();
    try {
        assert.equal((await fetch(app.origin + "/")).status, 200);
    } finally { await app.close(); }
});
