import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchMounts, prepareConfiguration } from "../../src/step-launch.ts";
import { withConfigFixture } from "./step-config.fixture.ts";

test("builds Windows certificate mounts", () => {
    const config = { suiteapps: [{ directory: "local", localPath: "../local app" }], vms: [], certificates: { public: "../certs/public.pem", private: "credentials/private.pem", id: "cert" } };
    assert.ok(launchMounts(config, "C:\\work\\project", "win32").includes("type=bind,src=C:\\work\\certs\\public.pem,dst=/config/certs/public.pem,ro=true"));
});

test("creates first-run configuration", () => {
    withConfigFixture(directory => {
        mkdirSync(join(directory, "credentials"));
        const template = '{"suiteapps":[],"vms":[]}\n';
        writeFileSync(join(directory, "suitecontainer.config.example.json"), template);
        writeFileSync(join(directory, "credentials/auth.example.json"), '{"gitlab-token":"fixture-token"}');
        prepareConfiguration(directory);
        assert.equal(readFileSync(join(directory, "suitecontainer.config.json"), "utf8"), template);
    });
});
