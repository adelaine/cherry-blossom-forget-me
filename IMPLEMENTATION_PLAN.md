# Remaining backend acceptance

The engine/home/start directory refactor is implemented. Completed migration and verification evidence is recorded in `.ai-docs/backend-implementation.md`. This plan contains only outstanding acceptance work. Do not repeat passing checks without a relevant change.

## Outstanding acceptance exercises

Use existing relevant checks and bounded manual exercises. Use controlled fixtures and fake executables for requests that start work. These are unverified acceptance items, not requests to reimplement existing API modules or services.

### Shared browser and agent API

- Exercise bearer access to targets, readiness, and configuration validation without a browser session. Confirm readiness/validation leave saved configuration, credentials, and remote services untouched.
- Verify stable target IDs, duplicate-identity handling, and explicit deployment selection. Confirm the execution snapshot contains only the selected target without overwriting saved selection, and preserve configured multi-target execution.
- Confirm authentication/origin failures use structured errors while preserving browser guards. Confirm capability, operation, and error responses do not expose private values.
- Exercise operation results, incremental cursors, the 512 KiB log bound, truncation, UTF-8 boundaries, and redaction across running-job chunks.
- Exercise simultaneous conflicting browser and bearer work. Confirm reservations cover asynchronous preparation and release after completion, failure, and supported cancellation. Confirm cancellation is advertised only where supported and completed history remains bounded to 100 records while active operations remain available.
- Exercise idempotency for equivalent normalized requests, changed payloads, and different operation IDs. Confirm original outcomes are reused, conflicts return `409 idempotency_conflict`, and expired outcomes return `410 idempotency_expired` without replay.
- Confirm previous-instance operation IDs return `410 operation_lost`, unknown current-instance IDs return `404 operation_not_found`, and reconnection never authorizes replay of uncertain mutations.

### Backend reload and dependency handover

- Exercise automatic reload of API routes and stateless server helpers, including a fake active job. Confirm identity, authentication, reservations, operation records, and process handles survive.
- Exercise a process-owning service change. Confirm pending restart/readiness reporting, rejection of conflicting work, and replacement using refreshed dependencies after jobs drain. Confirm managed SFTP explains blocked replacement and idle Playwright handover preserves the launcher-owned runner.
- Confirm lifecycle/coordinator changes require an explicit launcher restart. Confirm worker edits affect only subsequent executions.
- Change engine dependency inputs. Confirm refresh remains pending until an explicit idle launch, uses the engine lockfile and Linux volume, and never installs beneath active work.
- Confirm development stays available without browser heartbeats and filesystem routes cannot expose private files, runtime state, repositories, logs, tests, or workspace build output after the layout changes.

### Discovery and protected shutdown

- Exercise competing starts through the home startup lock and protected-work rejection of mode-changing replacement.
- Exercise stale descriptors and startup failure. Confirm credential rotation and identity/redirect/proxy checks before credentials are sent.
- Exercise API stop and actual process termination with controlled workers. Confirm protected work blocks API stop and termination cleans up workers, process groups, connections, timers, temporary snapshots, and listeners. Cleanup must remain idempotent.

## Unverified host platforms

- Exercise native macOS, Linux/codebox, and ARM only when those hosts are available. Bash wrapper syntax has been checked; that does not establish native execution.

## Execution boundaries

Use existing relevant checks and bounded manual exercises with controlled fixtures. Do not trigger real deployments, database changes, or remote service recreation. Do not add test cases or persistent verification scripts without an explicit request. Run a full suite only when the affected scope makes it necessary. Run each check once per relevant change; after failure, make one targeted correction and rerun only the failed check. Stop after two failures unless the user explicitly extends the limit.

Run application code and development tools in the existing Oracle Linux/Node container. Windows is the required host. Do not install another host environment solely for acceptance.

Keep client and server together in one npm package under `app/engine/`. Backend tests mirror `app/engine/server/src` under `app/engine/server/test`. Preserve existing frontend cases under `app/engine/client/test` and minimal backend assertions. Frontend imports of backend `web-inactivity.ts` are intentional. Do not create a shared source directory; source decoupling remains deferred indefinitely.

Preserve API contracts, frontend behavior and styling, session/origin protections, loopback publication, credential handling, active-job protection, and worker lifecycle behavior. Keep Git rules in the root `.gitignore` and `.gitattributes`; keep `app/` directories-only. Do not edit README.md. Keep agent notes under root `.ai-docs/` and preserve its ignore rule.

Frontend redesign, JSX/browser-script extraction, new distribution mechanisms, skill work, a separate MCP server, and cloud agent services remain deferred. Remove completed acceptance items from this plan and record their evidence in the handoff.
