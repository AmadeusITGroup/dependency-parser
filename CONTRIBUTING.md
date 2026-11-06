# Contributing

Thank you for contributing to Dependency Parser. This guide covers contribution rules, shared setup, development, verification, and CI. See the [repository overview](README.md) for the project's purpose, the [usage how-to](HOWTO.md) for a walkthrough, and the [backend README](backend/README.md) and [frontend README](frontend/README.md) for component-specific instructions.

For project decision-making, commit access, and release policy, see [Governance](GOVERNANCE.md). For the current maintainer list, see [Maintainers](MAINTAINERS.md).

## GitHub Contribution Rules

Security reports are an exception to the public issue-first workflow below. Do not open a public issue or pull request for a vulnerability; follow the [security policy](SECURITY.md) to report it privately.

1. **Fork the project** into your GitHub account.
2. Check existing issues and pull requests to avoid duplicate work.
3. **Open an issue in the original repository** before implementing a change. Copy this template into the issue description and select one type:

   ```markdown
   ### Type
   Feature / Bug / Documentation

   ### Description
   Clearly describe the issue or proposed feature and why it matters.
   For a bug, include reproduction steps, expected behavior, actual behavior,
   and relevant versions or error messages.

   ### Do you want to implement the feature or fix yourself?
   Yes / No
   ```

4. If you answer **Yes**, create a branch in your fork and implement the change there. Keep the change focused, add or update relevant tests, and update affected documentation.
5. **Open a pull request from your fork to the original repository's default/mainline branch, `main`**. Link the issue, describe the change, and include verification results. Do not target your fork as the destination.
6. Address review feedback. A maintainer can merge after at least one maintainer approval and successful required CI checks, as defined in [governance](GOVERNANCE.md#commit-access). Never include tokens, credentials, private environment files, or local application data in issues, logs, commits, or pull requests.

Before submitting code, follow the [verification instructions](#verification-and-ci), including the frontend Chromium setup, and run `npm run verify`. Documentation-only changes do not require application builds or tests.

## Build And Run Locally

### Prerequisites

- **Node.js:** 24.15.0+ on the 24.x line is recommended. The supported alternatives are 22.22.3+ on the 22.x line, or 26+.
- **npm:** 10 or later.
- **Git:** 2.29 or later for repository inspection and adaptive commit comparisons; optional GitHub token authentication requires 2.31+. Git 2.45+ is recommended for selective tag discovery. For Windows Git regression tests, see the [backend test prerequisites](backend/README.md#running-tests).
- A browser for the frontend.

The supported Node.js and npm versions are declared in the root [package.json](package.json).

### Install And Build

Clone your fork and run these commands from the repository root:

```shell
npm ci
npm --prefix backend ci
npm --prefix frontend ci
npm run build
```

There are three npm packages: the root development launcher, the backend, and the frontend. Install each package's dependencies. Each package has its own committed `package-lock.json`; use `npm ci` rather than `npm install` for a reproducible installation.

### Maintaining Dependencies

When intentionally changing dependencies, update the owning manifest and lockfile together, validate the applications, and audit all three dependency graphs:

```shell
npm audit
npm --prefix backend audit
npm --prefix frontend audit
```

An audit checks known advisories, not the absence of every possible vulnerability. Keep Angular packages aligned using the project-local CLI's migrations (`npm --prefix frontend run ng -- update`), and keep the frontend TypeScript version within Angular's supported range.

Do not apply `npm audit fix --force` blindly: npm can propose incompatible lint-tool downgrades. The root manifest overrides vulnerable minimatch 10 consumers with minimatch 11; the backend scopes patched glob 14 and minimatch 11 to `test-exclude@8`. The affected callers use APIs retained by these versions. Review these overrides when their parent packages adopt patched dependencies, and rerun lint, coverage, and all three audits before removing them.

The backend and frontend manifests permit only the reviewed `esbuild@0.28.2` install script through version-pinned `allowScripts` entries. Re-review the installer and its binary integrity checks when changing that version; do not blanket-approve dependency scripts. The frontend explicitly denies the optional source-build hooks in `@parcel/watcher`, `lmdb`, and `msgpackr-extract`, using their prebuilt platform packages instead. Keep optional dependencies enabled.

With npm versions supporting install-script approvals, inspect pending scripts without changing the policy:

```shell
npm --prefix backend install-scripts ls
npm --prefix frontend install-scripts ls
```

These policy fields are enforced by current npm 11+ releases. npm 10 predates them and retains its legacy script behavior; use a supporting npm release for the same install-script restrictions as CI.

Committed lockfiles use public npm tarball URLs so GitHub-hosted CI does not need access to an internal registry. Keep these URLs portable when updating dependencies through a local registry mirror.

### Start Both Applications

First complete the centralized [environment setup](backend/README.md#environment-setup). It explains creating `backend/.env`, selecting JSON or MongoDB persistence, optional GitHub credentials, and shell overrides. Then run from the repository root:

```shell
npm start
```

The root `npm start` script starts both applications in **development mode**, using each package's npm scripts:

| Application | npm scripts | Default address | Details |
| --- | --- | --- | --- |
| Backend | `npm run dev` from `backend/`, with automatic restart | `http://localhost:3000`, API under `/api` | [Backend README](backend/README.md) |
| Frontend | `npm run build`, then `npm start` from `frontend/` | `http://localhost:4200` | [Frontend README](frontend/README.md) |

Open `http://localhost:4200` once the frontend is ready. The Angular development server proxies `/api` requests to the backend. Output is labelled `backend` or `frontend`, and each command runs from its application's working directory, preserving backend configuration and data paths. If either command exits, the other keeps running. Leave both running; press Ctrl+C to stop the session.

Alternatively, run the applications in separate terminals:

1. Start the backend first using its [development server instructions](backend/README.md#development-server). Use a persistent datastore to save project definitions and dependency history.
2. In a second terminal, [build the frontend](frontend/README.md#building), then start its [development server](frontend/README.md#development-server). Leave the backend running.
3. Open the frontend development server URL in a browser.

Datastore selection remains explicit; see [backend configuration](backend/README.md#configuration-and-persistence) for JSON, MongoDB, and nonpersistent options. Configure optional [GitHub token authentication](backend/README.md#github-token-authentication) before startup when using private GitHub repositories. For compiled backend startup, API routes, and component test commands, use the component READMEs linked above.

## Verification And CI

Install all three packages as described above and provision Chromium using the [frontend test setup](frontend/README.md#running-unit-tests). Then run the complete CI checks from the repository root:

```shell
npm run verify
```

| Command | Description |
| --- | --- |
| `npm run lint` | Check CI scripts and workflow tests, backend TypeScript and Node tests, frontend TypeScript, Angular templates and Vitest configuration, and the shared ESLint configuration. Warnings fail the check. |
| `npm run lint:fix` | Apply automatically fixable lint corrections; remaining errors still need manual fixes. |
| `npm run build` | Compile the backend and create the frontend production build. |
| `npm test` | Run backend tests and one non-watching frontend test pass; build the backend first. |
| `npm run test:ci-workflow` | Run focused Node tests for CI build numbering, workflow wiring, permissions, immutable Git tags, container startup probes, and the local launcher; no application build or browser is needed. |
| `npm run test:coverage` | Build the backend, run both test suites without watch mode, and enforce coverage minimums. |
| `npm run verify` | Run lint, CI workflow tests, both production builds, and both application test suites with coverage checks. |

Lint tooling is shared through the root package and [ESLint configuration](eslint.config.cjs). Angular checks focus on correctness without requiring change-detection, dependency-injection, or template-syntax migrations. Component-specific commands are documented in the [backend](backend/README.md#linting-and-verification) and [frontend](frontend/README.md#linting-and-verification) READMEs.

The focused CI workflow tests require `curl`, Git, and Bash. On Windows they locate Bash through the Git for Windows installation. Launcher regressions use mocked Docker, Podman, and act commands, so they do not require a running container engine.

The [GitHub Actions CI workflow](.github/workflows/ci.yml) runs on branch pushes, pull requests, and manual dispatches. It uses Node.js 24 on Ubuntu, caches npm downloads using all three lockfiles, runs `npm ci` for each package, and provisions headless Chromium with its Linux dependencies before testing. It does not require the backend environment file, repository credentials, or a MongoDB service. Opt-in real-MongoDB and live-repository tests remain separate; see the [backend test instructions](backend/README.md#running-tests).

### Local CI With act

On Windows (Git Bash) or Linux, install [act](https://nektosact.com/installation/) and Docker or Podman, then run the [local CI launcher](run-local-ci.sh) from the repository root using Bash. Other operating systems are not currently supported by the launcher.

```bash
bash ./run-local-ci.sh
```

Use the Up/Down arrow keys to select Docker or Podman, then press Enter to confirm; Docker is selected initially. When input or output is redirected, or the terminal does not support the menu (`TERM` is unset or `dumb`), the launcher instead accepts typed `docker` or `podman`, with an empty line selecting Docker. The launcher reports an error if `act` or the selected engine is missing or unavailable; it never silently switches engines.

Both the selected engine and `act` must be on `PATH`. On Windows, the launcher also recognizes the standard per-user WinGet installation of `act` (`winget install --id nektos.act --exact`). On Linux, follow the linked `act` installation instructions. The selected engine must be accessible to the user running the launcher.

Docker must already be running with Linux containers. On both platforms, the launcher uses the current Docker context, ignoring an inherited `DOCKER_HOST` so a previous Podman endpoint is not reused, and pulls `docker.io/catthehacker/ubuntu:act-latest`.

Podman setup depends on the platform:

- **Windows:** the launcher starts `podman-machine-default` if it is stopped and uses its Windows named-pipe endpoint.
- **Linux:** the launcher uses native Podman without a virtual machine. It discovers the rootless or rootful Unix socket through `podman info` and verifies that the API service is reachable before running `act`. Start the rootless service with `systemctl --user start podman.socket`, or the rootful service with `sudo systemctl start podman.socket`. Without systemd, run `podman system service --time=0` in another terminal. The launcher does not start Linux services or change their permissions automatically.

Both Podman paths replace any inherited `DOCKER_HOST` and require the previously prepared `localhost/dependency-parser-act-podman:local` runner image. Build it using the same Podman user/context as the launcher, after starting the Windows machine or configuring native Linux Podman:

```bash
podman build --format docker --tag localhost/dependency-parser-act-podman:local - <<'EOF'
FROM docker.io/catthehacker/ubuntu:act-latest
RUN ln -snf ../run /var/run
EOF
```

The relative `/var/run` symlink avoids the Podman archive-extraction incompatibility in the standard runner image. The application does not need to be running.

The launcher runs all three workflow jobs: verification, image build/smoke-test/export, and Git-tag validation. Check out a branch first; detached HEAD is not supported. It simulates a default-branch manual dispatch on the current branch by setting that branch as the event's `ref` and `repository.default_branch`, and passing it to act's `--defaultbranch` option. This keeps the simulated GitHub context consistent so downstream jobs also run on feature branches, without changing GitHub-hosted branch restrictions.

The selected engine's Unix socket is mounted into the runner as `/var/run/docker.sock`; on Windows this is the socket inside the Docker or Podman Linux VM, not the host named pipe. Only run trusted workflow/project code, because socket access allows it to control the selected engine. For Docker, the launcher creates a per-run user-defined bridge network, because act's network aliases are unsupported on Docker's built-in `bridge` network. It removes that network on exit, including after failed runs, and reports cleanup failures. Podman continues using its `podman` network. Local smoke-test containers share the runner's network namespace rather than publishing host port 3000. Smoke-test containers and volumes receive per-run names and are cleaned up by the workflow.

Podman image builds use its Docker-compatible build API (`DOCKER_BUILDKIT=0`), avoiding a privileged nested BuildKit container. Docker retains its normal builder selection.

Local image versions use the same mainline allocator with locally available Git tags and the checked-out commit SHA. No GitHub token or API access is required. The tag job validates the version, revision, and branch, then prints a dry-run notice without reading or changing remote Git tags. Real PR attempt history, remote tag immutability checks, and GitHub publishing are not integration-tested by this local run; the focused CI workflow tests cover their logic using mocked GitHub APIs.

Local act runs intentionally skip both GitHub artifact uploads and print notices; lint, builds, tests, coverage thresholds, image smoke checks, and compressed image export remain enforced. This avoids the missing artifact runtime token and act 0.2.94's incompatibility with `actions/upload-artifact@v7`, even with its artifact server enabled (`unknown field "mime_type"`; [nektos/act#6114](https://github.com/nektos/act/issues/6114)). No artifact server is required. The built image remains in the selected container engine, but coverage reports and the compressed export are not retained after runner cleanup. GitHub-hosted uploads and Git-tag creation are unchanged.

### Coverage Policy

Run the coverage checks from the repository root:

```shell
npm run test:coverage
```

Each application must meet these minimums independently; a higher frontend result cannot compensate for a backend gap, or vice versa.

| Metric | Backend minimum | Frontend minimum |
| --- | --- | --- |
| Statements | 80% | 80% |
| Lines | 80% | 80% |
| Functions | 80% | 80% |
| Branches | 70% | 70% |

Coverage includes untested application files, not just modules loaded by tests. Backend reports use c8 and TypeScript source maps; frontend reports use Angular's Vitest coverage support. The thresholds apply to each application's aggregate, not to every individual file. Ordinary `npm test` remains available without coverage enforcement.

Add focused tests for business rules, validation, boundary conditions, and failures rather than excluding application code or weakening the minimums. New isolated backend tests follow the owning layer under `backend/tests/`; frontend `.spec.ts` files stay beside their implementation. Unit tests should replace external Git, network, and datastore access with test doubles; existing local integration regressions and opt-in live tests retain their current behavior.

Both runners produce HTML, LCOV, and JSON reports in ignored coverage directories; see the [backend](backend/README.md#test-coverage) and [frontend](frontend/README.md#test-coverage) instructions. CI runs both coverage checks even if the backend check fails, then uploads generated reports as a `coverage-<run-id>-<attempt>` artifact retained for 14 days, including on failed coverage checks. Below-threshold results fail verification and block the downstream image job. Reports are kept in GitHub Actions artifacts; no external coverage service is required.

### Versioned Git Tags And Image Artifacts

CI build tags identify tested snapshots, not official releases. Here, **mainline** means the repository's default branch, `main`. CI build tags use the `main.` prefix.

After verification succeeds, default-branch and PR runs build the [Docker image](Dockerfile), check its non-root configuration and require Git 2.45+, and smoke-test the API, frontend routes, and JSON persistence across container recreation. CI then uploads a compressed `docker save` archive, retained for 14 days. There is no registry publishing or deployment.

The smoke test needs no `.env` file or repository credentials: it uses the image's JSON defaults and disables background scans. Startup and recreation use a bounded health probe that retries transient connection errors, including resets, and validates the completed response as exactly `{"status":"ok"}`. An unavailable container or an invalid health response still fails the job.

| Run | Git tag and Docker image |
| --- | --- |
| Push to the default branch, or manual dispatch on that branch | `main.1`, `main.2`, and so on: increment the highest existing `main.<N>` build number. Re-running an already-tagged mainline commit reuses its build tag. |
| Same-repository PR, for example PR 42 with latest mainline tag `main.12` | `main.12-pr42.1`, then `main.12-pr42.2`, and so on. After a successful build and artifact upload, each new immutable PR Git tag identifies the tested merge commit. |
| Fork PR | The same PR image naming and artifact, but no Git tag: fork workflows have a read-only repository token. |
| Other branch push or manual dispatch | Verification only. |

The PR format is `main.<mainline-build-number>-pr<PR-number>.<PR-build-sequence>`. Its base is the latest mainline build tag when the image version is allocated. The PR number prevents different PRs from generating the same tag. The build sequence is scoped to that PR and advances for new workflow runs and rerun attempts, including rebuilds and amended or additional commits. It continues when the mainline base advances. Failed or cancelled attempts can leave gaps; rerunning only the tag job reuses the already-built version.

Numbering uses Actions run/attempt history, identified by stable `CI PR <number>` run names, and never goes below an already-issued PR Git tag's next sequence. Preserve the run names and history for open PRs, especially fork PRs, which have no repository Git tags to retain their counters.

Before the first mainline build tag exists, PR versions use the reserved base `main.0`, for example `main.0-pr42.1`; CI does not create a standalone `main.0` tag. Semantic release tags do not influence either build counter. Every image also has a `sha-<full-tested-commit-SHA>` tag and OCI version/revision labels. The Docker repository name is `dependency-parser`, for example `dependency-parser:main.12-pr42.2`.

Git tags are written only after the image artifact uploads successfully. Mainline runs are serialized to avoid allocating the same next build number. Both mainline and PR build tags are immutable: CI refuses to move an existing tag to another commit. PR runs cancel superseded runs; a closed PR or changed merge revision does not receive a tag from an older run. Tag pushes do not trigger this workflow. The isolated tag-only job has `contents: write` permission and does not check out or execute project code; all build/test jobs have read-only repository contents access. The image job also has `actions: read` to inspect PR attempt history. Repository rules must permit creation of generated `main.*` tags; no forced tag updates are needed.

These are lightweight Git tags, not GitHub releases. npm manifest versions remain unchanged; Git tags and image labels identify the tested application revision. For loading the downloaded archive, see [loading a CI image](#loading-a-ci-image).

### Maintainer-Controlled Releases

Release authority, Semantic Versioning, and tag immutability are defined in [governance](GOVERNANCE.md#release-management). This section describes the maintainer procedure.

The semantic tag is separate from the CI build tag and can point to the same tested commit. For example, a maintainer can release the revision already identified by `main.12`:

```shell
git tag -a 1.4.0 main.12 -m "Release 1.4.0"
git push origin 1.4.0
```

Creating this tag does not currently trigger a release pipeline, publish an image/package, or create a GitHub Release. Manage announcements and distribution separately, and configure repository permissions and tag rulesets according to the [governance enforcement requirements](GOVERNANCE.md#enforcement).

## Deployment Responsibilities

Dependency Parser is self-hosted: the project supplies basic build/run and container tooling, not a managed deployment. Adapt the examples to your needs; operators own:

- **Environment:** infrastructure, networking, access controls, TLS, and secrets.
- **End-user access:** implement and maintain authentication and authorization in your own extension or fork before exposing the application to untrusted users. `GITHUB_TOKEN` provides backend Git repository access, not user sign-in or API access control.
- **Pipeline:** image distribution, deployment, updates, and rollback. Repository CI produces tested artifacts, not deployments.
- **Data and operations:** persistent storage, backups, monitoring, and provisioning/securing MongoDB when selected. The container defaults to JSON; MongoDB is optional and not bundled.

Review the [deployment limitations](docs/HLD.md#104-gaps-to-close-before-a-shared-or-production-deployment) before shared or production use.

## Build And Run In A Container

Choose **Podman or Docker**, using Linux containers. The [Dockerfile](Dockerfile) builds both applications and includes Node.js and Git, so host Node/npm/Git installations are not required just to build and run the image.

Run the following commands from the repository root. Both container engines expose the frontend and API together on port **3000**, not the development frontend port 4200. Do not run both examples at once or alongside a local backend using the same port.

The [backend container reference](backend/README.md#frontend-hosting-and-docker) describes the image's Node.js/Git versions, non-root runtime, storage permissions, and excluded build inputs.

### Optional GitHub Token Input

For private GitHub repositories, create a dedicated local `.env` file in the repository root containing only:

```dotenv
GITHUB_TOKEN=replace-with-your-read-only-token
```

The examples below use `--env-file {.env_file_path}` to pass the token at runtime. Replace `{.env_file_path}` with your dedicated environment file's path, for example `.env`, quoting paths containing spaces. If you do not need a token, omit that option; no environment file is required. Do not pass the full backend dotenv file unchanged: container environment files do not interpret inline comments like the backend's dotenv loader.

The root `.env` is gitignored and excluded from the image build context. Never commit it, copy it into the image, or put the token directly into a build argument or shell command. Keep the file private; users with container-management access can inspect container environment variables. This root file is for container input; local Node startup uses the [backend environment configuration](backend/README.md#configuration-and-persistence).

Use HTTPS GitHub repository URLs and a token with read access to every required repository; see [GitHub token authentication](backend/README.md#github-token-authentication).

### Podman

On Windows and macOS, Podman requires a Linux machine. If none exists, initialize one once:

```shell
podman machine init
```

Start the machine if it is stopped:

```shell
podman machine start
```

Linux users with a working local Podman engine can skip those machine commands.

Build the image before running it:

```shell
podman build --tag localhost/dependency-parser:local .
podman run --detach --pull=never --name dependency-parser --env-file {.env_file_path} --publish 127.0.0.1:3000:3000 --volume dependency-parser-data:/app/backend/data localhost/dependency-parser:local
```

The `localhost/` prefix is a local image name, not a registry you need to run. `--pull=never` prevents an accidental registry pull; if the image is missing, complete the build above or load a CI image first.

### Docker

Start Docker Engine or Docker Desktop with Linux containers enabled, then:

```shell
docker build --tag dependency-parser:local .
docker run --detach --pull=never --name dependency-parser --env-file {.env_file_path} --publish 127.0.0.1:3000:3000 --volume dependency-parser-data:/app/backend/data dependency-parser:local
```

### Check, Stop, And Restart

Open `http://localhost:3000`. Check the API with either:

**PowerShell:**

```powershell
Invoke-RestMethod http://localhost:3000/api/health
```

**Bash:**

```bash
curl --fail http://localhost:3000/api/health
```

The expected response is `{"status":"ok"}`. This checks API startup, not GitHub authentication. To test your token, save a project with an accessible private GitHub HTTPS repository URL and refresh its versions in the application.

| Action | Podman | Docker |
| --- | --- | --- |
| Read logs | `podman logs dependency-parser` | `docker logs dependency-parser` |
| Stop | `podman stop dependency-parser` | `docker stop dependency-parser` |
| Start the existing container | `podman start dependency-parser` | `docker start dependency-parser` |

The named `dependency-parser-data` volume retains JSON project definitions, tag catalogs, dependency snapshots, and clone caches across container restarts and recreation. Local backend data is not automatically copied into the image.

A container name can be used only once per engine. To replace the image or token, stop and remove the old container with `podman rm dependency-parser` or `docker rm dependency-parser`, then repeat the run command. Keep the named volume to preserve data; starting an existing container does not reload the token file or switch images.

If an older image logs `Selective tag discovery needs Git 2.45+; using packed cloning.`, scans still use the supported compatibility path, which can download more history. Check Git inside the running container with `podman exec dependency-parser git --version` or `docker exec dependency-parser git --version`.

The [current image](backend/README.md#frontend-hosting-and-docker) provides Git 2.45+. Rebuild it and recreate the container as described above, retaining the named volume. Upgrading host Git or restarting the existing container does not upgrade Git inside it. Existing full-clone caches are not converted automatically; see [tag catalog compatibility](backend/README.md#tag-history-and-snapshots).

These are local test containers, not a secured production deployment. Ports are bound to localhost because the API has no user authentication. The health check verifies the HTTP API, not external Git or MongoDB availability. Pass backend settings and repository credentials at runtime using `--env` or the dedicated environment file; see [backend configuration](backend/README.md#configuration-and-persistence).

### Loading A CI Image

To use a CI build instead of building locally, download its image artifact from the Actions run and extract the artifact ZIP. Each artifact name includes its version, workflow run ID, and attempt number; artifacts are retained for 14 days.

Load the contained compressed archive with your chosen engine, substituting the desired version:

| Engine | Load command |
| --- | --- |
| Podman | `podman load --input dependency-parser-main.12.tar.gz` |
| Docker | `docker load --input dependency-parser-main.12.tar.gz` |

Then use the imported versioned image name, for example `dependency-parser:main.12`, instead of `localhost/dependency-parser:local` or `dependency-parser:local` in the corresponding run command above. The archive also contains the full-SHA image tag. See [versioning rules](#versioned-git-tags-and-image-artifacts) for mainline, PR, and fork builds.

## Project Layout

```text
backend/   TypeScript/Express API, configuration, datastore files, and tests
frontend/  Angular application and tests
docs/      Application usage and design documentation
.github/   GitHub Actions CI, Copilot instructions, skills, and custom agents
```

For component boundaries and current gaps, see the [high-level design](docs/HLD.md) and [remaining work](docs/HLD.md#remaining-work).

## Copilot Workflows

The shared routing in [.github/copilot-instructions.md](.github/copilot-instructions.md) applies to the default Copilot agent and both repository custom agents:

- [Planner](.github/skills/planner/SKILL.md) proposes the main steps for new features, complex or ambiguous fixes, and nontrivial changes, then waits for approval before implementation. Trivial, unambiguous local edits do not require this gate; a plan-only request does not authorize implementation.
- [Verify Docs After Change](.github/skills/verify-docs-after-change/SKILL.md) checks documentation before completing implementation. It updates the relevant root, backend, or frontend README and affected existing files in `docs/`, including the high-level design, or reports why no documentation update is needed.

Copilot selects these skills using their descriptions and the routing instructions. They can also be invoked explicitly as `/planner` and `/verify-docs-after-change`. Application build/test/serve commands remain subject to the active agent's validation rules.
