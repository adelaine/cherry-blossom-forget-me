import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import test from "node:test";
import {
    gitlabHttpsUrl,
    validBranch,
    validateConfig,
} from "../src/step-config.ts";
import { prepareToken, readToken } from "../src/step-token.ts";
import { readAuth } from "../src/step-auth.ts";
import { readConfig } from "../src/step-config.ts";
import {
    prepareCertificates,
    verifyCertificates,
} from "../src/step-certificates.ts";
import type { Config } from "../src/step-config.ts";
import { authenticationError } from "../src/step-suitecloud-errors.ts";

test("explains fatal TLS alerts without blaming the authentication certificate", () => {
    const message = authenticationError(
        "(internal_error) Received fatal alert: internal_error",
        "absi-nsn",
        "runbox.vm.eng.netsuite.com",
    );
    assert.match(message, /Received fatal alert: internal_error/);
    assert.match(message, /absi-nsn/);
    assert.match(message, /runbox.vm.eng.netsuite.com/);
    assert.match(message, /runbox.url/);
    assert.match(message, /VPN/);
    assert.match(message, /does not identify the cause/);
    assert.match(message, /does not establish.*certificate ID is wrong/);
});

test("explains Java trust errors and preserves unknown authentication errors", () => {
    const trust = authenticationError(
        "PKIX path building failed: unable to find valid certification path",
        "project",
        "runbox.netsuite.com",
    );
    assert.match(trust, /Java trust store/);
    const unknown = authenticationError(
        "Invalid certificate ID",
        "project",
        "runbox.netsuite.com",
    );
    assert.match(unknown, /Invalid certificate ID/);
    assert.match(unknown, /suitecloud-certificates.id/);
    assert.doesNotMatch(unknown, /fatal TLS alert/);
    assert.match(
        authenticationError("", "project", "runbox.netsuite.com"),
        /without an error message/,
    );
});

const suiteapp = {
    url: "git@gitlab.eng.netsuite.com:team/project.git",
    directory: "project",
    branch: "release/1.0",
};

test("loads credentials separately and uses the configured GitLab token", () => {
    withCertificateFixture((directory) => {
        const authPath = join(directory, "auth.json");
        const configPath = join(directory, "settings.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                suiteapps: [suiteapp],
                runbox: { account: "12345", url: "runbox.netsuite.com" },
            }),
        );
        writeFileSync(
            authPath,
            JSON.stringify({
                "gitlab-token": "configured-token",
                "suitecloud-certificates": {
                    public: "credentials/public.pem",
                    private: "credentials/private.pem",
                    id: "cert_1",
                },
            }),
        );
        assert.equal(
            readConfig(configPath, true, authPath).certificates?.id,
            "cert_1",
        );
        const tokenPath = join(directory, "token");
        prepareToken(authPath, tokenPath);
        assert.equal(readFileSync(tokenPath, "utf8"), "configured-token");
        assert.equal(
            JSON.parse(readFileSync(configPath, "utf8")).certificates,
            undefined,
        );
    });
});

test("rejects malformed authentication settings", () => {
    withCertificateFixture((directory) => {
        const authPath = join(directory, "auth.json");
        for (const contents of [
            "{",
            "null",
            "[]",
            '{"gitlab-token":123}',
            '{"suitecloud-certificates":{"public":123,"private":"","id":""}}',
        ]) {
            writeFileSync(authPath, contents);
            assert.throws(() => readAuth(authPath), /auth.json/);
        }
        assert.throws(
            () => readAuth(join(directory, "missing.json")),
            /auth.json/,
        );
    });
});

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

function withCertificateFixture(action: (directory: string) => void): void {
    const directory = mkdtempSync(
        join(tmpdir(), "suitecontainer-certificates-"),
    );
    try {
        writeFileSync(
            join(directory, "auth.json"),
            JSON.stringify({ "gitlab-token": "fixture-token" }),
        );
        action(directory);
    } finally {
        assert.ok(
            resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
                basename(directory).startsWith("suitecontainer-certificates-"),
        );
        rmSync(directory, { recursive: true, force: true });
    }
}

test("keeps specified certificate paths and rejects a partial configuration", () => {
    withCertificateFixture((directory) => {
        const config: Config = {
            suiteapps: [suiteapp],
            certificates: {
                id: "existing",
                public: "public.pem",
                private: "private.pem",
            },
        };
        const sshDirectory = join(directory, "credentials");
        const configPath = join(directory, "auth.json");
        assert.equal(
            prepareCertificates(config, sshDirectory, configPath),
            false,
        );
        assert.equal(existsSync(sshDirectory), false);
        assert.equal(
            JSON.parse(readFileSync(configPath, "utf8"))["gitlab-token"],
            "fixture-token",
        );
        config.certificates!.private = "";
        assert.throws(
            () => prepareCertificates(config, sshDirectory, configPath),
            /Specify both/,
        );
        assert.equal(existsSync(sshDirectory), false);
    });
});

test("does not overwrite an incomplete existing certificate pair", () => {
    withCertificateFixture((directory) => {
        const sshDirectory = join(directory, "credentials");
        mkdirSync(sshDirectory);
        writeFileSync(
            join(sshDirectory, "private.pem"),
            "existing private key",
        );
        assert.throws(
            () =>
                prepareCertificates(
                    { suiteapps: [suiteapp] },
                    sshDirectory,
                    join(directory, "auth.json"),
                ),
            /only one certificate file/,
        );
        assert.equal(
            readFileSync(join(sshDirectory, "private.pem"), "utf8"),
            "existing private key",
        );
    });
});

test("removes partial files when OpenSSL cannot run", () => {
    withCertificateFixture((directory) => {
        const originalPath = process.env.PATH;
        const sshDirectory = join(directory, "credentials");
        try {
            process.env.PATH = "";
            assert.throws(() =>
                prepareCertificates(
                    { suiteapps: [suiteapp] },
                    sshDirectory,
                    join(directory, "auth.json"),
                ),
            );
        } finally {
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
        }
        assert.equal(existsSync(join(sshDirectory, "public.pem")), false);
        assert.equal(existsSync(join(sshDirectory, "private.pem")), false);
        assert.equal(
            JSON.parse(readFileSync(join(directory, "auth.json"), "utf8"))[
                "gitlab-token"
            ],
            "fixture-token",
        );
    });
});

test(
    "generates a matching RSA certificate pair, records paths, and reuses it",
    {
        skip:
            spawnSync("openssl", ["version"]).status !== 0
                ? "OpenSSL is not installed"
                : false,
    },
    () => {
        withCertificateFixture((directory) => {
            const sshDirectory = join(directory, "credentials");
            const configPath = join(directory, "auth.json");
            const config: Config = {
                suiteapps: [suiteapp],
                certificates: { id: "old_id", public: "", private: "" },
            };
            assert.equal(
                prepareCertificates(config, sshDirectory, configPath),
                true,
            );
            const publicPath = join(sshDirectory, "public.pem");
            const privatePath = join(sshDirectory, "private.pem");
            assert.equal(
                verifyCertificates(publicPath, privatePath),
                privatePath,
            );
            const publicContents = readFileSync(publicPath);
            const privateContents = readFileSync(privatePath);
            assert.equal(
                createPrivateKey(privateContents).asymmetricKeyDetails
                    ?.modulusLength,
                4096,
            );
            const certificate = new X509Certificate(publicContents);
            const validityDays =
                (Date.parse(certificate.validTo) -
                    Date.parse(certificate.validFrom)) /
                86_400_000;
            assert.equal(validityDays, 365);
            if (process.platform !== "win32")
                assert.equal(statSync(privatePath).mode & 0o777, 0o600);
            const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
            assert.deepEqual(savedConfig["suitecloud-certificates"], {
                id: "",
                public: "credentials/public.pem",
                private: "credentials/private.pem",
            });
            assert.equal(savedConfig.suiteapps, undefined);
            assert.equal(savedConfig["gitlab-token"], "fixture-token");
            assert.throws(
                () =>
                    validateConfig(
                        {
                            certificates:
                                savedConfig["suitecloud-certificates"],
                            suiteapps: [suiteapp],
                        },
                        true,
                    ),
                /certificate ID/,
            );
            const retry: Config = {
                suiteapps: [suiteapp],
                certificates: { id: "registered_id", public: "", private: "" },
            };
            assert.equal(
                prepareCertificates(retry, sshDirectory, configPath),
                false,
            );
            assert.equal(retry.certificates!.id, "registered_id");
            assert.deepEqual(readFileSync(publicPath), publicContents);
            assert.deepEqual(readFileSync(privatePath), privateContents);
        });
    },
);

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
