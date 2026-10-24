---
name: develop-suitecontainer
description: Develop, modify, debug, or review SuiteContainer itself, including its Preact frontend, Hono API, TypeScript services, launchers, and container setup. Includes repository conventions and Oracle TypeScript guidance. For operating SuiteContainer to work on a SuiteApp, use suitecontainer.
---

# Develop SuiteContainer

Apply this guidance to SuiteContainer application changes.
Respect discussion-only requests and preserve unrelated work.
Inspect the current branch and working tree before editing.
Do not turn a task in a hosted SuiteApp repository into a SuiteContainer source change.

## Repository map

| Location | Responsibility |
| --- | --- |
| `app/engine/site/src/features/` | Credentials, SuiteApps, settings, and deployment UI modules. |
| `app/engine/site/src/tools/` | SQL, SFTP, and Playwright UI modules. |
| `app/engine/site/src/layout/` | Shared page composition and appearance controls. |
| `app/engine/site/src/common/` | Shared runtime, state, API, log, and module contracts. |
| `app/engine/site/src/modules.ts` | Frontend module composition and shared style aggregation. |
| `app/engine/server/src/api/` | Request contracts, schema parsing, and HTTP handlers. |
| `app/engine/server/src/services/` | Domain behavior, shared state, operation coordination, and errors. |
| `app/engine/server/src/main.ts` | Server lifecycle, authentication, middleware, and route registration. |
| `app/engine/server/src/step-*.ts` | Existing configuration, authentication, cloning, and deployment steps. |
| `app/setup/bootstrap/` and `start/` | Host bootstrap and platform entrypoints. |
| `app/setup/Containerfile` | Container toolchain and development/production images. |
| `app/setup/node/` and `app/setup/playwright/` | npm/runtime helpers and managed Playwright runner. |
| `app/engine/site/test/` and `app/engine/server/test/` | Existing targeted frontend and backend tests. |
| `app/docs/` | User-facing documentation. |
| `home/` | Private configuration, credentials, workspaces, and runtime state. |

Keep frontend and backend in the existing `app/engine` package.
Use the current files as the source of truth if the layout has changed.
Do not treat pending work in `.ai-docs/` as implemented behavior.

## TypeScript and code style

For TypeScript or TSX changes, load the Oracle reference through the resolution workflow below.
[references/oracle-typescript.md](references/oracle-typescript.md) records the NEMS-sourced standard and explicit SuiteContainer differences.
Use the repository's `.prettierrc`, TypeScript configuration, and installed lint tooling as the formatting and compilation authorities.
Do not replace them with a different standards toolchain.

- Use ESM and explicit `.ts`/`.tsx` relative import extensions, consistent with adjacent source.
- Use `import type` for imports used only as types.
- Preserve strict TypeScript and describe external data with types and runtime validation.
- Prefer arrow functions assigned to `const` for components, reusable helpers, and handlers.
- Use anonymous arrow functions for inline callbacks when readable.
- Keep meaningful reusable function names through their variables.
- Use ordinary functions or methods when JavaScript/TypeScript semantics require them.
- Prefer direct typed functions to wrappers that add no behavior.
- Apply conventions to new or modified code without restyling unrelated functions.

The current formatter uses four spaces, double quotes, and trailing commas.
Keep the existing kebab-case module paths and `.spec.ts` test naming.

For TypeScript or TSX changes, resolve `oracle-typescript.md` through `workspace-reference-cache` when available.
Pass the current workspace root, consumer name `develop-suitecontainer`, this skill's absolute root, and output `oracle-typescript.md` from `references/sources.yml`.
Read the returned authoritative reference and report any warning.
If that skill is unavailable, use the bundled dated snapshot and identify its age when currency matters.
Do not require a network refresh for unrelated work.

## Design boundaries

Keep HTTP parsing and advertised contracts in `api/`.
Put business behavior in the existing services.
Register new capability contracts through the existing system capability list.
Preserve compatibility when changing a browser/agent contract.

Use the existing `SiteModule`, feature/tool registries, `SiteRuntime`, and shared UI components.
Keep shared layout and control behavior common across themes.
Use existing theme tokens for appearance.
Keep implementation details out of user-facing copy unless they help the user decide what to do.

Preserve these operational invariants when relevant:

- Host-loopback publication and identity verification before credentials are sent.
- Distinct browser session/origin authentication and agent bearer authentication.
- Credential isolation and redaction in responses, errors, and streamed output.
- Explicit target selection and validation without silently rewriting saved settings.
- Operation reservations, idempotency, bounded history/logs, and truthful cancellation support.
- Ownership and cleanup of workers, SSH tunnels, temporary files, and managed services.
- Local SuiteApp checkouts retain their branch and working files.
- A local deployment failure does not prove a remote deployment failed.

Use the existing `ServiceError` and structured error/redaction mechanisms at service boundaries.
Keep credentials out of command arguments and logs.
Do not infer that an endpoint exists merely because a plan proposes it.
Use `suitecontainer` when the task needs operating procedures.

## Checks for the change

Run only existing checks relevant to the specific change.
Do not run the full suite or add tests or verification scripts unless requested.
Run each selected check once per relevant change.
After failure, make one targeted fix and rerun only that check.
After two failed attempts, stop and report the likely cause.
Documentation-only changes do not need application tests or builds.

From `app/engine`, existing focused commands include:

| Change | Existing check example |
| --- | --- |
| A formatted source file | `npx --no-install prettier --config .prettierrc --check server/src/api/deployment.ts` |
| A linted source file | `npx --no-install oxlint server/src/api/deployment.ts` |
| Backend deployment behavior | `node --experimental-strip-types --test server/test/api/deployment.spec.ts` |
| Frontend SQL behavior | `npx --no-install tsx --tsconfig site/tsconfig.json --test site/test/tools/sql.spec.ts` |
| Backend type contracts | `npx --no-install tsc -p tsconfig.json --noEmit` |
| Frontend type contracts | `npx --no-install tsc -p site/tsconfig.json --noEmit` |

Select the matching file or project instead of running every row.
Use the existing installed runtime and dependencies.
Do not build an image or deploy to a real target solely to verify a documentation or local code change.

## Documentation and completion

Keep agent plans, handoffs, and internal repository notes under root `.ai-docs/`.
Skill manifests and bundled skill resources belong in their discoverable skill package.
Keep user-facing documentation in its normal location.
Do not edit `README.md` unless requested.
Report what changed, the relevant check results, and any remaining uncertainty.
Stop when the requested work is complete.
