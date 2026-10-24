# Remaining backend, development mode, and agent access work

This plan contains unfinished acceptance work and fixes demonstrated by that work. Use the implementation and verification history in `.ai-docs/backend-implementation.md` as context. Do not repeat completed checks unless a relevant implementation change requires them.

## 1. Shared API acceptance

Use controlled fixtures and fake executables for work-starting requests.

- Exercise bearer requests for targets, target readiness, and configuration validation without a browser session or an Origin header. Confirm readiness and validation leave configuration, credentials, and remote services untouched.
- Verify stable target IDs, duplicate-identity rejection, and explicit deployment selection against saved configuration. Confirm the execution snapshot contains only the selected target and does not overwrite saved target selection. Preserve the legacy configured multi-target form.
- Verify malformed and conflicting authentication mechanisms and invalid supplied origins use structured errors without weakening browser guards.
- Exercise accepted operations, individual results, and incremental log cursors. Confirm the 512 KiB log limit, truncation indicators, UTF-8 boundaries, and redaction across running-job chunk boundaries.
- Exercise simultaneous conflicting browser and bearer requests. Confirm reservation begins before asynchronous preparation and releases on completion, failure, and supported cancellation.
- Exercise idempotency for equivalent normalized requests, changed payloads, and different operation IDs. Confirm retries return the original outcome or operation, conflicting input returns `409 idempotency_conflict`, and expired retained outcomes return `410 idempotency_expired` without replay.
- Verify cancellation is advertised and accepted only where supported. Confirm active operations remain available while completed history is bounded to 100 records.
- Verify previous-instance operation IDs return `410 operation_lost`, unknown current-instance IDs return `404 operation_not_found`, and clients never replay uncertain mutations after reconnection or restart.
- Confirm new operation, error, and capability responses do not expose credentials or private-key contents.

## 2. Development reload acceptance

- Exercise automatic reload of API route modules and stateless server helpers.
- During a fake active job, reload routes and confirm instance identity, authentication, reservations, operation records, and process handles remain available.
- Edit a process-owning service. Confirm state and readiness report a pending restart, conflicting work is rejected, and replacement happens after jobs drain. Confirm the refreshed service dependency graph is used.
- Confirm managed SFTP reports why an idle service replacement is blocked. Verify idle Playwright service handover preserves the launcher-owned runner.
- Confirm lifecycle and coordinator source changes report the documented explicit-launcher restart requirement instead of silently retaining stale code or restarting the process automatically.
- Edit worker code and confirm only subsequent executions load the change.
- Change dependency inputs. Confirm refresh stays pending until an explicit idle development launch, uses the lockfile and project-owned Linux volumes, and never installs beneath an active job. Verify root, server, and client workspace dependencies remain isolated from host node_modules.
- Verify development stays available without browser heartbeats and Vite filesystem routes cannot serve credentials, runtime connection files, private keys, cloned repositories, logs, or build output.

## 3. Discovery, shutdown, and distribution acceptance

- Reuse a compatible live project instance and confirm identity and credentials are preserved. Exercise competing starts through the project startup lock and reject mode-changing replacement during protected work.
- Exercise explicit project paths with spaces and Unicode through the Windows wrapper chain. Confirm project selection comes from the wrapper or `--project`, rather than an unrelated current directory.
- Exercise stale descriptors, startup failure, full restart, and shutdown. Confirm instance-owned descriptor cleanup, rotated identity and credentials after a full restart, loopback-only discovery, and rejection of mismatched identity, redirects, and proxy routing before credentials are sent.
- Exercise API stop and process termination with controlled workers. Confirm protected jobs block API stop and actual termination cleans up workers, process groups, connections, timers, temporary snapshots, and listeners. Cleanup must remain idempotent.
- Exercise a fresh Windows installation from an extracted distribution ZIP, including its Python bootstrap and the current shared image when using PM mode.

## Execution boundaries

Mirror backend source subdirectories and module names under `app/server/test`, including `api/` and `services/`. Backend checks for the remaining `app/src` helpers keep those modules' names. Frontend tests stay under `app/client/test` beside `app/client/src`; preserve their existing cases. Keep backend checks focused on successful workflows with minimal assertions. Keep shared fixtures beside the relevant tests:

```text
app/server/
  src/
  test/
```

Use existing relevant checks and bounded manual exercises. Do not add new tests, verification scripts, or a full-suite run without a separate request. Run each check once per relevant change. On failure, make one targeted correction and rerun only the failed check. After two failed attempts, stop and report the failure unless the user explicitly extends that limit.

Run application code and development tools in the existing Oracle Linux/Node container. Windows is the required host. Exercise macOS/Linux hosts and native ARM only if available; otherwise record them as unverified. Do not install another host environment solely for acceptance.

Do not trigger real deployments, database changes, or remote service recreation. Preserve the shared browser/agent API, existing frontend behavior, loopback publication, credential protections, and in-place writes for bind-mounted files. Derive application paths from the selected project root.

Keep implementation notes in `.ai-docs/` and leave its ignore rule unchanged. Do not modify README.md. Skill implementation, packaging, installation, and validation remain deferred until a separate explicit request. A separate MCP server, cloud agent service, frontend redesign, and new package distribution mechanism remain outside this phase.

As each remaining item is completed, remove it from this plan and record its evidence in the implementation handoff. Finish with a concise account of any fixes, checks performed, remaining gaps, and unverified platforms.
