---
name: verify-docs-after-change
description: 'Use when: finishing implementation or auditing documentation after changes to this dependency-parser project. Check documentation for TypeScript/Express API routes and DTOs, npm/Maven parsing, dependency resolution and version diffs, JSON/MongoDB persistence and caching, background scans and logging, environment/setup settings, Angular Dependency Tree or Tree Builder workflows, architecture, and Copilot customizations. Update the root, backend, and frontend READMEs and relevant existing docs, including docs/HLD.md, when setup, observable behavior, or design changes; internal-only changes still require a no-update decision.'
argument-hint: 'Describe the change or diff whose documentation should be checked'
user-invocable: true
disable-model-invocation: false
---

# Verify Docs After Change

## Outcome

Keep this project's documentation consistent with implementation changes that affect setup, APIs, dependency analysis, persisted data, user workflows, architecture, or operations. A documentation check does not always require a documentation edit.

## When to Use

- After implementation changes and before the final response, including fixes and refactors.
- After adding or changing routes, DTOs, parser behavior, version lookup/comparison, repository providers, or project definitions.
- After changing JSON/MongoDB persistence, cache invalidation, background scans, logging, environment variables, or startup/shutdown behavior.
- After changing Angular routes, UI fields, version selection/comparison, tree editing, remembered selections, or import/export workflows.
- After changing component boundaries, service interactions, data models, deployment assumptions, or other design described in existing `docs/` files.
- After changing Copilot skills or agent workflows, or when the user explicitly asks for a documentation audit.

## Documentation Map

| Changed Surface | Existing Documentation to Check |
| --- | --- |
| Shared prerequisites, installation, running both applications | Root `README.md`: Prerequisites, Running Locally |
| Backend npm scripts, ports, environment variables | `backend/README.md`: Development Server, Building, Running Tests, Available Scripts, Configuration And Persistence |
| HTTP routes, query aliases, request/response fields | `backend/README.md`: API Overview; frontend workflow descriptions when visible to users; relevant API descriptions in `docs/` |
| npm/Maven parsing, transitive resolution, version lookup/diffs, Git/provider support | `backend/README.md`: Current Capabilities, API Overview; root `README.md`: Remaining Work; relevant `docs/` sections |
| Project definitions, JSON/MongoDB persistence, cached trees | `backend/README.md`: Configuration And Persistence, Tag History And Snapshots; relevant data models and storage descriptions in `docs/` |
| Scan scheduling, failure handling, concurrency, shutdown, log levels | `backend/README.md`: Background Dependency Scans, Logging, Configuration And Persistence; relevant lifecycle and operations descriptions in `docs/` |
| Angular commands, Dependency Tree, Tree Builder, routing, drafts, selection, comparison, import/export | `frontend/README.md`: Current screens, Development server, Building, Running unit tests, Available scripts; relevant frontend descriptions in `docs/` |
| Architecture, component boundaries, service interactions, data models, deployment assumptions | Relevant existing `docs/` files, including `docs/HLD.md`; README overviews and layouts only when affected |
| Copilot skill discovery, triggers, approval workflow | Root `README.md` contributor guidance and `.github/copilot-instructions.md`; affected skills/agents |

The root README owns the project overview and shared setup; `backend/README.md` owns backend commands, API contracts, configuration, and operations; `frontend/README.md` owns frontend commands and user workflows. Link to the owning document instead of duplicating component details across READMEs.

Maintain relevant existing files in `docs/`, including the as-built high-level design in `docs/HLD.md`, when the described behavior or architecture changes. Check that the directory and files exist before searching them; do not create a documentation tree solely to satisfy this skill. Unrelated docs do not need edits. AI-DLC intent records are not a substitute for application documentation.

## Procedure

1. Identify the change being verified.
   - Use the current task and a targeted diff to identify affected behavior, routes, DTO/model fields, configuration, or workflows.
   - Distinguish user/developer/operator-visible changes from private implementation details.
   - Preserve unrelated user changes, including edits already present in a README.

2. Inspect the relevant documentation and controlling code.
   - Read the relevant sections in the owning root, backend, or frontend README, plus existing `docs/` files that describe the affected behavior or design.
   - Search existing documentation for affected route names, model fields, config keys, parser/provider names, and status values.
   - Verify claims against the owning code: HTTP routes/controllers and DTOs, application services/use cases, parsers/storage, scan/config/logger code, or Angular routes/services/components.
   - Derive current defaults and supported behavior from code; do not claim canonical architecture targets or planned features are already implemented.

3. Decide whether documentation needs an update.
   - Update setup, configuration, API contracts, persistence/cache semantics, scheduling, user workflows, architecture, and operator expectations when they change.
   - Keep backend Current Capabilities, frontend Current screens, and root Remaining Work consistent with the change being delivered.
   - An internal refactor may still change the HLD. Record a no-update decision only when the existing documentation, including relevant design descriptions, remains accurate.

4. Patch the smallest relevant documentation.
   - Keep the root README focused on the overview, shared setup, remaining work, layout, and contributor guidance. Keep component-specific details in their owning README and maintain cross-links instead of duplicating them.
   - Keep backend API/configuration/operations and frontend screen/workflow descriptions aligned with the implementation.
   - Update affected sections of relevant existing `docs/` files, including `docs/HLD.md`, for architecture, interactions, contracts, data models, or operational changes. Preserve the distinction between as-built behavior and planned design.
   - Update `backend/.env.example` when documented backend settings change, but never include real credentials or connection secrets.
   - Prefer existing documentation locations. Do not create a new documentation tree, rewrite unrelated sections, or edit generated AI-DLC records for an ordinary application change.

5. Validate the documentation changes.
   - Run a scoped whitespace check for the files changed, for example `git diff --check -- README.md backend/README.md frontend/README.md .github/` from the repository root. Include `docs/` only when relevant and present. Check newly created/untracked files separately because `git diff --check` does not include them.
   - If a Markdown lint or documentation build command exists, use the narrowest relevant check subject to the active agent's validation restrictions.
   - Review changed text for stale names, contradictory defaults, broken local links, and implemented/remaining-work inconsistencies.
   - Do not start application servers or run application builds/tests solely for this documentation check. Report checks that were unavailable or not authorized.

## Completion Check

- Setup and configuration documentation still matches the changed code.
- New or changed public routes, fields, supported ecosystems, persistence behavior, and UI workflows are documented where relevant.
- Relevant existing design documentation in `docs/`, including the HLD, matches affected architecture, interactions, and data models.
- Component details have one owning README, with working links from the root rather than duplicated instructions.
- Existing limitations and remaining-work entries do not contradict the delivered change.
- Documentation validation ran, or the final response explains what was not checked.
- The final response states which documentation was updated, or explicitly says no documentation changes were needed and why.
