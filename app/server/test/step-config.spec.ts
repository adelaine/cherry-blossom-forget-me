import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../../src/step-config.ts";
import { suiteapp, vms, withConfigFixture } from "./step-config.fixture.ts";

test("loads configuration with separate credentials", () => {
    withConfigFixture(directory => {
        const authPath = join(directory, "auth.json");
        const configPath = join(directory, "settings.json");
        writeFileSync(configPath, JSON.stringify({ suiteapps: [suiteapp], vms }));
        writeFileSync(authPath, JSON.stringify({ "gitlab-token": "fixture-token", "suitecloud-certificates": { public: "credentials/public.pem", private: "credentials/private.pem", id: "cert_1" } }));
        assert.equal(readConfig(configPath, true, authPath).certificates?.id, "cert_1");
    });
});
