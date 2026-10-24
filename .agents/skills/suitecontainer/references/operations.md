# SuiteContainer operation reference

This reference describes API version 1 from the SuiteContainer source inspected on 2026-10-24.
The running instance's capabilities are authoritative for supported requests.
These examples describe requests; they do not authorize additional operations.

## Instance discovery and authentication

The installation stores its private descriptor at `home/.cache/runtime/connection.json`.
The access token is at `home/.cache/runtime/access-token`.

Validate the descriptor before using credentials:

- `schemaVersion` and `apiVersion` must be 1.
- `projectRoot` must resolve to the intended SuiteContainer installation.
- `containerName` must belong to that installation.
- `mode` must be `production` or `development`.
- `instanceId` must be a UUID-shaped identity.
- `tokenFile` must identify the expected access-token file below that installation's `home/.cache/runtime/`.
- `baseUrl` must be HTTP on `localhost`, `127.0.0.1`, or `::1`, with an explicit port.
  Reject credentials, query strings, fragments, and paths other than an empty path or `/`.

Use a client that disables proxies and rejects redirects.
First request `GET /health?activity=1` without credentials.
Compare the returned `instanceId` with the descriptor.
Only then read the owner-private token file and make authenticated API requests.
The launcher expects a 64-character lowercase hexadecimal token.
Reject a symlinked token file and preserve its owner-only access.
Do not relax file permissions to gain access.

Authenticate API calls with a bearer header.
Check the authenticated capabilities' `instanceId` and `apiVersion` against the descriptor.
For bearer requests, `Origin` is optional.
If supplied, it must match the application origin.
Do not reuse `x-session-token` from the browser for API automation.

On a codebox, perform discovery and requests on that host.
Use only an already authorized SSH connection or tunnel when remote access is needed.
A missing or stale descriptor requires explicit launcher discovery; do not scan ports or weaken host/origin checks.

## Configuration and targets

| Request | Purpose |
| --- | --- |
| `GET /api/state` | Read configuration, readiness, active work, and tool state. |
| `GET /api/capabilities` | Read schemas, required inputs, cancellation support, confirmations, authentication, and limits. |
| `GET /api/targets` | Obtain target `id`, `account`, `url`, and `displayName`. |
| `GET /api/readiness?target=<id>` | Read blockers for an explicit target. |
| `POST /api/validate` | Validate `{"config": <object>, "targetId": "<id>"}` without saving. |
| `POST /api/settings` | Save `{"config": <object>}` when requested. |

The saved host configuration is `home/config/suitecontainer.json`.
Credentials are separate in `home/credentials/auth.json`.
Inside the container, configuration is mounted at `/config/suitecontainer.json`.
Keep accounts and URLs as strings.

A SuiteApp entry uses a unique `directory` and either a remote repository `url` or a host `localPath`.
Remote entries may select a `branch`.
Local checkouts use their current branch and working files.
Do not clone, fetch, pull, or switch branches for a local checkout as a side effect.
Relative data paths resolve from the installation's `home/`.
Adding external checkout or certificate paths can require a relaunch to refresh mounts.
SuiteCloud can write configuration artifacts into a local checkout.

## Deployment

1. Confirm the requested SuiteApps are in the saved configuration.
2. Resolve an explicit target ID and check its readiness.
3. Submit `POST /api/deploy` with `{"targetId": "<returned ID>"}` and an idempotency key.
4. Follow the returned operation and incremental logs through completion.

Target-specific requests deploy the saved configuration for that target.
A proposed `config` in a new request is not a substitute for saving settings.
The older stringified-config contract can deploy multiple configured targets.
Use that only when the user explicitly requested that workflow.
The browser's Current VM is not evidence that a legacy multi-target deployment affects only one target.

Each SuiteApp runs a deployment preview before the actual deployment.
Earlier successful deployments are not rolled back if later work fails.
Deployment cancellation is not supported by the current API.
A CLI timeout, lost connection, or local process termination does not prove NetSuite stopped processing.

## Credentials and certificates

Use `POST /api/credentials` only for requested credential changes.
Its advertised fields include `token`, `public`, `private`, and certificate `id`.
`public` and `private` identify certificate paths.
Do not expose saved credential contents in reports.

`POST /api/generate` creates a certificate pair.
Replacing an existing pair requires `replace: true`, replaces generated certificate files, and clears the saved certificate ID.
Do not replace a pair unless the user's task authorizes replacement.
`GET /api/certificate` returns only the public certificate as PEM.

Register the public certificate on the target through:
Setup > Integration > Manage Authentication > OAuth 2.0 Client Credentials (M2M) Setup.
Select SuiteCloud Development Integration and the intended entity and role.
Save the assigned certificate ID before deploying.
Keep the private key on the installation host.

## SQL

`POST /api/sql` accepts `targetId`, `sql`, `account`, `database`, and exactly one of `password` or `unlock`.
Use the capability schema and saved defaults to identify the SQL database user and service.
Do not assume the SQL `account` field is the NetSuite deployment account.
The response includes an operation ID.

SQL uses SQL*Plus and separate database authentication.
End SQL statements with a semicolon.
End PL/SQL blocks with `/` on its own line.
Execution times out after 60 seconds.
Uncommitted work is rolled back when the session exits.
Explicit commits and Oracle implicit commits remain committed.
Run only the SQL requested by the user.
SQL and deployment cannot run concurrently.
SQL cancellation is not supported.

## SFTP

Use `POST /api/sftp` with an advertised `action`: `save`, `start`, `stop`, `probe`, or `recreate`.
Optional settings include `username`, `port`, `password`, and `path`.
SFTP uses the first configured VM.
Do not assume a deployment target ID selects the SFTP target.
The default port is 8000; the supported range is 1024-65535.
A blank password preserves the saved password.

On Windows and macOS, a tunnel exposes the local SFTP server on the deployment scrumbox's loopback interface.
A blank local path shares `home/sftp-files`; NetSuite accesses `/files`.
Local sharing is read-only.
A folder or SSH configuration change can require relaunching the app.
Keep the host and app running while NetSuite uses that share.

On an eligible codebox, SFTP can run in a target-side Podman container.
`recreate` requires `confirmReplace: true` and discards files inside the replaced container.
Obtain any missing replacement authorization before sending that flag.
Stopping the app does not necessarily stop target-side SFTP.
Return the verified connection fields supplied by the service.
Do not invent a host key or treat the SFTP port as HTTP.

## Playwright

Use `POST /api/playwright/run` with an explicit `targetId` and the saved enabled project settings.
Follow its operation and logs.
Cancel only when requested and the operation advertises `cancelSupported: true`.
Supported routes include `POST /api/operations/:id/cancel` and `POST /api/playwright/cancel`.
A configured Playwright run does not authorize additional tests or changes to the SuiteApp.

## Operations, errors, and shutdown

Operation states are `preparing`, `running`, `succeeded`, `failed`, and `cancelled`.
Fetch `GET /api/operations/:id/logs?cursor=<nextCursor>` for incremental output.
Honor `truncated`; retained output is bounded.
Do not claim missing earlier log content was inspected.

Errors include `error`, `code`, `retryable`, and `details`.
`retryable` does not establish that replaying an uncertain mutation is safe.

| Error | Response |
| --- | --- |
| `authentication_required` | Re-read the current descriptor and verify identity before re-authenticating. |
| `operation_conflict` | Inspect the returned operation ID and wait for or report that work. |
| `service_restart_pending` | Report the relaunch requirement and protect active work. |
| `idempotency_conflict` | A key was reused with different input; inspect the original request. |
| `idempotency_expired` | The outcome has left retained history; do not replay it. |
| `operation_lost` | The operation belonged to another instance; report the uncertain outcome. |
| `operation_not_found` | The current instance has no such record; do not infer success or failure. |

The current limits are 100 completed operations, 100 retained side-effect responses, 512 KiB of logs per operation, and 128 KiB per request.
Read capabilities for current limits.
Idempotency and operation history are scoped to one backend instance.

Use `POST /api/stop` only when stopping the app is requested.
Stop is refused during deployment or SQL preparation/execution.
Do not force-kill active work to bypass that refusal.
If the user explicitly requests a force stop, distinguish the local stop from any still-unknown remote outcome.
