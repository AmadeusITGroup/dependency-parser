# Backend

The backend is a TypeScript and Express API for defining projects, resolving dependency trees, locating versions, and comparing package versions across releases.

See the [running guide](../RUNNING.md#build-and-run-locally) for installation and startup. Run the backend build and test commands below from `backend/`. The server loads `.env` and resolves relative data paths from its working directory.

## Current Capabilities

- Project definition CRUD with stable UUIDs for projects and nested dependencies, case-insensitive duplicate-name checks, and string or regular-expression version references.
- Git-based version discovery for registered roots and configured nested dependencies, with complete regex-filtered tag catalogs independent of saved trees, and recursive dependency-tree resolution with npm (`package.json`) and Maven (`pom.xml`) parsers.
- [npm SemVer range resolution](#npm-version-ranges), selecting compatible Git tags before subtree traversal, with declared/resolved metadata and a configurable one-day TTL.
- [Exact tag-name matching](#exact-tag-names), keeping `v5.3.0` and `5.3.0` distinct without automatically adding or removing a prefix.
- Version creation timestamps on root and nested dependency-tree response nodes, using existing tag metadata without additional remote fetches.
- Newest-first search for the start of the latest parent release run containing a configured dependency at or above a requested version, including transitive dependencies. The minimum tag is validated against refreshed dependency tags before inspecting root releases; historical releases referencing missing versions are skipped.
- JSON or MongoDB persistence for project definitions, tag catalogs, and commit-aware dependency snapshots.
- Removed-tag history and retained snapshots, with cached version lists independent of local clones.
- Configurable background scans with cache reuse, failure isolation, and graceful shutdown.
- Root `package.json` version comparison, including a hosting-platform comparison URL.
- On-demand commit-history comparison for root and nested dependency projects, with exclusive commits, committer timestamps, commit links, a bounded 24-hour result cache, and adaptive tag-scoped history reuse. Browser links automatically recognize GitHub, GitLab.com, Bitbucket Cloud, and Bitbucket Server/Data Center on `bitbucket.<suffix>` hosts; see [repository browser links](#repository-browser-links).
- CORS and JSON request handling for local frontend development.
- Optional backend-only GitHub token authentication for HTTPS `github.com` repositories, including background scans.
- Optional same-origin hosting of the compiled Angular frontend, used by the repository's test Docker image.

## Development Server

For development and compiled startup commands, see [Run Components Separately](../RUNNING.md#run-components-separately-optional). The API defaults to `http://localhost:3000` with routes under `/api`. If you change `PORT` in the [environment setup](#environment-setup), update the frontend development proxy to match.

## Building

Compile TypeScript and coverage source maps into `dist/`:

```powershell
npm run build
```

## Linting And Verification

ESLint checks backend TypeScript and CommonJS test files using the [shared root configuration](../eslint.config.cjs). Install the root development dependencies as well as the backend dependencies before linting.

```powershell
npm run lint
npm run lint:fix
```

Warnings fail the check. The fix command applies supported automatic corrections and reports anything that still needs a manual fix.

Run lint, compile the backend, and execute its tests in order:

```powershell
npm run verify
```

For checks covering both applications and the GitHub Actions workflow, see [repository verification](../CONTRIBUTING.md#verification-and-ci).

## Running Tests

Tests use Node's built-in test runner and import the compiled backend. Build before running them:

```powershell
npm run build
npm test
```

Parser, version-search, and persistence fixtures use synthetic project/package names and example repository URLs. Provider URL tests retain supported platform hostnames to exercise detection and normalization, but do not contact them.

Git adapter regression tests create disposable local repositories and require Git on `PATH`; they do not contact external hosts.

On Windows, Git 2.56+ is recommended for the history-comparison regressions. Git 2.49 can intermittently abort adaptive-history fetches with a `BUG: builtin/pack-objects.c` assertion; upgrade Git and rerun rather than skipping the regression.

GitHub token regressions use dummy credentials and real Git URL matching to check HTTPS-only host scoping, inherited configuration, credential redaction, and the absence of credentials from command arguments and saved Git configuration. They do not authenticate against GitHub.

Commit-comparison regressions cover committer timestamps independently of author/tag dates, nested annotated tags, reversed and concurrent cache reuse, moved/deleted tags, failure retries, the exact 1,000-comparison capacity, and the 24-hour expiry boundary. Repository-history tests verify distant, merged, unrelated, and multiple-merge-base graphs; adaptive deepening and full selected-ancestry fallback; stale JSON/Mongo catalog hints; SHA-256 object-format repair; bounded reuse, eviction, shutdown cleanup, and isolation from scan catalogs.

### Test Coverage

Build fresh compiled output, run the ordinary test suite, and enforce the shared [coverage policy](../CONTRIBUTING.md#coverage-policy):

```powershell
npm run test:coverage
```

[c8 configuration](.c8rc.json) includes all compiled backend modules, including those not imported by tests, and remaps reports to TypeScript sources. Reports are written to `coverage/`: open `coverage/index.html` for the detailed report, or use `coverage/lcov.info`, `coverage/coverage-final.json`, and `coverage/coverage-summary.json` for tooling. Generated reports are not committed.

New isolated unit tests mirror their owning layer under `tests/domain/` and `tests/application/`; existing top-level regression suites remain in place. Project-service tests use an in-memory registry and mocked persistence, covering unique IDs, recursive validation, persistence ordering, and failures. The coverage command does not require a live MongoDB server or remote project repositories.

### Optional MongoDB Tests

Set `MONGODB_TEST_URI` to run MongoDB adapter tests against a real MongoDB server using temporary test databases:

```powershell
$env:MONGODB_TEST_URI = "mongodb://localhost:27017"
npm test
```

### Live JSON Scan Verification

The scan suite includes an opt-in test driven by any project-definition JSON file. It creates a new project through the HTTP API, starts the real scheduler with four Git slots, and checks that at least three complete dependency trees can be reloaded from JSON. Expected project IDs and names come from the created project, including every nested dependency, rather than a fixed repository list. It also records overlapping tree/Git work and tag refreshes during tree processing. Ordinary test runs skip this case.

Supply a root repository with at least three matching tags and accessible dependency versions. The root `tagPattern` is optional; when supplied, it filters the tags used by the scan. Repository names, dependency depth, and npm/Maven version-reference names are not prescribed.

```powershell
$env:SCAN_TEST_PROJECT = "C:\Path\To\project-definition.json"
npm test -- --test-reporter=spec --test-name-pattern="live project scan" tests/ScanScheduler.test.cjs
Remove-Item Env:SCAN_TEST_PROJECT
```

Compile first. The test requires existing Git access to the repositories; it disables interactive credential prompts. Each run uses a separate `data/scan-verification-*` directory for JSON files and fresh clones, leaves the current datastore and environment file unchanged, and retains `verification.json` plus the saved trees for inspection. It stops after enough trees are saved and waits for active work to finish; it does not attempt the full tag history.

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm run lint` | Check backend source and tests; requires root development dependencies. |
| `npm run lint:fix` | Apply automatically fixable backend lint corrections. |
| `npm test` | Run backend tests; compile first. Real-MongoDB checks require `MONGODB_TEST_URI`. |
| `npm run test:coverage` | Compile, run backend tests with c8, and enforce the shared coverage minimums. |
| `npm run verify` | Run lint, compile, and run backend tests with coverage enforcement. |

## Configuration And Persistence

Settings are read from the backend process environment and, for local Node.js startup, `.env` in its working directory. Existing environment variables take precedence over values in the file. Restart the backend after changing settings.

### Environment Setup

1. From the **repository root**, copy the [backend template](.env.example) to `backend/.env` if that file does not already exist. Preserve any existing local configuration.

   **PowerShell:**

   ```powershell
   Copy-Item backend\.env.example backend\.env
   ```

   **Bash:**

   ```bash
   cp backend/.env.example backend/.env
   ```

2. Edit `backend/.env` before starting:
   - Keep `DATASTORE=json` for local persistence without MongoDB. For MongoDB, set `DATASTORE=mongodb` and configure `MONGODB_URI`; see [MongoDB](#mongodb).
   - Remove or comment out the template's `GITHUB_TOKEN=<token>` line, or leave `GITHUB_TOKEN` blank, unless supplying a real read-only token. Public repositories do not require a token; private GitHub repositories can use [GitHub token authentication](#github-token-authentication).
   - Adjust optional settings using the [variable reference](#environment-variables) below. MongoDB settings are ignored when using JSON persistence.
3. Follow the [startup instructions](../RUNNING.md#start-both-applications).

The root launcher starts the backend with `backend/` as its working directory, so it reads `backend/.env`, **not a repository-root `.env`**. The Angular frontend does not need its own `.env` file. If you change `PORT`, also update the target in [frontend/proxy.conf.json](../frontend/proxy.conf.json) and restart the frontend development server.

Keep tokens and connection-string credentials backend-only. Local environment files are gitignored, not encrypted; never commit them or copy secrets into frontend configuration.

For containers, pass settings at runtime through `--env` or a dedicated `--env-file`; see [container environment input](../RUNNING.md#optional-github-token-input). Local environment files are excluded from the image. Do not reuse the backend template unchanged as a container environment file: Docker and Podman do not interpret its inline comments.

### Shell Overrides

A local environment file is optional if you supply settings through the process environment. Set the variables in the terminal before following the [startup instructions](../RUNNING.md#start-both-applications).

**PowerShell:**

```powershell
$env:DATASTORE = "json"
```

**Bash:**

```bash
export DATASTORE=json
```

These settings override `backend/.env` in the current terminal until the terminal closes or the variable is removed (`Remove-Item Env:\DATASTORE` in PowerShell, `unset DATASTORE` in Bash).

### Environment Variables

Defaults below apply when neither the process environment nor the local file supplies a value; the example file explicitly sets some different values.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port. |
| `FRONTEND_DIST` | None | Optional directory containing the Angular browser build and `index.html`; blank or unset keeps API-only startup. The Docker image sets `/app/frontend`. |
| `DATASTORE` | Nonpersistent | `json`, `mongodb`, or `memory`; unset or empty also disables persistence. |
| `MONGODB_URI` | None | Required when `DATASTORE=mongodb`; accepts `mongodb://` and Atlas `mongodb+srv://` connection strings. |
| `MONGODB_DATABASE` | `dependency_parser` | MongoDB database name. |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, or `debug` (case-insensitive). |
| `GIT_MAX_CONCURRENCY` | `4` | Positive integer: shared maximum of active application-launched Git commands, and per-phase background worker limit. Set `1` for serial work within each phase. |
| `GITHUB_TOKEN` | None | Optional personal access token for HTTPS `github.com` repositories; requires Git 2.31+. Unset or blank preserves existing authentication. See [GitHub token authentication](#github-token-authentication). |
| `DEPENDENCY_RESOLUTION_RETRIES` | `2` | Additional attempts after a confirmed missing dependency ref; `0` means one attempt. Does not retry or hide authentication, root-ref, configuration, or datastore errors. |
| `NPM_RANGE_RESOLUTION_TTL_MINUTES` | `1440` | Positive safe integer in minutes: cache lifetime for inferred npm range resolutions. Expired trees refresh on the next request or background scan; exact-only trees do not expire. |
| `DEPENDENCY_SCAN_ENABLED` | `true` | Enable automatic scans and datastore-backed version lists. With `false`, ordinary version-list requests refresh the source. |
| `DEPENDENCY_SCAN_INTERVAL_MINUTES` | `15` | Positive duration in minutes; fractional values are supported within Node's timer range (1 to 2147483647 milliseconds). |

### Frontend Hosting And Docker

Set `FRONTEND_DIST` to an absolute path or a path relative to the backend working directory to serve a compiled Angular browser build alongside `/api`. Startup fails if its `index.html` is missing or is not a file. Static assets are served directly, and HTML navigation routes fall back to that index, including project IDs containing dots. Missing API routes and non-HTML requests for missing asset files retain `404` responses. With this setting unset or blank, the backend remains API-only.

The [container guide](../RUNNING.md#build-and-run-in-a-container) covers building and running the combined image with Docker or Podman, including [loading CI image artifacts](../RUNNING.md#loading-a-ci-image).

All build and runtime stages use `node:24-trixie-slim` (Node.js 24 on Debian Trixie). The runtime installs Git 2.45+ from Debian's repositories for [selective tag discovery](#tag-history-and-snapshots), CA certificates, and SSH client tools. It runs the compiled backend and serves the production Angular build as the non-root `node` user (UID 1000), with working directory `/app/backend`, `DATASTORE=json`, and `FRONTEND_DIST=/app/frontend`. The frontend and API share port 3000.

Mount `/app/backend/data` to retain project definitions, tag catalogs, dependency snapshots, and the default clone cache. A new volume starts empty. Existing bind-mounted directories must be writable by UID 1000. Local datastore files, clones, environment files, and npm credentials are excluded by the allowlisted [build context](../.dockerignore); no development data or credentials are bundled.

Pass backend settings and repository credentials at runtime using `--env` or a dedicated environment file, never build arguments or image contents. MongoDB remains optional through the existing runtime settings; a MongoDB server is not included. The image health check verifies `/api/health`, not external Git or MongoDB availability. This is local test packaging; operators must address [deployment responsibilities](../RUNNING.md#deployment-responsibilities) and the [shared/production deployment gaps](../docs/SYSTEM.md#104-gaps-to-close-before-a-shared-or-production-deployment).

### GitHub Token Authentication

1. Create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) for the repository owner. Select every required root and nested dependency repository and grant **Contents: read-only** access. Set an expiration and obtain organization approval if required by its policy.
2. Set `GITHUB_TOKEN` in the backend process environment or the gitignored `backend/.env` file:

   ```dotenv
   GITHUB_TOKEN=replace-with-your-personal-access-token
   ```

3. Use HTTPS repository URLs, such as `https://github.com/owner/repository.git`, in project definitions, including nested dependencies. Do not embed the token in URLs or project JSON. Existing `git@github.com:owner/repository.git` URLs must be changed to HTTPS to use this setting.
4. Restart the backend. The shared Git client uses the token for cloning, tag refreshes, on-demand manifest reads, commit comparisons, and background scans. Existing HTTPS clones do not need to be recreated.

The adapter supplies a URL-scoped Basic Authorization header through temporary Git-process configuration, not command arguments or saved repository/global Git configuration. Inherited extra headers at this HTTPS GitHub scope are reset before the token header is applied. Configured raw and Basic-encoded credentials are redacted from Git failure messages. Keep the token private and backend-only; the environment file is gitignored, not encrypted. Never add a real token to [.env.example](.env.example) or frontend settings.

Unset or blank `GITHUB_TOKEN` leaves existing Git authentication unchanged. Surrounding whitespace is trimmed; embedded whitespace or control characters fail startup without printing the value. SSH, HTTP, GitHub Enterprise Server, and non-GitHub remotes continue using the host's existing Git authentication. Expired, revoked, or insufficiently scoped tokens must be replaced and the backend restarted; automatic token refresh is not provided.

This is one shared backend credential, not user sign-in or API authorization. All application users still share the backend's repository access; do not expose the API as though this setting protects it. Operators must add end-user authentication and authorization in their own extension or fork before exposing the application to untrusted users; see [deployment responsibilities](../RUNNING.md#deployment-responsibilities).

### JSON

`DATASTORE=json` loads the seed files in `data/` and enables project persistence. Project definitions, tag metadata, and resolved snapshots are stored in `data/projects.json`, `data/tags.json`, and `data/dependency-trees.json` respectively.

The JSON datastore is intended for local development. Reads and writes are serialized within one datastore instance, but access from multiple processes is not coordinated.

### MongoDB

Start a MongoDB server locally or use an existing deployment, then configure the backend:

```powershell
$env:DATASTORE = "mongodb"
$env:MONGODB_URI = "mongodb://localhost:27017"
$env:MONGODB_DATABASE = "dependency_parser"
```

Then follow the [startup instructions](../RUNNING.md#start-both-applications). Keep credentials in environment variables or the uncommitted `.env` file.

MongoDB stores project definitions in `projects`, tag metadata in `tags` (unique project ID and tag name), and resolved snapshots in `dependencyTrees` (unique project ID, version, and commit hash). Regular-expression version references are preserved. Existing JSON files are not automatically imported.

Startup fails if MongoDB cannot connect or the datastore configuration is invalid; it does not silently fall back to another store. Connections are closed on normal server shutdown (`SIGINT` or `SIGTERM`).

### Without Persistence

`DATASTORE=memory` (or an unset/empty `DATASTORE`) disables persistence and dependency-tree caching. Project create, update, and delete endpoints return `503` until a persistent datastore is configured.

## Logging

The backend uses a dependency-free console logger with an ISO timestamp and level prefix. Each level includes the more severe levels: `debug` emits all four, while `error` emits only errors. Info/debug logs go to standard output; warnings/errors go to standard error. Context fields and error details accompany the message.

```dotenv
LOG_LEVEL=debug
```

```text
2026-10-21T09:30:00.000Z [DEBUG] Dependency tag refresh started.
```

Info logs cover server startup/shutdown, loaded project count and datastore type, scan scheduling, and separate tag-refresh/tree-processing summaries with `phase`, duration, counts, `pendingTreeCount`, `activeTreeCount`, and `maximumConcurrency`. Startup records `gitMaxConcurrency` and the boolean `githubTokenConfigured`, never the token value. Debug logs mark phase starts and ticks skipped because a tag refresh is already running; active tree workers do not skip tag refreshes. Warnings explain disabled scanning without persistence; errors identify the phase and failed project/tag or lifecycle operation. Repository credentials and connection strings are not included in startup info logs.

Startup also emits an info message identifying the selected GitHub HTTPS authentication mode:

- With a token: `GitHub HTTPS authentication: using GITHUB_TOKEN.`
- Without a token (unset or blank): `GitHub HTTPS authentication: using default Git authentication (GITHUB_TOKEN is not configured).`

These messages are visible at `LOG_LEVEL=info` or `debug`. They describe the configured mode, not a successful GitHub authentication check. SSH and other hosts still use default Git authentication, even when a token is configured.

With `LOG_LEVEL=debug`, each tree job emits `Dependency tree job started.`, followed by `completed.` or `failed.`. Context includes project, tag, `creationDate` (the ISO timestamp used for priority, or `null`), commit hash, `activeTreeCount`, `pendingTreeCount`, `attempt`, and `maximumAttempts`; end events include `durationMs`. Failed jobs also emit an immediate error-level entry with the same `creationDate`, the original exception, and `retryExhausted`, without waiting for the tree pool to drain or repeating the error at phase completion. The third failed attempt has `retryExhausted: true` and is not scheduled again for that unchanged tag/configuration in the session. A missing required dependency ref prevents a complete saved tree for that release; other queued jobs continue. A start event with `activeTreeCount` greater than one shows overlapping tree jobs, though some may be waiting for Git or datastore work. MongoDB documents are saved as individual trees finish, so their arrival order does not measure build concurrency. Start with a small Git limit such as 4 to 8 and measure; higher limits can add process and server overhead.

## Background Dependency Scans

With `DATASTORE=json` or `DATASTORE=mongodb`, the backend refreshes project tags as soon as the API is listening, then repeats the refresh every 15 minutes by default. Each pass reads the current registry and refreshes every unique registered root and configured dependency, including nested descendants, once by project ID. It retrieves each repository's complete Git tag list and filters it by that project's pattern before persistence, including tags never referenced by a saved tree. Only active matching versions of registered roots enter the in-memory tree-job queue; dependency catalogs do not create independent tree jobs unless that dependency is itself a registered root. Matching removed tags remain in the catalog but are not queued for resolution.

Tag-refresh summary `projectCount` and `tagCount` include nested catalogs and their active matching tags. Tree-processing counts continue to describe root tree jobs. Dependency catalogs refresh on later passes even when every root tree is already saved.

A bounded tree-worker pool processes the shared queue across projects, including different tags of the same project in parallel. Each free worker selects pending tags across all projects by `creationDate`, newest first: Git's `creatordate` uses the tagger date for annotated tags and the commit's committer date for lightweight tags. Git does not record a separate creation timestamp for lightweight tag refs. Version numbers never override a known date; tags without a date follow all dated tags, and numeric tag-name ordering only breaks date ties or orders undated tags. A newly discovered tag can move ahead of older pending work even when its version number is lower; running trees are never interrupted. Jobs are deduplicated by project, tag name, commit hash, and project configuration, including nested dependency definitions and regular-expression references. Refreshes remove obsolete pending commits/configurations, removed tags, and deleted projects. Tags with a current saved snapshot are skipped, including partial trees and snapshots retained across restarts. Successful jobs are also remembered for the session, so unchanged refreshes cannot repeatedly push completed newer tags ahead of the older backlog. Trees containing npm ranges become eligible again when their resolution TTL expires, including session-completed jobs.

```dotenv
DEPENDENCY_SCAN_ENABLED=true
DEPENDENCY_SCAN_INTERVAL_MINUTES=15
GIT_MAX_CONCURRENCY=4
```

Scans are disabled when persistence is disabled. Each tag-refresh pass visits up to `GIT_MAX_CONCURRENCY` projects concurrently and continues on scheduled ticks while trees are being built. A tick is skipped only if another tag-refresh pass is active; only one tree-worker pool runs, with up to the same number of active tree jobs. A failed project or tag is logged without blocking other jobs. Failed tree jobs can be queued on later refreshes, up to three total attempts per unchanged tag/configuration per session; there is no immediate retry loop. Saved partial trees are not retried by scans unless their npm range resolution TTL expires. New commits or changed project configurations become eligible again. Unexpected pool failures wait for a later refresh before retrying. On shutdown, the timer stops, no further projects or queued trees start, and all active refreshes and tree resolutions finish before the datastore is closed.

The shared Git client enforces the command limit across both phases and API requests; two pools of four workers do not allow eight active Git commands. Repository mutations (clone, fetch, ref changes, checkout, removal) take exclusive access per clone, while revision-pinned file and metadata reads can run together. Ready-clone/ref checks bypass the resolver's preparation queue; missing clones or refs still use its serialized preparation path. Blobless-clone reads may fetch missing blobs inside Git; they still occupy their application command slot. The setting caps commands, not Git-internal processes or exact network connections. JSON storage operations remain serialized, and speedup depends on cache state and the Git server.

The scheduler, pending queue, and attempt history are local to each backend process, not a durable or distributed job queue. A temporarily removed tag returning at the same commit/configuration retains its session attempt budget. Restarting resets failed-job attempt budgets; startup queues only work without a current saved snapshot. Newest-first priority can delay older tags when genuinely new work keeps arriving. For multiple backend processes, use MongoDB and enable scanning on only one process to avoid duplicate background work.

### Missing Dependency Tags

Versions read from a parent manifest remain on the referenced dependency node, even when that dependency's Git tag cannot be inspected. After `DEPENDENCY_RESOLUTION_RETRIES` additional confirmed missing-ref attempts (two by default, or three total attempts), the resolver preserves that declared version, sets `dependenciesResolved: false`, and populates its configured descendants with `version: "unknown"`. For example, a parent at `1.2.3` referencing an unavailable child at `2.3.4` retains that child's `2.3.4` label; only its uninspectable descendants have unknown versions. An unavailable leaf keeps its declared version and has no invented children. Resolved siblings remain intact, and the partial tree is saved.

Concurrent requests for the same dependency/ref share their in-flight retry attempts. A warning records the declared version, attempt count, and final missing-ref cause. Only confirmed missing dependency refs use this fallback; root-version, authentication, network, manifest/configuration, and persistence errors still fail normally.

Tree nodes in the API and snapshots may contain `dependenciesResolved: false` when inspection is unresolved; absence means the default `true`. This flag is separate from the version string. Explicit dependency-tree requests and root-version searches can try to recover active partial snapshots. An npm range with no matching tag retains its unresolved result until its TTL expires, rather than rediscovering tags on every request. Automatic scans skip saved partial snapshots until the root commit or project configuration changes, or an npm range resolution expires. A completed scan job can therefore have a saved partial tree rather than a fully inspected tree.

## Tag History And Snapshots

Tag metadata is stored independently of dependency trees for both roots and configured nested dependencies. Each record contains `projectId`, `name`, `commitHash`, `creationDate`, and `removed`. Only tags matching the project's `tagPattern` are persisted; matching tags are retained even when tree computation fails or no root tree references them. An unset pattern accepts all tags. Git enumerates remote tags to evaluate the regex, but nonmatching tags are not stored in the catalog or scanned for dependency trees.

Tag discovery uses Git only; it does not call a hosting provider's REST/GraphQL API or require a separate API token. When the project has a selective `tagPattern`, a remote ref advertisement is filtered before objects are transferred. New selective catalogs use depth-1, checkout-free `blob:none` retrieval and atomic reftable updates, preserving native tag dates and peeled commit hashes, including tags outside the default branch. Refreshes fetch only changed tag-object OIDs and explicitly remove absent/excluded local tag refs before reconciling the complete matching catalog.

The optimized catalog requires Git 2.45+ and uses its reftable format, which Git 2.49 still labels experimental. This format is used only for new application-owned catalog caches; existing full clones are not migrated. Unsupported Git versions emit a warning and use the packed compatibility strategy. An unset pattern, an initially empty remote tag set, or a pattern matching every advertised tag also uses the full-tag strategy. Selection and fallback are internal to the Git adapter; no additional environment setting or server wiring is required.

Packed compatibility catalogs start with one checkout-free, blobless full clone so Git packs the initial refs rather than creating a loose file per tag. Existing full-cache refreshes use an atomic tag-only fetch, updating moved tags and pruning deleted tags without refreshing cached remote-tracking branches. Unrelated branch-ref conflicts such as `origin/bump` blocking `origin/bump/merge` do not abort these refreshes.

Both strategies retain directory-tree metadata via `blob:none` and download file contents on demand. The previously evaluated all-history `tree:0` strategy is not used. Tag metadata is persisted only after a successful complete synchronization; partial or failed retrievals are not treated as an empty catalog.

Version catalogs use the existing `<CLONE_ROOT>/<sanitized project id>` cache layout (default `backend/data/repositories/git` when started from `backend/`). This preserves cache sharing with dependency resolution. If the resolver needs an exact ref/history not available in a shallow catalog, its existing unfiltered `syncTags` call expands that cache to full branch/tag history and initializes the default branch/HEAD. Subsequent refreshes use the full-cache compatibility path. No targeted source-cache directory or manifest-read cache is used. Clearing local caches does not clear persisted metadata or snapshots.

These catalog optimizations do not change file-existence checks or manifest parsing. Dependency refs follow the [exact-tag policy](#exact-tag-names), and snapshots follow the fingerprint rules below.

MongoDB reconciles tag upserts and excluded-tag deletions in a bulk write instead of making a database round trip for every catalog entry. Both persistence adapters retain the same tag metadata and removal policy. A cold request still needs Git network access and complete tag enumeration to preserve creation dates and peeled commit hashes; subsequent scan-enabled requests can reuse the stored catalog.

Only a successful complete Git refresh can mark an absent matching tag as removed. That refresh also removes previously stored catalog entries outside the current pattern, without deleting their saved trees. Failed refreshes leave the catalog unchanged, and a reappearing matching tag clears its removed flag. Datastore-backed version lists read this catalog without requiring a local clone, so browser storage resets and clone cleanup do not erase known matching tags.

Removed versions remain browsable when a saved tree exists, including snapshots made before project configuration changes. A removed version without a saved tree remains listed but cannot be resolved from metadata alone. `latest` always refers to an active tag. See the [frontend README](../frontend/README.md#current-screens) for version-picker behavior.

Snapshots are associated with the tag's commit hash and a configuration fingerprint that includes the project definition, exact-tag matching policy, and npm range-resolution policy. Configuration changes invalidate active cache reuse without deleting historical snapshots; moved tags cannot silently reuse another commit's tree. Active snapshots created before npm range support or under the earlier automatic `v`-prefix alias policy are invalidated and recomputed on the next tree request or scan. Removed-tag historical snapshots remain available without TTL expiry, and persisted tag catalogs are unchanged. Changing a project's repository URL clears its old catalog and snapshots, and explicitly deleting a project removes both.

The tag/snapshot format assumes a fresh datastore; no migration from the earlier tree-only format is provided. Only tags observed by a successful refresh can be retained. Metadata and saved trees are not a source archive: a commit hash alone cannot guarantee future source access or recomputation after deletion.

## API Overview

All API routes are mounted under `/api`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Check that the API is running. |
| `GET` | `/api/projects` | List saved project definitions. |
| `POST` | `/api/projects` | Create a saved project definition. |
| `GET` | `/api/projects/:projectId` | Retrieve one project definition. |
| `PUT` | `/api/projects/:projectId` | Update a saved project definition. |
| `DELETE` | `/api/projects/:projectId` | Delete a project and its saved dependency history. |
| `GET` | `/api/projects/:projectId/versions` | List active and removed catalog entries using the scan-aware policy below; `?forceRefresh=true` refreshes the source and persists tags. |
| `GET` | `/api/projects/:projectId/versions/:requestedVersion` | Resolve a requested version. |
| `GET` | `/api/projects/:projectId/versions/:version/dependencies` | Resolve a dependency tree for a project version. |
| `GET` | `/api/projects/:projectId/find-root-version?dependencyProjectId=&minimumVersion=` | Find the first parent version in the latest run containing a configured dependency at the requested minimum or newer. |
| `GET` | `/api/projects/:projectId/commit-diffs?fromVersion=&toVersion=` | Return commits reachable from only one of two versions of a root or nested project. |
| `GET` | `/api/projects/:projectId/diffs/:fromVersion/:toVersion` | Compare `package.json` between two versions. |

The existing version, dependency, and package-manifest diff endpoints also have query-based aliases such as `/api/versions`, `/api/dependencies`, and `/api/diffs`; the required values, including `projectId`, are supplied as query parameters. The commit-diff endpoint has no additional aliases.

Version listing and single-version lookup accept the ID of either a registered root or any configured nested dependency. They use that project's own repository and `tagPattern`; version lists are not derived from root-tree contents. Tree-resolution and root-version-search routes still require a registered root.

Version listing uses one source-neutral query flag, `forceRefresh`, in place of the earlier `cached` selector:

| `forceRefresh` | `DEPENDENCY_SCAN_ENABLED=true` | `DEPENDENCY_SCAN_ENABLED=false` |
| --- | --- | --- |
| Omitted or `false` | Read the datastore tag catalog; refresh the source if the cached version list is empty. | Retrieve tags from the source and persist them. |
| `true` | Retrieve tags from the source and persist them. | Retrieve tags from the source and persist them. |

The current source adapter is Git. The flag applies to both version-list routes and does not trigger dependency-tree computation. Configure JSON or MongoDB persistence for datastore-backed lists. When the cached version list is empty, an ordinary listing automatically refreshes Git tags and persists those matching the project pattern; nonempty cached lists are reused. If Git also returns no matching tags, the request returns an empty list without a retry loop. Scheduled scans still refresh the source on every pass. This policy concerns listing versions, not resolving a single version or dependency tree.

Version lists return `{ projectId, versions, latest }`. Each version includes `version`, `creationDate`, `commitHash`, `removed`, and `hasDependencyTree`; the Git date is an ISO string or null. `latest` is the newest active entry or null. The dependency endpoint returns a retained snapshot for a removed tag, or `404` if no saved tree exists.

Dependency resolution may need access to the configured repositories and a working Git installation.

### Exact Tag Names

Tag names are literal: `v5.3.0` and `5.3.0` identify different tags. The backend never adds or removes `v` during version lookup, dependency-ref resolution, minimum-tag validation, commit comparison, or tag-date lookup. This applies to both cached and freshly retrieved data. `latest` still selects the newest active tag.

The project's `tagPattern` filters the original tag name, without normalization; an optional `v?` explicitly accepts both forms but does not make them interchangeable. See the [tag-regex examples](../DEMO.md#fill-in-the-root-project).

A parent manifest declaring `5.3.0` therefore cannot resolve against a dependency tag named only `v5.3.0`, or vice versa. A missing exact dependency ref follows the existing bounded-retry and unresolved-inspection policy rather than substituting another tag.

### npm Version Ranges

For `package.json` dependency links, the npm parser implements the optional `IPackageParser.resolveVersion` hook. It uses the standard `semver` library, not prefix stripping. The shared resolver supplies fresh Git tags and traverses the selected source ref; Maven does not implement this hook and keeps its existing behavior. Parsing and root manifest diffs still preserve the original declaration.

Supported range forms include `^2.3.0`, `~2.3.0`, `*`, `2.x`, `2.3.x`, partial versions such as `2.3`, comparator sets such as `>=2.3.0 <3.0.0`, hyphen ranges, `||` alternatives, and `=2.3.0`. npm's normal zero-major and prerelease rules apply: for example, `^0.2.3` stays below `0.3.0`, and ordinary stable ranges exclude prereleases.

Selection uses the highest compatible SemVer among active Git tags accepted by that dependency project's `tagPattern`, not the tag with the newest date. Standard `v`-prefixed tags participate in SemVer comparison, but the selected original tag is used unchanged for Git reads, dates, and UI labels. Equivalent versions are selected deterministically by original tag-name order. Exact declarations such as `2.3.0` and `v2.3.0` retain literal-ref behavior and do not trigger catalog discovery.

Persisted nodes retain `declaredVersion`, nullable `resolvedVersion`, and nullable ISO UTC `resolutionCheckedAt`. `version` remains the display/traversal value: the selected tag for ranges, the original exact declaration otherwise. Range-node responses also expose the three metadata fields; the frontend displays only `version`. For example:

```json
{
  "version": "v2.4.1",
  "declaredVersion": "^2.3.0",
  "resolvedVersion": "v2.4.1",
  "resolutionCheckedAt": "2026-11-04T00:00:00.000Z"
}
```

These are inferred Git-tag selections, not evidence of what an older release installed. No npm registry or lockfile is read. Registry tags (`latest`, `next`), `npm:` aliases, workspace/file specifications, and Git URL specifications retain their existing literal-ref behavior rather than being guessed from SemVer.

`NPM_RANGE_RESOLUTION_TTL_MINUTES=1440` defaults to one day and requires a positive integer number of minutes. A tree expires when its earliest range-resolution timestamp reaches that age. The next request or background scan refreshes the relevant catalogs and rebuilds the tree; no separate expiry timer or deletion is used. Timestamps survive JSON/MongoDB reloads, and changing the configured TTL applies to existing timestamps after restart. Exact-only and Maven-only trees do not expire. Without persistence, there is no saved tree cache.

If no tag satisfies a range, the node retains the declaration, has `resolvedVersion: null` and `dependenciesResolved: false`, and its configured descendants remain `unknown`. A warning is logged and this no-match result can be retried after TTL expiry. Existing missing-ref retries remain unchanged, and rebuilding a partial tree before expiry reuses its still-fresh range selections. Git/authentication/network or datastore failures fail the request/job; expired data is not silently served as a successful refresh.

### Dependency Tree Timestamps

Every node in a dependency-tree response includes `creationDate`, an ISO UTC string or `null`. This also applies to the matched tree returned by Find Root Version. The timestamp is the annotated tag's tagger date or the lightweight tag's commit committer date, not the dependency scan time. Git does not record a separate ref-creation time for lightweight tags.

The shared response-metadata service reads stored tag dates once per distinct project and, when an exact tag is absent, can read that project's existing local clone once. It never clones, fetches, or refreshes tags just to supply dates. Dates require an exact tag name, including its `v` prefix or lack of one; retained removed-tag metadata remains usable. Missing dates, unknown versions, and versions without known tag metadata return `null`; metadata read errors remain API errors.

Dates are added to HTTP responses rather than persisted into dependency-tree snapshots. Existing snapshots therefore need no migration for this field, and background scanning, version ordering, and tree-cache validity are unchanged. See the [frontend timestamp display](../frontend/README.md#current-screens).

### Commit Changelogs

`GET /api/projects/:projectId/commit-diffs` requires `fromVersion` (the baseline) and `toVersion` (the comparison) query parameters. The project ID can identify either a registered root or any configured nested dependency. This is a Git-history comparison, independent of npm/Maven manifests and separate from the existing `/diffs` package-manifest endpoint.

`CommitDiffDTO` contains `projectId`, `projectName`, `fromVersion`, `toVersion`, the resolved full `fromCommitHash` and `toCommitHash`, and two arrays:

- `fromOnly`: commits reachable from the baseline ref but not from the comparison ref.
- `toOnly`: commits reachable from the comparison ref but not from the baseline ref.

Every commit has its full `hash`, `subject` (commit title), `committedAt` (the committer's ISO 8601 timestamp, including its original offset), and browser `url`. The timestamp comes from Git `%cI`, not the author date or tag date. The backend chooses the [browser-link format](#repository-browser-links) from the repository hostname, without calling a hosting-provider API.

Git peels annotated tags to commits and resolves the requested ref without adding or removing a `v` prefix. A missing exact ref is not replaced by a differently prefixed tag. Comparison uses commit reachability, not version numbers or tag dates, and returns descendants before their ancestors. Shared commits, including an older boundary commit, are excluded. Upgrades usually populate `toOnly`; downgrades populate `fromOnly`; diverged histories can populate both. Different tags pointing to the same commit return two empty arrays.

Tag comparisons initialize or reuse an isolated repository without a checkout and fetch only the requested tag refs, not every tag or branch in the source repository. Git's `tree:0` filter omits file trees and contents when the server supports filtering. `show-ref --dereference` resolves the fetched tags together locally, including nested annotated tags, while preserving exact tag names.

History starts at a depth of **64 commits**, but this is **not a limit on the returned changelog**. If either exclusive list reaches a shallow boundary, its unknown ancestors could affect the result, so the backend deepens the selected histories by 64, 128, 256, and 512 commits as needed. If those rounds still cannot prove completeness, it retrieves the complete ancestry of the selected refs. A result is returned only when no exclusive commit reaches a shallow boundary; boundaries confined to shared history are harmless. Moved tag identities are resolved again after each fetch. Failed or incomplete history retrieval remains an error, never a truncated or fabricated empty changelog.

On a result-cache miss, the use case reads exact active tag entries from the configured JSON/MongoDB datastore when available. Their commit identities are only hints for tag names and repository object format: Git still refreshes the actual refs before comparison. This normally avoids a separate remote ref lookup. Missing, removed, or unknown-identity entries use remote discovery instead; stale hints are rediscovered if their refs no longer fetch, and repository object formats are repaired against remote metadata when necessary. Invalid stored metadata and datastore read failures are surfaced rather than silently ignored. Result-cache hits need neither tag lookups nor Git work.

`GitCliClient` retains up to **8 comparison repositories per backend process** in the operating system's temporary directory, separate from `CLONE_ROOT` and scan catalogs. Least-recently-used idle repositories are deleted when capacity is exceeded; active comparisons are never evicted, so concurrent work can temporarily exceed this count. Comparisons sharing a repository serialize refresh, deepening, and traversal, while all Git commands continue to use the shared concurrency limiter. Normal backend shutdown waits for active history operations and deletes these directories. The bound is repository count, not disk bytes; forced termination can leave temporary directories behind. Histories are not restored across restarts, and there is no new configuration or JSON/MongoDB persistence requirement.

Refs requiring general Git resolution, such as revision expressions and object IDs, retain the original isolated temporary-clone path; those clones are removed after success or failure. Neither path deepens shared shallow catalogs or runs dependency resolution.

`CompareVersionCommits` keeps successful comparisons in memory for **24 hours after completion**, up to **1,000 project/repository/ref pairs per backend process**. The pair is direction-independent: reversing the versions reuses the same entry and swaps commit lists and endpoint hashes. Concurrent requests for the same pair share one operation, including opposite directions. Empty successful comparisons are cached; Git or link-provider failures are not.

Cache hits update least-recently-used ordering without extending expiry. Expired entries are discarded, and reaching capacity evicts the least recently used comparison. Project ID and repository URL are part of the key, so a repository change cannot reuse another repository's result. Every request still validates the current project and returns its current name. Entries are neither persisted nor shared between backend processes; a backend restart clears the cache.

Reopening the popup still sends an HTTP request, but a cache hit does not clone or fetch Git. Moved/deleted tags can retain their previous comparison until its 24-hour expiry or eviction; refreshing the version catalog does not clear this separate runtime cache. There is no new cache setting or persistence requirement.

Missing, repeated, empty, or unsafe query values return `400`. Unknown projects and unavailable uncached refs return `404`; a retained dependency-tree snapshot does not restore a deleted tag ref for this endpoint. Other Git, catalog-read, network, or link-provider failures are logged and return `500` with a readable error rather than an empty changelog.

### Repository Browser Links

`AutoDetectSourceControlProvider` implements the existing source-control URL interface. Both commit changelogs and package-manifest comparison links use it. It also supplies platform-specific repository-browse and file links.

| Repository hostname | Platform | Commit browser path |
| --- | --- | --- |
| `github.com` | GitHub | `/owner/repository/commit/<hash>` |
| `gitlab.com` | GitLab, including nested groups | `/group/subgroup/repository/-/commit/<hash>` |
| `bitbucket.org` | Bitbucket Cloud | `/workspace/repository/commits/<hash>` |
| `bitbucket.<suffix>` (except `bitbucket.org`) | Bitbucket Server/Data Center | `/projects/KEY/repos/repository/commits/<hash>` |

Detection ignores hostname case. `github.com`, `gitlab.com`, and `bitbucket.org` are exact matches; Bitbucket Cloud is checked before the Server rule. Other hostnames beginning with `bitbucket.` and a non-empty suffix use Bitbucket Server/Data Center URL formats. This prefix rule selects a browser-link format, not a trusted host or authorization policy. Hosts outside these rules fail explicitly rather than guessing a provider.

HTTP(S), SCP-style SSH (`git@host:path`), and `ssh://git@host:port/path` repository addresses are accepted. Trailing `.git`/slashes are normalized, GitLab namespaces are preserved, and refs/file paths are URL-encoded. Credentials, query strings, and fragments from repository addresses are omitted from generated links. HTTP(S) web ports are preserved; SSH transport ports are not reused as browser ports, and SSH addresses produce HTTPS links.

For Bitbucket Server hosts, these addresses produce the same web repository base:

```text
https://bitbucket.example.com/projects/EXAMPLE/repos/repository
https://bitbucket.example.com/scm/example/repository.git
ssh://git@bitbucket.example.com:7999/EXAMPLE/repository.git
```

The resulting commit link is `https://bitbucket.example.com/projects/EXAMPLE/repos/repository/commits/<hash>`. Server comparison links use `sourceBranch=<comparison>` and `targetBranch=<baseline>`; Bitbucket Cloud uses its incoming-ref-first comparison path. GitHub and GitLab comparison paths keep baseline before comparison.

This normalization constructs browser links only: Git cloning/fetching still receives the original configured clone address. A Bitbucket web URL is not automatically converted into a Git clone endpoint; use the repository's actual **Clone URL** for Git access. No new environment settings, persisted fields, or frontend DTO changes are required. Self-hosted instances and SSH host aliases outside the supported hostname rules, and custom URL templates, are not detected. Unsupported/malformed URL errors are explicit, and the changelog endpoint logs them and returns their safe message with `500`.

### Find Root Version

`GET /api/projects/:projectId/find-root-version` requires `dependencyProjectId` and `minimumVersion` query parameters. The dependency must be a configured descendant of the root project; it can be nested several levels deep. This is the canonical endpoint; earlier URL aliases are not registered.

Before listing or inspecting root releases, each new search refreshes the selected dependency's complete repository tag catalog using the same Git discovery and regex filtering as a root project. The trimmed `minimumVersion` must name an active matching tag exactly, including its `v` prefix or lack of one. The tag need not have appeared in any saved tree. Arbitrary numeric thresholds that do not name a matching tag, differently prefixed tags, removed tags, and tags outside the dependency's pattern return `400` without starting the root scan. Tag retrieval or persistence failures remain `500`, not evidence that the tag is absent. This check also updates the dependency's persisted catalog; background scans refresh it independently on their normal schedule.

The search sorts parent releases by tag `creationDate`, newest first, with numeric version fields as the tie-breaker. Undated or invalid-date tags follow dated tags and use numeric ordering among themselves. This prevents old version lines such as `24.x` from preceding recent `3.3.x` tags simply because their numeric versions are higher. Dependency-version comparison remains numeric. The search resolves or reuses each tree sequentially: a known occurrence meeting the minimum replaces the retained candidate, and the first confirmed non-match stops the search without resolving older trees. If the newest inspectable release does not qualify, it returns no match immediately.

After dependency-tag validation, listing the root's releases shares the version endpoint's scan-aware policy: with dependency scans enabled, a nonempty cached root catalog is reused; an empty catalog or disabled scans triggers source retrieval. Only the dependency's validation forces a source refresh on every new search. Use the existing version-list refresh action or `forceRefresh=true` on the listing endpoint when an explicit root-catalog refresh is needed.

This locates the start of the latest inspectable qualifying run in date order, not the globally oldest matching release if dependency versions are downgraded, removed, or later reintroduced. Binary search is not used because matching is not guaranteed to be monotonic. Tag dates and numeric fields are parsed once per search, complete cached trees are reused, and tree resolution stops at the boundary; the worst case still visits every release when all qualify or are skipped.

When a root or nested dependency ref is still absent after a successful tag refresh, the resolver raises `VersionNotFoundError` and the search skips that root release without treating it as a non-match boundary. This handles deleted temporary versions such as `1.0.0-pr-15867.0` without special-casing naming conventions. Each skip is logged at warning level with the root project, root release, and missing version. Skipped releases cannot be classified as matches or non-matches.

Unknown versions in unrelated branches do not block the search. A known matching occurrence is sufficient to qualify a tree, even if another occurrence is unknown. Without a known match, unknown versions on a configured ancestor path or the selected dependency make the tree undecidable: the search logs a warning and skips that release, preserving the last known match rather than treating the unknown as a non-match boundary. Relevant ancestor IDs are collected once from the project definition. Skipped unknown trees cannot establish the exact historical introduction point.

Version comparison reads digit sequences from the project's regex-matched tag text from left to right, once each, regardless of optional, nested, or noncapturing groups. Labels and separators do not affect numeric precedence: `3.3.29 < 3.3.29-fix.2 < 3.3.29-fix.12 < 3.3.30`. Dotted and labeled numeric versions such as these also work without a matching tag pattern; other layouts require a matching `tagPattern`. Missing trailing fields count as zero, equality qualifies, and numeric fields retain arbitrary precision. Labels such as `patch`, `fix`, and `revision` have no special meaning; this is numeric field comparison, not SemVer prerelease ordering.

The response contains `projectId`, `dependencyProjectId`, `minimumVersion`, `checkedVersions`, `totalVersions`, `warnings`, and `match`. A match includes the parent `version`, actual `dependencyVersion`, root-to-dependency `path`, and full `dependencyTree` in the existing tree DTO format. `checkedVersions` counts attempted releases, including skipped missing refs, skipped unknown trees, and the first non-match boundary; `totalVersions` remains the complete catalog count. No match returns `200` with `match: null` when the newest inspectable release does not qualify, there are no tags, or every release is skipped.

`warnings` is always an array, empty when every inspected tree is available and fully resolved. Each affected root tag has one entry containing its `version`, `reason` (`tree_unavailable` or `partial_tree`), `message`, and `dependencies`. An unavailable tree's message identifies the missing ref and repository; its dependency list is empty. A partial tree lists each distinct unresolved dependency/version with `projectId`, `projectName`, `version`, and `reason` (`unknown_version` or `unretrievable_version`). Known declared versions remain unchanged. Warnings include partial matching trees, unrelated unresolved branches, skipped releases, and a partial non-match boundary, but never tags beyond the stopping boundary. They accompany both match and no-match results and do not change the search's classification rules. The frontend exposes them through a clickable, tag-grouped warning dialog.

With `LOG_LEVEL=debug`, decision logs identify each inspected root release, match, missing-ref skip, and stopping boundary; relevant unknown skips are warnings. The final `decision: "boundary"` entry includes `dependencyVersion` (the first occurrence in the inspected tree, or `null` if absent) and `candidateVersion` (the retained matching root release, or `null` if none). An info summary includes the returned version, boundary version, attempted count, and catalog count. This makes it possible to verify that no older release is inspected beyond the boundary.

Missing or invalid inputs, unregistered roots, unrelated dependencies, uncomparable minimums, and minimum tags absent from the dependency's active matching catalog return `400`. Authentication, network, persistence, manifest, and comparison failures encountered during validation or before the boundary stop the search with `500`; confirmed missing refs and undecidable relevant unknown trees encountered while inspecting historical root releases are skipped. A failed refresh is not treated as proof that a ref is missing. A removed root release can qualify through its retained tree, but a removed root catalog entry without a retained tree still stops the search if encountered before the boundary.

## Project Layout

```text
data/                 JSON datastore files and local repository clones
src/domain/           Domain models, interfaces, and types
src/application/      DTOs, services, and use cases
src/infrastructure/   Git, npm/Maven parsing, hosting URLs, registry, and storage adapters
src/interfaces/http/  Express server, controllers, and routes
src/config/           Environment-based background scan settings
src/scheduler/        Background scan timing and lifecycle
src/utils/            Console logging
tests/                Node test runner regression tests
```

See the [system reference](../docs/SYSTEM.md) for the as-built architecture and current limitations.
