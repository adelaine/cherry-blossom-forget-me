# SuiteContainer skills implementation plan

Status: Proposed. This document authorizes no skill installation, root instruction changes, application edits, or migration of existing skills.

## Goal

Create one repository-scoped development skill and a short root AGENTS.md. Keep standing working rules separate from detailed guidance loaded for the current task.

The temporary guide is [AGENTS.md](../.ai-docs/AGENTS.md). It remains under `.ai-docs/` until this plan is explicitly assigned for implementation.

## Target structure

```text
C:\webdev\ns-suitecontainer\
|-- AGENTS.md
|-- .agents/
|   `-- skills/
|       `-- suitecontainer-development/
|           |-- SKILL.md
|           `-- references/
|               |-- typescript-style.md
|               |-- frontend.md
|               `-- backend.md
|-- .ai-docs/
|   |-- backend-implementation.md
|   `-- broader-refactor-plan.md
`-- .agent-docs/
    `-- skills-implementation-plan.md
```

Keep existing `.codex/skills` content intact. Do not move, rename, or duplicate those skills as part of this work. Do not add scripts, templates, assets, or UI metadata without a concrete need.

## Content ownership

| File | Purpose |
| --- | --- |
| Root AGENTS.md | Standing scope, testing, documentation, communication, and delegation rules; direct relevant code work to the development skill. |
| SKILL.md | Required name/description, when the skill applies, essential project constraints, and instructions for selecting references. |
| typescript-style.md | Arrow-function preference, semantic exceptions, and other explicitly agreed TypeScript conventions. |
| frontend.md | Feature/tool boundaries, state ownership, styling, and relevant frontend integration constraints. |
| backend.md | API/service boundaries, authentication, operation ownership, and process lifecycle constraints. |
| .agent-docs plans | Versionable implementation assignments, pending work, and handoffs. |

Keep each detailed rule in one place. The skill reads the TypeScript reference for TypeScript changes and only the frontend/backend reference relevant to the task. Do not load every reference for every request.

## Implementation

1. Inspect the current root instructions, existing skills, and Git ignore rules. Preserve existing content and identify conflicting instructions before replacing anything. The new root guide and repository skill must remain versionable; do not silently change Git rules.
2. Create `suitecontainer-development` under root `.agents/skills/`, using the skill-creator workflow. Define its description around authoring, modifying, or reviewing SuiteContainer code. Ordinary conversation and documentation-only planning should not require the skill.
3. Extract the coding conventions from the temporary guide into `references/typescript-style.md`. Keep the arrow-function preference precise and preserve required ordinary-function exceptions.
4. Write concise frontend and backend references from the agreed architecture and current source. Reflect the implemented Preact frontend and current backend architecture. Do not turn completed migration steps into permanent rules.
5. Move the standing guidance into root AGENTS.md and replace extracted detail with a concise instruction to read the appropriate skill/reference. Preserve any existing root guidance. Remove the temporary `.ai-docs/AGENTS.md` after its content has been transferred.
6. Validate the skill with the skill-creator's existing `quick_validate.py` once. Review routing and references for clear scope, broken links, duplication, and conflicting rules. Do not add validation scripts or run application tests.
7. Report created/updated files and validation results. Remove or reduce this plan once implementation is complete.

Keep normal automatic skill selection enabled. Do not introduce dependencies on unavailable tools or skills. Retain authentication and external-action authorization boundaries.

## Completion

- Root AGENTS.md contains concise standing instructions.
- The repository development skill contains valid metadata and references that are selected by task.
- The arrow-function convention has one authoritative definition.
- Existing skills and unrelated work are preserved.
- Temporary implementation plans remain separate from permanent guidance.
- No application code is changed by this setup.

## References

- [Official AGENTS.md guidance](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Official skills guidance](https://learn.chatgpt.com/docs/build-skills)
