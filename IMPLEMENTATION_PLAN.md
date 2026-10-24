# Backend, development mode, and agent access implementation plan

Implement this plan in the current repository checkout. The implementation environment is Windows/PowerShell at `C:\webdev\ns-suitecontainer`. Treat that path as environment context, never as an application default. Derive paths from the selected project root.

Deliver one backend implementation used by the browser and coding agents through the shared API. Keep host behavior portable across Windows, macOS, and Linux/codebox wherever possible. Run application code and development tools in the existing Oracle Linux/Node container.

This is a handoff for a separate implementing agent. Implement the application and launcher changes described below. Skill implementation is deferred as specified in section 9. A separate MCP server, cloud agent service, frontend redesign, and new package distribution mechanism are outside this phase.

**1. Architecture and scope**

Use this request flow:

```text
Browser ---> API ---> Services ---> Tools/processes
Agent -----> API
```

The API shown above is one shared entry point for the browser and agents. Both call the same operations directly and share the same validation, permissions, operation state, and results. Keep the API contract independent of the calling client.

The host launcher owns runtime installation, Podman lifecycle, mounts, connection discovery, and optional browser opening. These operations must work before the API exists. Tool validation, readiness, target resolution, execution, concurrency, and operation results belong to the backend. The API itself is the agent interface. Do not add a separate tool-command interface, prescribe a Python client, or duplicate backend logic in a client or the deferred skill.

Use this structure, adding files only where they have a concrete responsibility:

```text
app/
  package.json
  server/
    package.json
    vite.config.ts
    src/
      main.ts
      api/
        credentials.ts
        suiteapps.ts
        deployment.ts
        sql.ts
        sftp.ts
        playwright.ts
        operations.ts
        system.ts
      services/
        credentials.ts
        suiteapps.ts
        deployment.ts
        sql.ts
        sftp.ts
        playwright.ts
        configuration.ts
        operations.ts
setup/
  Containerfile
  bootstrap/
    bootstrap.py
    ...existing platform wrappers...
```

Keep types beside their owning API or service. Do not introduce `common/`, `runtime/`, `middleware/`, or `workers/` directories. Do not add `startup.ts` or `dev.ts` initially. Use small supporting service modules when needed.

Keep Alpine.js, its CSP-compatible build, Pico CSS, and current visual behavior. Frontend extraction into `site/` remains a later phase. Frontend changes in this phase are limited to compatibility, shared API contracts, request IDs, and development-server integration.

Read applicable repository instructions before implementation. Do not modify `README.md`. Keep this existing plan in place. Put implementation notes and handoff notes in `.ai-docs/`. Leave the existing `.ai-docs/` ignore rule unchanged. Do not create skill files during this phase.

**2. Preserve existing behavior and establish ownership**

Inspect the relevant source before restructuring. Reuse existing integration logic and existing behavioral checks. Do not start with a full baseline test run.

Pay particular attention to:

- `app/src/web-server.ts`: routes, request guards, configuration writes, readiness, operation state, and shutdown.
- `app/src/install.ts`: server startup, internal launcher helpers, deployment-worker execution, and exit codes.
- Deployment, certificate, SQL, SFTP, Playwright, mount, and SSH modules.
- `setup/bootstrap/`, `setup/Containerfile`, runtime copying, build exclusions, and `setup/package.py`.
- Existing API, browser, launcher, and packaged-runtime tests relevant to each change.

Preserve existing endpoint paths and response fields. Introduce additive fields and new endpoints where required. Accept existing request forms through normalization at the API boundary. Do not maintain separate human and agent endpoint implementations. Preserve no-argument launcher behavior and existing helper arguments, including registration-related exit code `10`.

Create service instances explicitly and inject them into the HTTP application. Services must work without Hono's request context and without a browser session.

| Service | Owns |
|---|---|
| Credentials | Persistence, safe status, certificate inspection/generation, and public-certificate retrieval |
| SuiteApps | Repository configuration validation, checkout readiness, and mount requirements |
| Deployment | Targeted execution snapshots, deployment preparation, worker launch, progress, and results |
| SQL | Request validation, credentials, query execution, timeout, redaction, and results |
| SFTP | Configuration, status, probing, start/stop, and explicitly confirmed recreation |
| Playwright | Configuration validation, runner integration, start/cancel, status, and results |
| Configuration | Shared configuration reads/writes and consistent snapshots |
| Operations | Shared reservations, operation IDs, bounded result/log records, and duplicate-request detection |

API modules normalize and parse requests, call services, and serialize responses. Services enforce business validation and conflict rules. Keep child-process management out of HTTP handlers. Keep authentication, security headers, request limits, and error mapping in `main.ts` initially.

Retain `/api/state` as the aggregate view assembled from those services. Browser and agent requests must observe the same active operations and blocking reasons.

**3. Define one public API contract**

Keep the `/api` namespace. Publish `apiVersion: 1` and capability metadata through a new `GET /api/capabilities` endpoint. Version numbers describe the contract; they are not separate human and agent APIs.

Implement these interfaces in this phase:

| Capability | Shared API interface |
|---|---|
| Instance and tool status | Existing `GET /api/state` |
| Supported actions and schemas | New `GET /api/capabilities` |
| Configured targets | New `GET /api/targets` |
| Readiness for a target | New `GET /api/readiness?target=<id>` |
| Configuration validation without saving | New `POST /api/validate` |
| Deployment | Existing `POST /api/deploy`, with explicit target selection |
| Individual operation status | New `GET /api/operations/<id>` |
| Incremental operation logs | New `GET /api/operations/<id>/logs?cursor=<cursor>` |
| Supported cancellation | New `POST /api/operations/<id>/cancel` |
| Shutdown | Existing `POST /api/stop` |
| Configuration, credentials, certificates, SQL, SFTP, Playwright | Existing routes, through the same API/service modules |

Expose existing tool capabilities through these shared routes without building a second workflow for agents. Describe the implemented requests and responses in the implementation handoff notes under `.ai-docs/`, without creating a skill reference. Preserve `/api/check`, `/api/settings`, `/api/heartbeat`, and existing tool routes used by the frontend.

Capability metadata must list supported methods, paths, required inputs, response fields, cancellation support, and destructive confirmation requirements. Define runtime request schemas beside the owning API modules and reuse them for validation and capability descriptions. Do not hand-maintain a second set of validation rules in the client.

Contract requirements:

- Return JSON for API success and failure responses, except existing binary downloads such as the public certificate. Describe binary response content types in the API contract.
- Preserve the existing human-readable `error` field. Add stable `code`, `retryable`, and non-secret `details` fields to errors. Use meaningful HTTP status codes for authentication, malformed input, conflicts, missing operations, and internal errors.
- Include instance identity in capabilities and state. Include an operation ID when deployment, SQL, or Playwright work is accepted. Keep existing response fields intact.
- Expose readiness as `ready` plus structured blockers with a stable code, a message, and the affected capability or target. Report actions such as certificate registration or remount/restart as blockers rather than prompting from the server.
- Accept validation input as a JSON object. For existing routes that currently receive a stringified `config`, normalize both the legacy form and the new object form in one place.
- `targets` returns opaque stable IDs derived from the configured account and normalized target URL, plus safe display fields. Do not use array indexes as IDs. Reject ambiguous duplicate target identities.
- New deployment request forms require an explicit target ID from every client. The backend resolves it against current configuration and creates an immutable execution snapshot for that selection. Do not silently choose `vms[0]` or overwrite saved target selection. Preserve existing explicitly configured multi-target deployment behavior for legacy requests.
- Readiness and validation must not save configuration, generate credentials, or start remote work.

**4. Share operation state, concurrency, and lifecycle**

Use one operation coordinator for browser and agent API requests. Reserve conflicting work before asynchronous preparation starts. Release reservations on completion, failure, and cancellation where supported. Configuration mutations must respect the same existing cross-tool restrictions.

An operation record contains `id`, `instanceId`, `kind`, selected targets, `state`, timestamps, `cancelSupported`, and either a safe result or a structured error. Use `preparing`, `running`, `succeeded`, `failed`, and `cancelled` states. Do not claim cancellation support for a tool that cannot safely cancel its work.

Use `Idempotency-Key` for requests that start work or cause side effects. Each client generates one key per intended action and retains it for any retry of that action. The service coordinator records the key and normalized request fingerprint before preparation begins. Repeating the same key and payload returns the original result or operation; using the same key with different input returns `409 idempotency_conflict`. Legacy requests without a key remain accepted, but do not gain a retry guarantee.

Keep this phase's operation history in memory. Retain active operations and up to 100 completed operations per instance. Keep logs bounded, retaining the existing 512 KiB deployment-log limit. Return a next cursor and a truncation indicator when older log content has been discarded. Redact before exposing log chunks, including while a job is running.

Scope operation IDs and retry guarantees to the running instance. A full backend restart creates a new instance ID. Return `410 operation_lost` for an operation from a previous instance and `404 operation_not_found` for an unknown current-instance ID. Do not automatically replay a mutation after a restart or a connection loss with unknown outcome. A durable queue or persistent job database is outside this phase.

Preserve deployment ordering, SQL credential handling/timeouts/retries, local versus target-side SFTP behavior, explicit destructive-replacement confirmation, and mount-change detection. Preserve in-place writes where replacing a bind-mounted file would leave the container using the old inode.

Keep the existing 15-minute production inactivity grace period. Successful authenticated API activity from any client refreshes it, including state and operation polling. Unauthenticated health checks and static asset requests do not. Active jobs and active managed SFTP retain their existing protection from inactivity shutdown. In development mode, disable inactivity shutdown until an explicit stop or process shutdown.

Every client requests shutdown through `/api/stop` and receives the same shutdown policy. Refuse shutdown during protected work using the existing conflict rules. On an actual process termination, clean up managed workers, connections, timers, temporary files, and listeners. Do not leave workers running after their owning backend has exited. Cleanup must be idempotent.

**5. Add explicit local authentication and connection discovery**

Use one listener and the same routes for browser and non-browser callers. Preserve the existing browser session token and same-origin protection. Add bearer authentication for agent API requests; do not ask agents to scrape a browser URL or manufacture an `Origin` header.

- Browser requests continue to use `x-session-token` and the existing origin checks for mutations.
- Non-browser requests use `Authorization: Bearer <token>` and may omit `Origin`. If an `Origin` is supplied, require the same allowed origin checks. Reject conflicting credential mechanisms rather than selecting one silently.
- Keep host publication on loopback. Do not enable permissive CORS, expose a LAN listener, or weaken browser guards to accommodate agents.
- This phase trusts the local OS user who can read the access token. It does not introduce accounts, per-agent roles, or remote credential provisioning. Business restrictions and destructive-action confirmations apply identically to every authenticated client.

The launcher generates a cryptographically random token of at least 256 bits for each new backend instance. Store it in `<project>/.cache/runtime/access-token` and mount that file into the container read-only. Do not pass it on a process command line. Give the runtime directory and credential files owner-only access using POSIX permissions or Windows ACLs as appropriate. Fail with an actionable error if secure credential storage cannot be established.

After startup succeeds, write `<project>/.cache/runtime/connection.json` with `schemaVersion`, `apiVersion`, `instanceId`, `projectRoot`, `containerName`, host-loopback `baseUrl`, mode, and the token-file path. Do not include token contents. Discover the published host port through Podman rather than assuming a fixed port. Complete an authenticated handshake before publishing the descriptor as ready.

API clients read the descriptor and token internally. Status responses, launch JSON, and logs never print the token or browser session URL. Keep explicit browser opening in the launcher. Validate the descriptor's schema, selected project identity, loopback destination, and current instance identity before sending credentials. Ignore proxy settings for this loopback connection. Do not follow redirects with credentials. Describe discovery and authentication in the implementation handoff notes so an agent can call the API directly using its available request tools without a skill.

Reuse a live instance and its credentials when appropriate. Serialize competing starts for the same project with a host-side startup lock. Publish the descriptor atomically after readiness. On stop or startup failure, remove only descriptors owned by that instance. Treat stale descriptors as `instance_unavailable`; do not silently start or replace a container when an API operation was requested.

Agent shell/network permissions are separate from application authentication. Return actionable errors for denied Podman, filesystem, or loopback access. Do not change agent sandbox settings or automatically elevate privileges. Retain platform installation flows where already supported, but noninteractive mode must report required human action instead of waiting indefinitely.

**6. Keep portable environment launchers**

Keep runtime bootstrap and startup orchestration in the existing `setup/bootstrap/` implementation. Platform wrappers locate/bootstrap Python, forward arguments, and preserve exit codes. Host Node.js must not be required. The existing Python bootstrap does not imply a Python API-client architecture.

Forward arguments through all existing wrapper chains, including Windows CMD -> PowerShell -> Python and macOS/Linux shell -> Python. Preserve quoting, paths with spaces, Unicode, and exit status. Do not use shell command strings for ordinary process execution where argument arrays suffice.

Limit new launcher options to environment startup and discovery:

- No arguments: preserve the current human launch-and-open behavior.
- `--dev`: launch or reuse a compatible development instance. Refuse a mode-changing replacement while work is active.
- `--no-browser`: suppress automatic browser opening.
- `--non-interactive`: report required human action instead of prompting or pausing for a keypress.
- `--json`: emit one JSON launch result on stdout, including safe instance metadata and the connection-descriptor path. Send progress and diagnostics to stderr. This implies no interactive prompts, keypress pauses, or browser opening.
- `--project <path>`: select a project explicitly; otherwise use the checkout associated with the wrapper. Do not infer a different project from an arbitrary current directory.

Provide the same startup options through `start-windows.cmd`, `start-macos.command`, and `start-codebox`. For example, the Windows development launch is `.\start-windows.cmd --dev --no-browser --json`. These scripts prepare and start the environment. After discovery, agents use the API described in section 3 directly. Do not add deployment, SQL, SFTP, or Playwright command wrappers to these launchers.

Preserve the startup scripts, internal bootstrap helpers, and their exit semantics, including registration-related exit code `10`. Their arguments are implementation details for starting the environment and preparing its mounts or configuration. Do not expand them into a public tool-operation interface or add compatibility adapters for a nonexistent one.

Keep implementation platform-neutral where possible. Isolate path conversion, file permissions, runtime installation, and Podman-machine differences in the bootstrap layer. Do not require users to move a Windows checkout into WSL or assume a particular Podman VM provider.

**7. Keep explicit application and worker entry paths**

Use `main.ts` to construct the Hono application and expose explicit server-start and internal worker entry paths. Importing it must not open a listener, create a new session, register repeated signal handlers, or start background work.

Keep process-owning service instances, the operation coordinator, and authentication state in the outer server lifecycle. Pass them into each rebuilt route application. Loading a service-definition module must not instantiate services. `vite.config.ts` can own this development lifecycle; a new runtime directory is not required. Route invalidation must not dispose or recreate those owners.

Separate API submission from internal worker execution. Browser and agent deployment requests enter through the API and reserve work through the shared coordinator. The deployment service then launches a worker against the immutable snapshot. The existing `--deploy` argument is an internal execution mode; preserve it or update its callers together if it is renamed. The worker executes the deployment directly and must never resubmit through the API or recursively launch another deployment worker. Do not add a public submission adapter. Resolve source and compiled worker paths explicitly for development and production.

Existing startup helpers that determine mounts, prepare initial configuration, or report paths may run before the API is available. Keep that narrow bootstrap exception. It must not become a second route for starting user tool operations outside the coordinator.

**8. Add container development mode with Hono/Vite**

Use `@hono/vite-dev-server` for the reloadable HTTP application. Check the current documented API and select compatible dependency versions. Keep SuiteCloud CLI, Java, SQL*Plus, Git, and SSH inside the existing Oracle Linux/Node environment.

Development mode must:

- Bind-mount application source from the selected host checkout.
- Keep Linux dependencies and Vite caches in container-owned storage, isolated from host `node_modules` and from other projects.
- Reuse existing configuration, credentials, repositories, SFTP, SSH, and Playwright integration mounts.
- Reuse a container stage with the system tools. Rebuild it only when those tools or the container definition change.
- Refresh dependencies from the committed lockfile when dependency inputs change. Report pending dependency refresh and apply it on the next explicit development launch while idle; do not reinstall underneath a running job. Instance reuse must compare dependency inputs before deciding that the current installation is compatible.
- Listen on an interface reachable through container port publication while publishing only on host loopback.
- Serve the API, frontend assets, and Vite update connection through the advertised host endpoint. Configure the WebSocket connection for the actual published port.

Define this reload policy:

- Routes and stateless helpers update automatically.
- Route reloads preserve instance identity, credentials for all clients, reservations, job records, and process handles.
- Changes to process-owning services mark a service restart as pending. Show the reason in state/readiness and reject new conflicting jobs. After active jobs drain, the outer lifecycle disposes the affected idle services, loads updated definitions and dependencies, constructs replacements, and swaps the route dependencies. Keep the operation coordinator, authentication, and instance identity alive. Report managed services that prevent an idle restart instead of silently retaining stale code.
- Service replacement must refresh the affected dependency graph, not just import the same cached constructor. If the selected Hono/Vite version cannot support this boundary, report the limitation instead of substituting an uncontrolled whole-process reload.
- A full backend process/container restart goes through the host launcher, rotates instance identity and credentials, and republishes the connection descriptor. A stopped or crashed instance requires an explicit launch. Clients rediscover it and do not replay uncertain mutations. An in-process service restart does not rewrite the read-only token file or require a continuously running host launcher.
- Worker changes affect subsequent executions without altering an active worker's loaded code.

Do not assume that suppressing browser refresh prevents server-module replacement. Ensure the actual Hono/Vite loading boundary preserves the service owners.

Require source edits made by Windows applications or agents to become visible without an image rebuild. Provide a configurable polling fallback for file systems that do not deliver watcher events. Limit polling to relevant source/configuration paths and exclude repositories, credentials, dependencies, logs, and build output. Keep native watching where reliable. Vite documents the relevant WSL2 limitation and polling tradeoff in its [server watcher documentation](https://vite.dev/config/server-options#server-watch).

Keep development source serving restricted to application files. Do not expose the project credentials, runtime connection files, private keys, or cloned repositories through Vite's filesystem routes. Account for Vite's client script and WebSocket in development security headers without weakening production policy.

**9. Do not implement the skill in this phase**

Skill implementation requires a separate, explicit user request. Do not create or modify `SKILL.md`, skill references, skill helpers, discovery files, or skill installation configuration as part of this plan. Do not package, install, publish, or validate a skill. Do not add placeholder skill files or change ignore rules to prepare for one.

The shared API and direct agent access remain in scope. Implement authentication, discovery, capability metadata, target selection, operation tracking, and the other backend requirements without depending on a skill. Keep the current frontend preserved as required in section 1.

Retain this future design direction only: a built-in, self-contained, shareable skill would live at `.agents/skills/suitecontainer/SKILL.md`, with its API reference in the same skill folder. It would be separate from `.ai-docs/` and use the shared API without duplicating backend logic. These paths are reserved design choices, not files to create in this phase.

Skill absence is intentional and must not block completion of the backend refactor. Report the skill as deferred, not implemented or tested.

**10. Update build and packaging together**

Update workspace scripts, TypeScript configuration, imports, runtime copying, container paths, build exclusions, and `setup/package.py` together. Preserve existing frontend assets and required runtime dependencies.

The packaged production application must include the compiled server, internal worker and bootstrap-helper entry paths, and platform wrappers. It must run without Vite, TypeScript, or other development dependencies. Avoid output cleanup that deletes another build's artifacts. Skill packaging is outside this phase. Exclude runtime descriptors, access tokens, credentials, and local agent notes from all artifacts.

**11. Implementation sequence and focused acceptance**

Implement in this order:

1. Extract service ownership and route modules while preserving existing behavior.
2. Add shared operation records, target selection, capability/readiness interfaces, and structured errors.
3. Add bearer authentication and secure discovery for direct agent API access.
4. Add development mode, dependency storage, file watching, and controlled restart behavior.
5. Update application packaging and record the implemented API access procedure in the handoff notes. Leave skill implementation deferred.

Use existing relevant checks for each changed area. Update existing checks only as required by changed paths or the intended behavior. Do not create new test files, extra validation scripts, or a broad audit without an explicit user request. Run each applicable check once per change. If it fails, make one targeted correction and rerun only that check. After two failed attempts, stop and report the failure. Record gaps that existing checks do not cover.

Use existing controlled fixtures, fake executables, and bounded manual exercises for these acceptance cases. Do not trigger real deployments, database changes, or remote service recreation:

- Existing frontend actions, API response fields, internal launcher helpers, and registration exit behavior remain compatible.
- The Windows launcher starts development mode with no browser, prompt, or pause and emits valid JSON while progress goes to stderr.
- An agent obtains capabilities, targets, readiness, and an operation result directly through the API without a dedicated client wrapper or a browser session token.
- Browser and agent API requests share validation and conflict rules. Simultaneous conflicting requests cannot launch duplicate work.
- Repeating a mutation with the same request ID returns the original outcome. Reusing it for different input is rejected.
- Target selection is explicit and does not accidentally operate on the first configured target or alter saved selection.
- Tokens are protected and excluded from responses, logs, Vite files, and packaged output. Existing browser origin protections still apply.
- Polling keeps an authenticated production client active. Development remains available without a browser heartbeat.
- Windows host edits update the application without rebuilding the image. Dependencies remain container-owned.
- Route reloads preserve service instances, credentials, and job tracking. Service changes trigger the documented idle restart instead of leaving stale code active.
- Stop and process termination clean up resources. Clients detect expired descriptors and lost operations without replaying mutations.
- Production packaging works without development dependencies or a skill.
- Direct agent API access works without skill files. Skill creation, packaging, installation, and validation remain deferred.

Windows is the required available host for implementation verification. Keep macOS/Linux branches portable and exercise them only if those environments are available. Do not claim cross-platform execution based solely on Windows results. Do not install another host environment merely to satisfy this plan.

Deliver the implementation with a concise explanation of the shared API/service boundary, startup and API access procedure, checks performed, uncovered acceptance cases, and unverified platforms. State that skill implementation is deferred. Stop when the authorized implementation is complete.
