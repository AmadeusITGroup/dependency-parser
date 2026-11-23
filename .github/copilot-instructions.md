# Project Instructions

## Skill Routing

- At the start of every request, evaluate whether the skills below apply. Read each matching `SKILL.md` before following its workflow; do not wait for the user to name the skill or invoke a slash command.
- Both skills support automatic selection and explicit invocation. Explicit requests to use a skill should load it even when its usual automatic trigger does not match.

### Planning Before Implementation

- Load [skills/planner/SKILL.md](skills/planner/SKILL.md) for new features, complex or ambiguous fixes, nontrivial behavior/configuration changes, cross-layer contracts, or explicit planning requests.
- Use read-only inspection to ground a proportionate plan. Propose the main steps and wait for user approval before editing files or taking other implementation actions.
- An implementation request alone is not approval of a plan the user has not seen. An already approved plan covering the same scope or an explicit user waiver does not need another approval gate.
- Skip the planning gate for trivial, unambiguous local edits and read-only questions/reviews unless the user requests planning. If qualifying complexity emerges during a small task, pause and obtain plan approval before continuing.
- Do not implement when the user asked only for a plan. Seek approval again if the proposed implementation materially expands beyond the approved scope.

### Documentation Before Completion

- After implementation and before the final response, load [skills/verify-docs-after-change/SKILL.md](skills/verify-docs-after-change/SKILL.md). Also load it for an explicit documentation audit.
- Evaluate documentation impact even for internal-only fixes/refactors; update docs only when setup, observable behavior, architecture, contracts, workflows, or operations change.
- Use the root `README.md` for the overview and shared setup, `backend/README.md` for backend details, and `frontend/README.md` for frontend details. Maintain relevant existing `docs/` files, including `docs/SYSTEM.md`, when their described behavior or architecture changes. Link to owning documents instead of duplicating details; search `docs/` only if it exists and do not create a documentation tree just to complete this check.
- State which documentation was updated, or why no documentation change was needed, in the final response.

### Agent Boundaries

- Apply this routing in the default agent and in the backend/frontend custom agents. Planning does not authorize broader code scope or replace their architecture/UX constraints.
- Respect the active agent's validation policy. Skill invocation does not authorize application build/test/serve commands; a documentation or skill-metadata check is separate from application validation.

## Run the Project

- Run commands from the repository root unless a step changes directories.
- Start the backend first in a dedicated terminal and leave it running:

  ```powershell
  cd backend
  $env:DATASTORE = "json"
  npm run dev
  ```

- Start the frontend in a second terminal. Build it before starting the development server:

  ```powershell
  cd frontend
  npm run build
  npm run start
  ```

- Treat `npm run dev` and `npm run start` as long-running processes. Do not wait for the backend process to exit before starting the frontend.
- The backend is available at `http://localhost:3000`; the frontend is available at `http://localhost:4200`.
