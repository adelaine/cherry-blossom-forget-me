# SuiteContainer agent instructions

## Scope and tools

- Respect the distinction between discussion, planning, and implementation.
  Creating a plan does not authorize application changes.
- Inspect the active branch and working tree before editing.
  Preserve unrelated work and keep changes within the requested scope.
- If a tool fails, retry with elevated access when supported.
  If that fails, report the blocker and ask.
- Use agent-browser when browser interaction is needed and available.
  Do not search for alternative tools without user approval.
- Correct obvious typos without interrupting work.
  Ask when an unfamiliar term could materially change the request.

## Skills and conventions

- Check installed skills before starting and select the smallest applicable set.
  Read each selected skill before applying it.
- For SuiteContainer code changes and reviews, use [develop-suitecontainer](.agents/skills/develop-suitecontainer/SKILL.md).
  Keep detailed coding conventions, architecture guidance, and standards references in that skill.
- For operating SuiteContainer to work on a SuiteApp, use [suitecontainer](.agents/skills/suitecontainer/SKILL.md).
- Ordinary conversation and documentation-only planning do not require loading development guidance.

## Tests and checks

- Run only existing checks relevant to the specific change.
  Do not run the full test suite unless requested.
- Run each check once per relevant change.
  Do not repeat passing checks without a new relevant change.
- If a check fails, make one targeted fix and rerun only that check.
  After two failed attempts, stop and report what you tried and the likely cause.
- Do not write new tests, add extra validation, or create verification scripts unless requested.
- Do not run application checks for documentation-only changes.
- Do not re-read or re-verify work already completed and reported unless the user requests a new review or a relevant change requires it.
- Never loop on a check.
  If you notice repeated checking without progress, stop and summarize the current state.

## Documentation

- Do not edit `README.md` unless explicitly requested.
- Keep agent-facing plans, handoffs, and internal repository notes under root `.ai-docs/`.
- Keep user-facing documentation and other project files in their normal locations.
  Keep skill manifests and bundled resources in their discoverable skill package.
- Keep files intended for version control in non-ignored paths.
- Keep implementation plans separate from reusable development guidance.
  Update or remove completed plan items.

## Delegation

- Delegate when the user or applicable instructions request it and a bounded independent task benefits from it.
  Keep simple or tightly dependent work with the lead agent.
- Give each subagent a clear objective, scope, completion criteria, retry limits, and permission to edit or read only.
- Assign distinct edit ownership or sequence dependent changes.
  Tell editing agents to preserve other contributors' work and adapt to concurrent changes.
- Inherit model and reasoning settings unless an override is justified.
  Delegation does not grant additional permissions.
- Continue useful independent work while agents run.
  Redirect or stop agents that repeat work, exceed scope, or make no meaningful progress.
- Request concise findings, evidence, verification results, and unresolved issues.
- Review required results, resolve disagreements, and verify changes before integration.
  Wait for required results before claiming completion.
- Remain responsible for the final outcome and report incomplete work clearly.

## Communication

- Lead with the outcome and use one sentence per idea.
- Write natural, complete sentences with concrete words and direct verbs.
  Define unfamiliar acronyms.
- Keep updates and summaries concise.
  Preserve technical accuracy, exact identifiers, numbers, units, conditions, and meaningful uncertainty.
- For technical changes, report the relevant verification and remaining limitations.
  Show only the relevant error excerpt unless full logs are requested.
- When the requested work is complete, give a short summary and stop.
  Do not offer additional checks or audits.
