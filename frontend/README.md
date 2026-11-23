# Frontend

The frontend uses Angular 22.2.4 with Angular CLI and the `@angular/build` application builder on 22.2.5. TypeScript remains on the Angular-compatible 6.0 line. See the [development prerequisites](../RUNNING.md#prerequisites) for supported Node.js versions and [dependency maintenance](../SECURITY.md#dependency-maintenance) for security overrides and install-script policy.

For a basic workflow with Tree Builder form examples, tree comparisons, root-version searches, and screenshots, see the [Express demo](../DEMO.md).

## Current screens

Version labels display the selected Git tag for npm SemVer ranges and preserve exact declarations unchanged. Declared/resolved range metadata is retained in API data but not added to the UI labels. If no tag satisfies a range, its declaration remains visible and configured descendants are shown as `unknown`. Range resolutions refresh after a configurable backend TTL; saved browser search results remain snapshots until a new search. See [npm range resolution](../backend/README.md#npm-version-ranges).

Other unavailable source refs preserve their declared labels. Automatic backend scans skip saved partial trees unless a contained npm range resolution expires; explicit tree requests and root-version searches can retry unresolved inspection. See the [backend scan policy](../backend/README.md#background-dependency-scans).

Tag names retain their exact prefixes: `v5.3.0` and `5.3.0` are distinct in version selection, dependency resolution, changelogs, and date metadata. Tree Builder's tag regex matches original names; `v?` explicitly allows both forms but does not make them interchangeable. See the [backend exact-tag contract](../backend/README.md#exact-tag-names).

Navigation tabs are ordered **Dependency Tree**, **Find Root Version**, then **Tree Builder**.

- **Dependency Tree**: `/` redirects to `/tree`; `/tree/:projectId` opens a specific project. Select saved projects, search version lists, and resolve dependency trees through the API. Compare dependencies side by side with changed, added, and removed rows, highlights, and change icons. Changed rows expose an eye-icon **Show changes** action for a [commit changelog](#commit-changes). Filter and expand/collapse the tree, copy versions, and open configured repository links. Project, version, and comparison selections are remembered in browser storage.
- **Tree Builder**: `/builder` creates and edits saved project definitions and nested dependencies. Save, load, update, and delete definitions through the API, keep local drafts in browser storage, and import/export JSON.
- **Find Root Version**: `/find-root-version` scans by tag date from newest to oldest, with numeric tie-breaking, to locate the start of the latest inspectable release run containing a selected configured dependency at or above the minimum version. Dependencies include nested descendants and their versions are compared numerically. The search stops at the first confirmed non-match and does not inspect older trees; if the newest inspectable release does not qualify, it returns no match. This is not a search for the globally oldest historical match. Missing refs and undecidable trees with unknown target/ancestor versions are skipped and logged by the backend; unrelated unknown branches do not block a known result. Results show the matching root version, dependency path, attempted-release count (including skips and the non-match boundary), and full tree with the existing filtering, expand/collapse, copy, and repository-link tools. With scans enabled, the root's populated cached tag catalog is reused; the selected dependency's tags are refreshed for validation before each new search. Requests are cancelled and results cleared when inputs change. No-match and incomplete-search errors are displayed separately, with retry available for failures. See the [backend search contract](../backend/README.md#find-root-version) for date ordering, the skip/error policy, decision logs, and numeric dependency comparison, including labels such as `patch.11` and `fix.12`. Bookmarks must use `/find-root-version`.

Tree Builder restores a saved-project draft only after the project list loads successfully and still contains that project, selecting it in the dropdown. No saved-project tree is shown while the list is loading, if the request fails, or if the project was removed. A failed request shows an error without deleting local edits or the remembered selection; reopening the tab after the server recovers can restore them. New, unsaved project drafts remain available independently of the server.

The dependency tree card contains **Filter packages**, **Expand**, and **Collapse** above the tree, separated by a subtle divider. It has a minimum width of 70% of the available content area, grows to fit its controls, tree, version badges, and row actions, and is centered when narrower than the available content area. Version badges and comparison actions align to the right of the rows, leaving extra space after dependency names. Wider trees scroll horizontally inside the card without clipping names or actions; the filter and buttons remain outside that scroll area. This also applies to embedded Find Root Version results. The project/version selection header keeps its full available width.

**Collapse** closes every node, including the root, leaving only the collapsed root row visible. It also clears an active package filter, because filtering automatically expands branches to reveal matches. Reopening the root does not reopen its descendants; **Expand** reopens the entire tree. This behavior is shared by Dependency Tree, comparisons, and fresh or restored Find Root Version results without changing saved tree data.

Version badges keep a compact single-line layout without inline dates. Hovering the tag label or focusing it with the keyboard opens a popover containing the full tag and creation date/time, with the date formatted in the application locale and 24-hour time (`HH:mm:ss`) converted to GMT (UTC), ending with `GMT` rather than a local offset. The original ISO timestamp is retained in the semantic time element. Moving the pointer off the label closes the popover immediately, including when moving onto the popover or copy button; hovering either of those does not keep it open. Keyboard focus also exposes the details until focus leaves the label. The popover is associated with the label for assistive technology, supports Escape and outside-click dismissal, and remains within the viewport even when the tree scrolls. Each comparison column has its own details. Unavailable dates are labelled **Date unavailable** only inside the popover, and absent versions have no details. Copy still copies only the version string. Dates come from the tree response, with no extra browser requests per dependency; see the [backend timestamp contract](../backend/README.md#dependency-tree-timestamps). Older saved Find Root Version results without dates remain usable and report the unavailable date in their tag popovers until the search is rerun.

Find Root Version displays the matching version, release count, warnings, and dependency path in a summary card. When available, the root version's creation date appears in smaller gray text to the right of the project/version heading, using the same 24-hour GMT format as the tag popovers. It wraps beneath the heading on narrow screens and is omitted when the returned or saved tree has no creation date. Its filter controls and dependency tree occupy a separate centered card below, rather than nesting the tree inside the summary.

**Minimum Dependency Version** must exactly identify an existing active tag accepted by the selected dependency's tag regex, including its `v` prefix or lack of one. On submission, the backend refreshes all matching repository tags, not just versions seen in saved trees, and validates the minimum before inspecting root releases. Missing, differently prefixed, removed, or excluded tags show a validation error rather than a no-match result. Network/authentication failures remain distinct errors, with retry available and the inputs preserved. The loading message covers tag validation and the release search. Background scans also refresh all configured dependency catalogs, including nested ones; see the [backend scan policy](../backend/README.md#background-dependency-scans). Restoring a saved result does not revalidate its tag; start a new search to refresh that snapshot.

Find Root Version keeps its last completed search in browser `localStorage` under `dep-root-version:last-result`. Returning to the tab or reloading restores the selected root, dependency, submitted minimum version, and complete result, including warnings and no-match responses. Restoration loads current project definitions to validate the selection and rebuild repository links, but does not rerun the search or resolve the tree again. The saved result is a snapshot; run another search to refresh it. Changing any search input or starting another search clears both the displayed and saved result. Pending searches and failures are not saved. Malformed saved data or results whose project/dependency is no longer configured are discarded with a notice. Storage access, quota, or clearing failures are reported in the tab and browser console. Search remains usable, and saving failures do not hide the completed result.

Opening either version dropdown highlights and scrolls to its selected tag. Lists render up to 200 options around the selection, including older tags outside the first 200. Typing a search shows the first 200 matching tags; without a selection, the list opens at the first tag.

Find Root Version shows **Warnings (N tags) - View details** when any inspected tag has an unavailable or partial tree, alongside either a match or a no-match result. Clicking it opens a scrollable dialog with one warning group per root tag, the missing-ref cause when the tree is unavailable, and each unresolved dependency's name and version when the tree is partial. Known declared versions are preserved; uninspectable descendants are labelled `unknown`. The native modal supports keyboard focus containment, Escape, and a Close button that returns focus to the warning action. Starting another search or changing inputs clears stale warnings and dismisses the dialog. Authentication, network, configuration, and persistence failures remain errors rather than warnings.

Version lists are persisted by the backend independently of browser storage. Both version pickers show deleted Git tags with `(removed)`; those with saved dependency trees remain selectable for browsing and comparison. Removed tags without a saved tree show `No saved tree` and cannot be selected. The `(latest)` label applies only to active tags. Clearing browser storage resets selections, drafts, and the saved root-version search result, not the backend's tag history.

Selecting a project makes one version-list request. With backend dependency scans enabled, it reads the stored catalog and automatically refreshes Git tags if that version list is empty; with scans disabled, it refreshes the source. Both version dropdowns include **Refresh versions**, which sends `forceRefresh=true` to explicitly refresh the source (currently Git) and update the shared list. The action also works for an empty catalog, is disabled while a request is running, and preserves valid selections. A failed refresh retains the previous list and reports an error. See the [backend API overview](../backend/README.md#api-overview) for the request policy.

All screens use same-origin `/api` requests. During development, Angular forwards `/api/**` to `http://localhost:3000` through [proxy.conf.json](proxy.conf.json), configured in [angular.json](angular.json). If the backend port changes, update the proxy target rather than application source. The [test container](../RUNNING.md#build-and-run-in-a-container) serves the frontend and API together on port 3000, without a development proxy. See the [backend README](../backend/README.md) for API setup and configuration, and the [running guide](../RUNNING.md#build-and-run-locally) for dependency installation and running both applications.

### Commit changes

When comparing two versions, a clickable eye icon appears on every version-changed row, including the root and transitive dependencies. Its hover hint says **Show changes**, and its accessible label identifies the dependency and both versions. The keyboard-operable button uses the same styling as Expand/Collapse in a compact 28px square. Added, removed, and unchanged rows do not have this action. Clicking it loads the selected dependency's commit changelog on demand and opens a modal:

- **Left:** commits present in the baseline version but missing from the comparison version.
- **Right:** commits present in the comparison version but missing from the baseline version.
- If only one version has exclusive commits, only that area is rendered, at full width. Two areas stack in baseline/comparison order on small screens.
- Each area identifies its version and the version missing those commits, shows a count, and lists full commit hashes, titles, and localized committer dates/times. The original ISO timestamp is available on hover over the date. Each commit is a link that opens its commit page in a new tab.
- Tags with the same commit history show **These tags have no commit differences.**

The native modal contains keyboard focus, supports Escape, a red Close button, and clicking outside the card, and restores focus to the invoking button. Only clicks that start and end outside dismiss it; clicking content or padding, or dragging across the card edge, does not. Loading centers the wheel and status text horizontally and vertically in the content area below the header; rotation stops when reduced motion is preferred. The card is up to 76rem wide with a 32rem minimum height, both bounded by the viewport so loading, empty, and error/retry states remain roomy without overflowing small screens. Closing it or changing the displayed tree cancels pending browser requests and discards popup state; changelogs are not saved in browser storage.

The backend caches up to **1,000 comparisons for 24 hours**, including reverse-direction reuse, so reopening a completed comparison avoids Git work. On a cache miss it fetches only the compared tags and extends their isolated history until the complete changelog is known, rather than cloning the whole repository. There is no fixed limit on the number of commits returned; distant or heavily diverged versions may require additional fetches. Failures are retryable and are not cached. The cache is runtime-only and clears when the backend restarts; moved tags may show the previous comparison until expiry or eviction. See the [backend cache policy](../backend/README.md#commit-changelogs).

The API uses Git history rather than version-number ordering, so either comparison direction works. A cache miss needs repository access even when trees came from saved snapshots, and an unavailable uncached tag produces an error rather than a fabricated empty changelog. The backend automatically builds commit links for GitHub, GitLab.com, Bitbucket Cloud, and Bitbucket Server/Data Center on `bitbucket.<suffix>` hosts; there is no provider selector or hosting-provider API call. Hosts outside these rules produce an explicit error instead of a guessed link. See the [recognized hosts and clone/browser URL distinction](../backend/README.md#repository-browser-links) and the [backend changelog contract](../backend/README.md#commit-changelogs) for details.

## Development server

See [RUNNING.md](../RUNNING.md#build-and-run-locally) for startup commands. The frontend reloads after source changes and needs the backend for API requests. Restart the development server after editing the proxy configuration.

## Code scaffolding

From `frontend/`, use the `ng` npm script to access Angular CLI scaffolding tools. To generate a new component, run:

```bash
npm run ng -- generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
npm run ng -- generate --help
```

## Building

To build the project run:

```bash
npm run build
```

This will compile your project and store the browser build in `dist/frontend/browser/`. By default, the production build optimizes your application for performance and speed. To serve it with the API rather than Angular's development server, use the backend's [frontend hosting configuration](../backend/README.md#frontend-hosting-and-docker) or the combined Docker image.

Hosting and release pipelines are [operator-managed](../RUNNING.md#deployment-responsibilities).

Production builds warn when a component stylesheet exceeds 14 kB and fail above 16 kB. These budgets are configured in [angular.json](angular.json).

## Linting and verification

ESLint checks frontend TypeScript, unit tests, Angular templates, and the Vitest configuration using the [shared root configuration](../eslint.config.cjs). Install the root development dependencies as well as frontend dependencies before linting.

```bash
npm run lint
npm run lint:fix
```

Warnings fail the check. The fix command applies supported automatic corrections and reports anything that still needs a manual fix.

After provisioning Chromium as described below, `npm run verify` runs lint, a production build, and one non-watching test pass with coverage enforcement. See [repository verification](../CONTRIBUTING.md#verification-and-ci) for checks covering both applications and CI.

## Running unit tests

Unit tests use Vitest with Playwright in real headless Chromium, including tests that depend on layout, keyboard focus, and clipboard behavior. Install Chromium once after installing npm dependencies:

```bash
npm exec -- playwright install chromium
```

Then run a single test pass:

```bash
npm run test:ci
```

For interactive watch mode, use `npm test -- --watch`. To use an already installed Chrome instead of Playwright's Chromium, set `CHROME_BIN` to its executable path. Browser provisioning may require network access on a new machine or CI worker.

The [Vitest base configuration](vitest-base.config.mts) binds its browser test server to loopback on port 4201, outside Windows' reserved dynamic-port ranges. This does not change the development server's port 4200. Node type definitions are development dependencies for the typed runner configuration.

Tests cover navigation, Dependency Tree, commit changelogs (compact action styling, desktop/mobile loading alignment, localized dates, keyboard focus and Escape, links, errors/retry, and request cancellation), Tree Builder, Find Root Version, and tree model behavior. Keep `.spec.ts` files beside their implementation. Tree Builder tests cover CRUD, recursive validation, independent drafts, import/export, immutable tree edits, and focus; HTTP requests are intercepted with Angular's HTTP testing utilities.

### Test Coverage

Collect coverage and enforce the shared [coverage policy](../CONTRIBUTING.md#coverage-policy):

```bash
npm run test:coverage
```

[Angular configuration](angular.json) includes all application TypeScript sources, including untested files, while excluding specs and declaration files. Reports are written to `coverage/frontend/`: open `coverage/frontend/index.html`, or use `lcov.info`, `coverage-final.json`, and `coverage-summary.json` in that directory for tooling. Generated reports and Vitest failure screenshots are ignored by Git. Ordinary `npm run test:ci` and watch-mode tests remain available without coverage enforcement.

## Available scripts

| Command | Description |
| --- | --- |
| `npm run build` | Create a production build. |
| `npm run lint` | Check frontend TypeScript, Angular templates, and Vitest configuration; requires root development dependencies. |
| `npm run lint:fix` | Apply automatically fixable frontend lint corrections. |
| `npm run watch` | Rebuild continuously using the development configuration. |
| `npm test` | Run Angular unit tests with Vitest and headless Chromium. |
| `npm run test:ci` | Run the same unit tests once with watch mode disabled. |
| `npm run test:coverage` | Run tests once, generate coverage reports, and enforce the shared coverage minimums. |
| `npm run verify` | Run lint, build, and a non-watching frontend test pass with coverage enforcement. |

## Running end-to-end tests

No dedicated end-to-end target or npm script is configured. Use `npm run test:ci` for the [browser-based unit tests](#running-unit-tests); these do not replace full end-to-end tests.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
