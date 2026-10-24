import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../main.fixture.ts";

test("completes a deployment", async t => {
    if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) { t.skip("OpenSSL is unavailable"); return; }
    const workers = mkdtempSync(join(tmpdir(), "suitecontainer-worker-"));
    const workerScript = join(workers, "worker.cjs");
    writeFileSync(workerScript, "console.log('All SuiteApps were deployed.');");
    const config = { suiteapps: [{ directory: "app", url: "https://gitlab.eng.netsuite.com/team/app.git" }], vms: [{ account: "000071", url: "scrumbox.vm.eng.netsuite.com" }] };
    const app = await fixture(config, { workerScript });
    try {
        await app.post("generate", { replace: true });
        await app.post("credentials", { id: "certificate-id", token: "fixture-token" });
        await app.post("deploy", { config: JSON.stringify(config) });
        assert.equal((await app.finish("run")).state, "succeeded");
    } finally {
        await app.close();
        rmSync(workers, { recursive: true, force: true });
    }
});
