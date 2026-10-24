# Oracle TypeScript guidance for SuiteContainer

## Source snapshot

- Source: [TypeScript Coding Standards](https://confluence.nsgbu.netsuitecorp.com/pages/viewpage.action?pageId=896762988).
- Publisher: Oracle NetSuite Product Hub, space `NEXT`.
- Confluence page ID: `896762988`.
- Page version: 92.
- Source updated: 2026-05-11 11:21:21, as reported by NEMS.
- Retrieved through NEMS Confluence search and page retrieval on 2026-10-24.
- Scope: A focused summary of that page and its applicability to SuiteContainer.
  This is not a verbatim copy or a claim that all linked documents were inspected.

The Oracle page bases its standards on the Google TypeScript Style Guide.
Its linked language-feature and naming sections supply background.
This snapshot summarizes the Oracle page itself.
Read a linked rule before relying on details not reproduced here.

## Applicable guidance

### Types, APIs, and modules

- Prefer string literal unions in APIs and for ordinary sets of supported values.
- Do not introduce `const enum` into SuiteContainer.
  Oracle's documented exception concerns existing CBS record-type and field-ID enums.
- Prefer `interface` for object contracts that should support extension or implementation.
  Retain `type` for unions, compositions, and existing appropriate local patterns.
- Place type definitions near the top of their module.
- Export only symbols needed by other modules.
- Avoid new globals.
  Oracle places genuinely global/external declarations in `globals.d.ts`.
  Do not create that file unless the change needs such declarations.
- Avoid `any`; use a specific type or narrow unknown input.
- Prefer array suffix syntax, such as `Target[]`, over `Array<Target>`.

### Utilities and asynchronous work

- Group ordinary utility functions in modules.
  Do not introduce a class merely to collect utility functions.
- Encapsulate singleton state in a module when a singleton is needed.
- These utility/singleton rules do not require replacing SuiteContainer's stateful lifecycle-owned services.
- Prefer `async`/`await` when it improves clarity.
- Use `Promise.all` for independent I/O when shared state, ordering, and failure handling permit it.
  Sequence operations with dependencies.

### Formatting and TSX

- Use double quotes.
- Parenthesize arrow-function parameters, including a single parameter.
- Use trailing commas in TypeScript/TSX objects where the formatter allows them.
  JSON does not allow trailing commas.
- Self-close tags without children and put a space before `/>`.
- Do not pad JSX expression braces.
- Parenthesize multiline JSX expressions.
- For multiline props, put the closing tag delimiter on its own line.
- Let the repository formatter apply these mechanical rules.

### Comments and annotations

- Explain non-obvious intent with meaningful comments that remain accurate.
- Document public functions and classes with useful JSDoc-style block comments.
  Do not add repetitive comments to unrelated existing code.
- The Oracle page requires a block copyright notice at the beginning of source files.
  For new Oracle-owned source files, use the approved notice and actual applicable year.
  Do not invent ownership or change copyright years in unrelated files.
  The linked legal-notice page was not inspected for this snapshot.

## Explicit SuiteContainer differences

The user selected this guide as a reference for SuiteContainer.
Existing project configuration and the user's explicit instructions take precedence over generic source conventions.
These differences are deliberate applicability decisions, not claims that Oracle's source says something different.

| Oracle source | SuiteContainer application |
| --- | --- |
| Tabs for indentation. | Preserve `app/engine/.prettierrc`: four spaces and no tabs. |
| Lines no longer than 120 characters. | Preserve the repository's formatter configuration; do not impose a separate width or reformat unrelated code. |
| Content-dependent PascalCase/camelCase/JET file naming. | Preserve existing kebab-case modules and Preact conventions; do not rename files to match JET examples. |
| Tests named `<component>.test.ts`. | Preserve existing `.spec.ts` files and their current runners. |
| Uppercase Markdown filenames. | Preserve established lowercase reference/document paths and required `SKILL.md` naming. |
| Utility examples use ordinary functions. | Prefer `const` arrow functions under SuiteContainer's working conventions; retain methods or declarations when semantics require them. |

The Oracle page does not require adopting JET, replacing Oxlint with ESLint, introducing a translation framework, creating globals, or rewriting every service as a singleton.
Do not import additional rules from the older code-review seed as though they were stated in this page.
Follow the user's targeted-check policy.
This snapshot does not authorize new tests or broad application checks.

## Refresh

The source is declared in `sources.yml` beside this file.
For standards-sensitive work, resolve this output through `workspace-reference-cache` when available.
Read the returned authoritative reference rather than combining source bodies in memory.
Refresh uses NEMS Confluence page retrieval for page `896762988`.
Keep this bundled seed intact during cache refresh.
Record changed source guidance and conflicts in the generated overlay.
If the source cannot be refreshed, report the cached/snapshot date when current standards matter.
