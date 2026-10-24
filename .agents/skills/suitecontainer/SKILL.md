---
name: suitecontainer
description: Operate SuiteContainer to configure SuiteApps and targets, check readiness, deploy, run SQL, manage SFTP, or run configured Playwright projects. Use for agents working on SuiteApps through an existing SuiteContainer installation. For changes to SuiteContainer itself, use develop-suitecontainer.
---

# SuiteContainer

Use SuiteContainer's shared API from the computer or codebox running the installation.
A deployment scrumbox is a target, not necessarily the machine running SuiteContainer.
This skill is self-contained and can be installed in a SuiteApp workspace.

## Discover and connect

1. Identify the SuiteContainer installation root from the task or available workspace context.
   Do not confuse it with the SuiteApp checkout.
   Ask for its location only if it cannot be determined.
2. For an existing instance, read `home/.cache/runtime/connection.json` below that root.
   Read [references/operations.md](references/operations.md) for descriptor validation and authentication.
3. If launching is part of the authorized task, use the platform launcher with `--json`:
   - Windows: `start/start-windows.cmd --json`.
   - Apple Silicon macOS: `bash start/start-macos.command --json`.
   - Linux x64/codebox: `bash start/start-codebox --json`.
   Run these on the installation host.
   The launcher may prepare dependencies or build an image.
   It returns connection metadata on stdout and diagnostics on stderr.
   `--json` implies `--non-interactive` and `--no-browser`.
   Starting the app does not deploy a SuiteApp.
4. Verify the unauthenticated health identity before reading or transmitting the access token.
   Use host-loopback HTTP without proxies or redirects.
   Authenticate with `Authorization: Bearer <access-token>`.
   Verify `instanceId` and `apiVersion` again in `GET /api/capabilities`.
5. Read the advertised capabilities before choosing endpoints or payloads.
   Use the advertised schemas and confirmation fields.
   Never send both bearer and browser credentials.

Do not assume a fixed port, container name, account, target ID, repository, or installation path.
Do not print token contents, credential files, private keys, passwords, or authenticated browser URLs.
Keep credentials in memory rather than shell arguments or generated transcripts.
Preserve the browser's separate session-token and origin protection.
If browser interaction is necessary, use the available agent-browser skill.

## Select the work

- Inspect `GET /api/state` and `GET /api/targets`.
- Select the target matching the requested account and domain.
  Use its returned `id`; do not compute one or choose the first target implicitly.
- Query `GET /api/readiness?target=<URL-encoded target ID>`.
- Validate a proposed configuration with `POST /api/validate`.
  Validation does not save settings or start a deployment.
- Save configuration only when the task includes that change.
  Target-specific deployment executes saved configuration.

Read the relevant section of [references/operations.md](references/operations.md) for deployment, credentials, SQL, SFTP, or Playwright.
Request missing inputs only when discovery and the saved configuration cannot supply them.

## Execute and follow results

Use a unique `Idempotency-Key` for each intended mutation.
Keep the same key and payload when recovering that same request within the same verified instance.
Record the returned `operationId` and `instanceId`.

For asynchronous work, inspect `GET /api/operations/:id` and incremental `GET /api/operations/:id/logs`.
Use the returned `nextCursor` for subsequent log reads.
Follow status at reasonable intervals without busy polling.
Stop following when the operation reaches `succeeded`, `failed`, or `cancelled`.
An HTTP 202 response means accepted, not completed.

After a lost response, rediscover the instance and inspect existing work before attempting recovery.
Never replay uncertain mutations using a new key, after an instance change, or after history has expired.
A local deployment failure or timeout can leave a remote deployment outcome unknown.
Check available NetSuite deployment history before proposing another deployment.

## Report and stop

Report the selected account/domain, operation ID, terminal state, and relevant result or error.
For a blocker, include its code, concise message, and required input or action.
State when a remote outcome remains unknown.
Do not stop a shared instance, rerun tests, change credentials, or perform another operation merely because the requested task finished.
