---
name: planner
description: 'Use when: planning a new feature, a complex or ambiguous bug fix, a nontrivial behavior or configuration change, a refactor spanning layers, or a backend/frontend contract change in this dependency-parser project. Also use when the user explicitly asks for a plan. Identify the main steps, propose a proportionate plan, and wait for user approval before implementation. Skip trivial, unambiguous local edits and read-only questions unless planning is requested.'
argument-hint: 'Describe the feature, fix, or change to plan before implementation'
user-invocable: true
disable-model-invocation: false
---

# Planner

## Outcome

Agree on the main implementation steps with the user before changing files for work that needs planning. Keep the plan proportional to the request, not to the size of the repository.

## Applicability

Evaluate the request at the start of the task. Load this skill when any of these conditions applies:

- The user asks for a plan or a new feature.
- A fix is ambiguous: the expected behavior, root cause, or acceptable solution needs clarification.
- A change is nontrivial: it affects multiple layers, public contracts, persisted data, external integrations, or operational behavior.
- The work introduces a parser/provider/storage adapter, changes dependency resolution or version comparison, or adds a UI workflow.

Skip planning for read-only explanations, reviews, and investigations unless the user requests a plan. Also skip a clearly understood, localized fix or cosmetic/documentation correction that does not alter a contract or workflow. File count alone does not determine complexity.

| Example Request | Decision |
| --- | --- |
| Add support for another package ecosystem | Plan and obtain approval |
| Fix dependency resolution when the cause is unclear | Inspect locally, then plan and obtain approval |
| Change cache invalidation, persistence, or scheduled scan behavior | Plan and obtain approval |
| Add a version-comparison interaction spanning API and Angular UI | Plan and obtain approval |
| Correct a README typo or a known local label error | Proceed without a planning gate |
| Explain an existing route or review a diff without making changes | No implementation plan required |

## Procedure

1. Establish the requested outcome and scope.
   - Identify the closest relevant implementation, test, or configuration file with read-only inspection.
   - Preserve existing worktree changes. Do not turn a targeted request into a full architecture rebuild.
   - Ask focused questions if an ambiguity would materially change the solution; otherwise state reasonable assumptions in the plan.

2. Propose the main steps in chat.
   - Use a short numbered list, usually three to six steps. A smaller qualifying change can use fewer steps.
   - Name the affected layers or workflows, the intended behavior, and meaningful risks or tradeoffs.
   - Include focused validation and a `verify-docs-after-change` check before completion.
   - Respect the active agent's build/test restrictions. Proposing a check is not permission to run it.
   - Backend work should preserve pure domain models, dependency inversion, existing abstractions, and JSON-first persistence with MongoDB optional.
   - Frontend work should preserve the Angular structure and keep transport contracts aligned with the backend.

3. Obtain approval before implementation.
   - After presenting the plan, explicitly ask for confirmation using the available structured question tool (`vscode_askQuestions` in VS Code). Invoke it with a question such as "Do you approve this plan?", single-select options `Approve` and `Request changes`, `multiSelect: false`, and `allowFreeformInput: true`. The client renders the selectable options as buttons or radio choices; do not substitute a chat-only request when the tool is available.
   - Tell the user they can click/select `Approve` or request plan changes directly in chat. Accept a clear approval in chat as well. If they request changes through an option, freeform input, or chat, revise and present the plan, then ask for confirmation again before implementing it.
   - If no structured question tool is available, explicitly ask for approval or revisions in chat and wait; do not imply that a clickable control is available.
   - Stop and wait for a clear answer. Presenting a plan is not approval; the original implementation request alone is not approval of a plan the user has not seen.
   - A skipped or dismissed prompt, silence, or a revision request is not approval. Only proceed after explicit approval of the current plan or an explicit waiver.
   - Until approval, use only read-only inspection. Do not create or edit files, install dependencies, start servers, or run commands that change repository state.
   - If the user asked only for a plan, deliver the plan without implementing it.
   - If the user already explicitly approved a plan covering this scope, do not ask again. If the user explicitly waives planning or approval, follow that direction and briefly state the approach.

4. Implement the approved scope.
   - Follow the active agent's workflow and keep changes small and dependency-safe.
   - For a material scope change or newly discovered design decision, explain the change and obtain approval for the revised steps before expanding the work.
   - Finish with the documentation decision, authorized validation results, and any deferred work.

## Completion Check

- The planning decision matches the request's complexity and intent.
- The user saw the main steps before implementation and approved them, or explicitly waived the gate.
- Approval was explicitly requested through selectable options when a structured question tool was available, and chat revision requests were honored.
- The implementation stayed within the approved scope.
- Documentation and validation expectations were addressed without overriding agent restrictions.
