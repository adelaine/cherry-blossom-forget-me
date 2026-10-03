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
    readConfig,
    gitlabHttpsUrl,
    validBranch,
    validateConfig,
} from "../src/step-config.ts";
import { prepareToken, readToken } from "../src/step-token.ts";
import { readAuth } from "../src/step-auth.ts";
import {
    prepareCertificates,
    verifyCertificates,
} from "../src/step-certificates.ts";
import type { Config } from "../src/step-config.ts";
import { authenticationError } from "../src/step-suitecloud-errors.ts";
import { cloneRepos } from "../src/step-clone.ts";
import { deployRepos } from "../src/step-deploy.ts";
import { launchMounts, prepareConfiguration } from "../src/step-launch.ts";

test("builds mounts for external paths on Windows and Unix without splitting spaces", () => {
    const config: Config = {
        suiteapps: [{ directory: "local", localPath: "../local app" }],
        vms: [],
        certificates: { public: "../certs/public.pem", private: "credentials/private.pem", id: "cert" },
    };
    assert.ok(launchMounts(config, "/home/user/project", "linux").includes(
        "type=bind,src=/home/user/local app,dst=/workspace/local",
    ));
    assert.ok(launchMounts(config, "C:\\work\\project", "win32").includes(
        "type=bind,src=C:\\work\\certs\\public.pem,dst=/config/certs/public.pem,ro=true",
    ));
    config.suiteapps[0].localPath = "D:\\external app";
    assert.ok(launchMounts(config, "C:\\work\\project", "win32").includes(
        "type=bind,src=D:\\external app,dst=/workspace/local",
    ));
});

test("the app creates first-run configuration and preserves existing files", () => {
    withCertificateFixture((directory) => {
        mkdirSync(join(directory, "credentials"));
        const template = '{"suiteapps":[],"vms":[]}\n';
        const auth = '{"gitlab-token":"existing-token"}\n';
        writeFileSync(join(directory, "suitecontainer.config.example.json"), template);
        writeFileSync(join(directory, "credentials/auth.example.json"), auth);
        assert.equal(prepareConfiguration(directory), true);
        assert.equal(readFileSync(join(directory, "suitecontainer.config.json"), "utf8"), template);
        assert.equal(readFileSync(join(directory, "credentials/auth.json"), "utf8"), auth);
        writeFileSync(join(directory, "suitecontainer.config.json"), "existing config");
        assert.equal(prepareConfiguration(directory), false);
        assert.equal(readFileSync(join(directory, "suitecontainer.config.json"), "utf8"), "existing config");
        assert.equal(readFileSync(join(directory, "credentials/auth.json"), "utf8"), auth);
    });
});

test("explains fatal TLS alerts without blaming the authentication certificate", () => {
    const message = authenticationError(
        "(internal_error) Received fatal alert: internal_error",
        "absi-nsn",
        "runbox.vm.eng.netsuite.com",
    );
    assert.match(message, /Received fatal alert: internal_error/);
    assert.match(message, /absi-nsn/);
    assert.match(message, /runbox.vm.eng.netsuite.com/);
    assert.match(message, /VM url/);
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
const vms = [{ account: "12345", url: "runbox.netsuite.com" }];

test("loads credentials separately and uses the configured GitLab token", () => {
    withCertificateFixture((directory) => {
        const authPath = join(directory, "auth.json");
        const configPath = join(directory, "settings.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                suiteapps: [suiteapp],
                vms: [{ account: "12345", url: "runbox.netsuite.com" }],
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
            vms: [],
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
                    { suiteapps: [suiteapp], vms: [] },
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
                    { suiteapps: [suiteapp], vms: [] },
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
                vms: [],
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
                            vms,
                        },
                        true,
                    ),
                /certificate ID/,
            );
            const retry: Config = {
                suiteapps: [suiteapp],
                vms,
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
    assert.equal(
        validateConfig({ suiteapps: [suiteapp], vms }).suiteapps.length,
        1,
    );
    assert.throws(
        () =>
            validateConfig({
                suiteapps: [suiteapp, { ...suiteapp, directory: "PROJECT" }],
                vms,
            }),
        /unique "directory"/,
    );
    assert.throws(
        () =>
            validateConfig({
                suiteapps: [{ ...suiteapp, branch: "../main" }],
                vms,
            }),
        /invalid "branch"/,
    );
});

test("accepts local checkout configuration and rejects a missing checkout", () => {
    const local = {
        directory: "local-project",
        localPath: "/already-checked-out",
    };
    assert.doesNotThrow(() => validateConfig({ suiteapps: [local], vms }));
    assert.throws(() => cloneRepos([local]), /localPath is not a Git checkout/);
    assert.throws(
        () =>
            validateConfig({ suiteapps: [{ ...local, branch: "main" }], vms }),
        /cannot set both/,
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
        vms: [...vms, { account: "67890", url: "second.netsuite.com" }],
    };
    assert.doesNotThrow(() => validateConfig(config, true));
    for (const [vms, expected] of [
        [undefined, /"vms" list/],
        [[], /"vms" list/],
        [
            [
                ...config.vms,
                { account: "bad account", url: "third.netsuite.com" },
            ],
            /VM 3/,
        ],
        [
            [config.vms[0], { ...config.vms[1], url: "other.example.com" }],
            /VM 2.*NetSuite domain/,
        ],
    ] as const) {
        assert.throws(() => validateConfig({ ...config, vms }, true), expected);
    }
    assert.throws(
        () =>
            validateConfig(
                { ...config, certificates: { ...config.certificates, id: "" } },
                true,
            ),
        /certificate ID/,
    );
});

test("deploys each SuiteApp in order for each VM", (t) => {
    const root = mkdtempSync(join(tmpdir(), "suitecontainer-deploy-test-"));
    const suiteapps = [
        { directory: "first", localPath: "local-first" },
        { directory: "second", localPath: "local-second" },
    ];
    const targets = [...vms, { account: "67890", url: "second.netsuite.com" }];
    const events: string[] = [];
    const domainsByAuthId = new Map<string, string>();
    let activeDomain = "";
    t.mock.method(console, "log", () => {});
    try {
        for (const repo of suiteapps) {
            const path = join(root, repo.directory);
            mkdirSync(path);
            writeFileSync(join(path, "manifest.xml"), "<manifest/>");
            writeFileSync(join(path, "deploy.xml"), "<deploy/>");
        }
        const spawn = ((
            command: string,
            args: string[],
            options: { cwd: string },
        ) => {
            assert.equal(command, "suitecloud");
            if (args[0] === "account:manageauth")
                return { status: 1, stdout: "", stderr: "" };
            const app = basename(options.cwd);
            if (args[0] === "account:setup:ci") {
                if (args.includes("--domain")) {
                    activeDomain = args[args.indexOf("--domain") + 1];
                    domainsByAuthId.set(
                        args[args.indexOf("--authid") + 1],
                        activeDomain,
                    );
                } else {
                    activeDomain = domainsByAuthId.get(
                        args[args.indexOf("--select") + 1],
                    )!;
                }
                events.push(`${activeDomain}:${app}:auth`);
            } else {
                events.push(
                    `${activeDomain}:${app}:${args.includes("--dryrun") ? "dryrun" : "deploy"}`,
                );
            }
            return { status: 0, stdout: "", stderr: "" };
        }) as unknown as typeof import("node:child_process").spawnSync;
        deployRepos(
            {
                suiteapps,
                vms: targets,
                certificates: { public: "", private: "", id: "cert_1" },
            },
            "/private.pem",
            { workspaceRoot: root, spawn },
        );
        assert.deepEqual(
            events,
            targets.flatMap((vm) =>
                suiteapps.flatMap((repo) =>
                    ["auth", "dryrun", "deploy"].map(
                        (step) => `${vm.url}:${repo.directory}:${step}`,
                    ),
                ),
            ),
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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
