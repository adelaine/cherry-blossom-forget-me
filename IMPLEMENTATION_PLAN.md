# Remaining structure refactor and acceptance work

This plan contains only unfinished work. The accepted layout below is a future refactor; it has not been implemented. Use commit `6ea9d7c` as the current baseline and `.ai-docs/backend-implementation.md` for completed implementation and verification evidence. Do not repeat completed checks unless a relevant change requires them.

## Accepted target layout

```text
ns-suitecontainer/
  app/
    engine/
      package.json
      package-lock.json
      tsconfig.json
      tsconfig.build.json
      client/
        src/
        test/
      server/
        src/
        test/
        vite.config.ts
      dist/                    # Generated production output
    setup/
      bootstrap/
      node/                    # npm wrapper and runtime-copy helper
      templates/               # Configuration and credential examples
      ...                      # Existing container, packaging, and platform tools
    docs/
    .cache/                    # Disposable bootstrap downloads and build cache
  home/
    suitecontainer.config.json
    credentials/
    repos/
    sftp-files/
    container-image/
    .cache/                    # Runtime tokens, descriptors, locks, runner state
  start/
    start-windows.cmd
    start-macos.command
    start-codebox
  README.md
```

Existing repository metadata and root `.ai-docs/` remain in their normal locations. The diagram shows application organization, not a replacement for Git metadata. No npm manifest belongs in the repository root. `app/` contains directories only.

Client and server form one application with one engine manifest, one lockfile, one dependency installation, and one coordinated build. Remove the client/server package manifests and npm workspace configuration after their dependencies and commands are consolidated. Do not create a shared source directory. The frontend may continue importing backend source, including `web-inactivity.ts`; removing that coupling is deferred indefinitely.

## 1. Consolidate source and npm ownership under engine

- Move the current client and server directories beneath `app/engine/`, preserving their source, assets, themes, and test files.
- Move every remaining `app/src` backend file into `app/engine/server/src`, including `install.ts`, deployment/configuration helpers, SQL helpers, SFTP implementations, Playwright communication, mount/SSH helpers, and `web-inactivity.ts`. Preserve existing module names initially. Update frontend and backend imports to the relocated files.
- Update consumers of the source compatibility re-exports in `web-server.ts`. Remove that adapter only when its consumers use the backend directly. Preserve compiled entry points still required by the launcher and helper commands.
- Move the parent manifest, lockfile, and TypeScript configs into `app/engine/`. Consolidate dependencies and scripts from the former client/server manifests. Replace workspace-delegating commands with direct engine commands for development, startup, build, typecheck, frontend tests, backend tests, and SFTP.
- Update the lockfile for the consolidated package without introducing dependency upgrades as part of the move.
- Move `copy-runtime.mjs` and `run-npm.mjs` into `app/setup/node/`. Resolve their source, dependency, and output paths explicitly. Keep compiled frontend assets, backend code, deployment workers, and required runtime dependencies together in `app/engine/dist/`.
- Keep frontend tests under `app/engine/client/test`. Move existing backend checks within `app/engine/server/test` to mirror their source subdirectories and filenames where applicable. Adjust existing imports and fixtures only as required by the move.

## 2. Separate installation paths from user data

- Introduce explicit installation, application, home, and cache paths in the launcher and backend. Replace the current assumption that one project directory owns source, configuration, and runtime state.
- Preserve `--project` as selection of the installation directory. Derive `app/` and the default `home/` from that selected installation. Resolve launcher paths from their own files rather than the caller's working directory.
- Move configuration, credentials, repositories, SFTP files, and image archives into `home/`. Preserve their contents and credential permissions. Define data-relative paths against `home/`; migrate existing configured relative paths without changing the locations they resolve to. Preserve configured absolute and external paths.
- Put shipped configuration/credential examples and defaults under `app/setup/templates/`. Update first-run initialization to seed only missing files in `home/` and preserve existing user configuration.
- Put private access tokens, connection descriptors, startup locks, and home-specific Playwright runner state under `home/.cache/`. Keep disposable Python/bootstrap downloads and build caches under `app/.cache/`. Preserve owner-only permissions for runtime credentials.
- Update discovery metadata, token-file references, project identity checks, container naming inputs, and idle restart behavior consistently. Do not reuse a stale descriptor or replay an uncertain mutation after a restart.
- Coordinate an idle stop before moving active runtime files or changing bind-mounted locations. Preserve active-job protection. Keep configuration writes in place where containers bind-mount individual files.

## 3. Relocate setup, launchers, and distribution inputs

- Move existing `setup/` tools into `app/setup/`, platform launchers into `start/`, and user-facing documentation into `app/docs/`. Include platform bootstrap helpers, container inputs, Python metadata, SFTP tools, Playwright support, and packaging tools.
- Update Windows, macOS, and codebox wrapper chains for the new paths. Update the local Chrome connection helper and other direct consumers of launcher, configuration, or descriptor paths.
- Update container COPY rules, ignore rules, source detection, build fingerprints, helper/worker entry points, and archive lookup paths. The container's established internal `/config`, `/workspace`, and runtime locations may remain unchanged while host mounts point to the new layout.
- Replace root/server/client dependency mounts with the single engine dependency volume. Keep Node dependencies and Vite cache in container-owned Linux storage. Refresh dependencies only through an explicit idle launch using the consolidated lockfile.
- Update Vite's root, watcher paths, ownership/restart classification, cache paths, and filesystem allow/deny rules. Preserve the working external Vite client loader, frontend reload behavior, public asset URLs, and production exclusion of development scripts.
- Update ZIP packaging and Git ignore rules for the new directory layout. Include application files, platform-appropriate launchers, and seed templates. Exclude live home configuration, credentials, repositories, SFTP data, runtime state, local notes, dependency directories, and generated development files. Preserve the optional shared-image loading path from `home/container-image/`.
- Update affected references in moved user-facing documentation. Leave README.md unchanged unless separately requested. Keep agent plans and implementation notes under root `.ai-docs/` and preserve its existing ignore rule.
- Remove obsolete source directories, package manifests, adapters, and path references after their consumers have migrated. Do not delete user data to make the layout match the diagram.

## 4. Verify the relocated application

These checks establish the new paths after implementation. They do not repeat the completed client extraction as a separate task.

- Run the existing checks relevant to each changed source, launcher, or packaging path. Confirm both frontend and backend checks resolve the relocated modules. Preserve all existing frontend cases and keep backend assertions minimal.
- Build the relocated standalone runtime and production image. Exercise compiled helper/worker entry points with controlled fixtures. Confirm frontend assets and authenticated browser/agent access still work from the built output.
- Launch through `start/start-windows.cmd` from an unrelated working directory. Exercise a selected installation path containing spaces and Unicode. Confirm the selected home, private descriptor/token files, and authenticated JSON publication use the new paths.
- Confirm Windows client source edits still reload the browser while preserving instance identity and authentication. Restore any temporary source edits. Confirm API stop and subsequent launcher restart work after the path migration.
- Build and inspect the relocated distribution ZIP. Exercise a fresh Windows installation from the extracted ZIP, including Python bootstrap and shared-image loading in PM mode. Confirm user data is initialized beneath `home/` and excluded from the archive.

## 5. Remaining backend acceptance

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

- Exercise compatible-instance reuse, competing starts through the home startup lock, and protected-work rejection of mode-changing replacement.
- Exercise stale descriptors and startup failure. Confirm instance-owned cleanup, rotated identity/credentials after full restart, loopback-only discovery, and identity/redirect/proxy checks before credentials are sent.
- Exercise API stop and actual process termination with controlled workers. Confirm protected work blocks API stop and termination cleans up workers, process groups, connections, timers, temporary snapshots, and listeners. Cleanup must remain idempotent.

## Execution boundaries

This plan update does not authorize implementation. Implement the accepted structure only when the user requests that work. Keep each migration checkpoint runnable and verify only the paths affected by that checkpoint.

Use existing checks. Do not add test cases, verification scripts, or a full-suite run without explicit authorization. Run each check once per relevant change. If it fails, make one targeted correction and rerun only the failed check. Stop after two failed attempts unless the user explicitly extends the limit. Do not reverify completed work merely for reassurance.

Run application code and development tools in the existing Oracle Linux/Node container. Windows is the required host. Exercise native macOS, Linux/codebox, and ARM only if available; otherwise record them as unverified. Do not install another host environment solely for acceptance.

Preserve API contracts, frontend behavior and styling, session/origin protections, loopback publication, credential handling, active-job protection, and worker lifecycle behavior. Do not trigger real deployments, database changes, or remote service recreation. Do not introduce a shared source directory, frontend redesign, JSX/browser-script extraction, or a new distribution mechanism as part of this layout refactor. Skill work, a separate MCP server, and cloud agent services remain deferred.

Remove completed items from this plan and record implementation evidence in `.ai-docs/backend-implementation.md`. Report remaining gaps and unverified platforms concisely.
