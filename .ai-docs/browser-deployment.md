# Browser deployment flow

The Mac, Windows, and codebox launchers create missing defaults and import a GitLab token before installing Podman. Existing credentials and configuration are preserved. macOS prefers an existing Homebrew installation and otherwise uses the official processor-specific package in Terminal.

The launchers start a named, detached container per checkout, publish its HTTP port on host localhost, and open the deployment page after readiness. A second launch reopens the existing app. Codebox users receive SSH forwarding instructions. Stopped containers are replaced on the next launch; credentials, settings, and repositories persist on the host.

The container's `--web-paths` and `--web-mounts` commands prepare supported host mounts and record their identities in `credentials/web-mounts.json`. The page permits incomplete JSON settings, imports missing credentials through browser fields, and generates certificates only on an explicit button click when both paths are empty and no certificate files are mounted. External certificate paths and local repository mount changes require a manual relaunch. Never mount the Podman socket into the app.

Deployments use immutable settings/auth snapshots in a temporary directory and a child process. Settings changes, certificate generation, and shutdown are blocked during a run. The server retains bounded progress and results for browser refreshes and supports a new run after success or failure. The session deployment passkey is reused so SuiteCloud authentication remains usable across runs in the same container. Existing SuiteCloud preview/deployment behavior and the image's dependencies remain unchanged.

Configuration is written in place because it is a file bind mount. Credentials are mounted as a directory. Saved GitLab tokens, private key contents, and deployment passkeys are not returned to the page. Mutations require a session token and a matching localhost origin.

## Verification

The user removed the test approval override on 2026-10-02. All 72 automated tests pass: 22 Node tests, 18 Windows PowerShell/Pester tests, and 32 Bash/Bats tests, with no skips. The Node run included certificate generation and browser deployment lifecycle tests with Git's OpenSSL directory on PATH. The Bash suite ran under Git Bash on Windows; the launchers and installers use isolated mocks.

The Windows launcher uses `--publish` rather than `-p` to avoid PowerShell common-parameter binding in mocked Podman calls. The Bash test runner adds Git Bash's utility directories when invoked directly from PowerShell.

Use the existing TypeScript build and static parser checks independently of test execution. Native Mac double-click/install behavior, Windows Podman startup, codebox forwarding, and live GitLab/NetSuite deployment still require verification on their respective environments.

`start-macos.command` must retain Git mode `100755` and LF line endings. ZIP downloads may not preserve executable permissions or may carry macOS quarantine attributes; a Git clone is the supported executable-mode-preserving distribution path for this change.
