import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
    gitlabHttpsUrl,
    validBranch,
    validateConfig,
} from "../src/step-config.ts";
import { readToken } from "../src/step-token.ts";

const suiteapp = {
    url: "git@gitlab.eng.netsuite.com:team/project.git",
    directory: "project",
    branch: "release/1.0",
};

test("normalizes approved GitLab URLs and rejects other hosts", () => {
    assert.equal(
        gitlabHttpsUrl(suiteapp.url),
        "https://gitlab.eng.netsuite.com/team/project.git",
    );
    assert.equal(
        gitlabHttpsUrl("https://gitlab.eng.netsuite.com/team/project"),
        "https://gitlab.eng.netsuite.com/team/project.git",
    );
    assert.equal(
        gitlabHttpsUrl("https://other.example.com/team/project.git"),
        null,
    );
    assert.equal(
        gitlabHttpsUrl(
            "https://gitlab.eng.netsuite.com/team/project.git?token=x",
        ),
        null,
    );
});

test("accepts safe branch names", () => {
    assert.equal(validBranch("release/1.0"), true);
    for (const branch of [
        "../main",
        "release//next",
        "release/.hidden",
        "main.lock",
        "-invalid",
    ]) {
        assert.equal(validBranch(branch), false);
    }
});

test("validates SuiteApps and prevents duplicate directories", () => {
    assert.equal(validateConfig({ suiteapps: [suiteapp] }).suiteapps.length, 1);
    assert.throws(
        () =>
            validateConfig({
                suiteapps: [suiteapp, { ...suiteapp, directory: "PROJECT" }],
            }),
        /unique "directory"/,
    );
    assert.throws(
        () =>
            validateConfig({ suiteapps: [{ ...suiteapp, branch: "../main" }] }),
        /invalid "branch"/,
    );
});

test("requires deployment settings when requested", () => {
    const config = {
        suiteapps: [suiteapp],
        certificates: {
            public: "/certs/public.pem",
            private: "/certs/private.pem",
            id: "cert_1",
        },
        runbox: { account: "12345", url: "runbox.netsuite.com" },
    };
    assert.equal(validateConfig(config, true).runbox?.account, "12345");
    assert.throws(
        () =>
            validateConfig(
                { ...config, certificates: { ...config.certificates, id: "" } },
                true,
            ),
        /certificate ID/,
    );
    assert.throws(
        () =>
            validateConfig(
                {
                    ...config,
                    runbox: { ...config.runbox, url: "other.example.com" },
                },
                true,
            ),
        /NetSuite domain/,
    );
});

test("reads a GitLab token from the supported config formats", () => {
    const directory = mkdtempSync(join(tmpdir(), "suitecontainer-test-"));
    try {
        const envPath = join(directory, ".nems.env");
        const tomlPath = join(directory, "config.toml");
        writeFileSync(envPath, 'export GITLAB_TOKEN="env-token"\n');
        writeFileSync(tomlPath, '[gitlab]\ntoken = "toml-token"\n');
        assert.equal(readToken(envPath), "env-token");
        assert.equal(readToken(tomlPath), "toml-token");
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
