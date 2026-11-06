# Contributing

Thank you for contributing to Dependency Parser. This guide explains how to propose a change, submit a pull request, and take part in the project.

For installation, local development, containers, and detailed verification commands, see the [running guide](RUNNING.md). For a walkthrough of the application, see the [Express demo](DEMO.md). The [repository overview](README.md), [backend reference](backend/README.md), and [frontend reference](frontend/README.md) provide project and component details.

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

## Verification And CI

Before submitting code, complete the [local setup](RUNNING.md#build-and-run-locally) and [frontend Chromium setup](frontend/README.md#running-unit-tests), then run from the repository root:

```shell
npm run verify
```

This runs lint, CI workflow tests, both production builds, and both application test suites with coverage checks. See the [verification guide](RUNNING.md#verification-and-ci) for individual commands, local CI, coverage minimums, and CI artifacts.

Add focused tests for the behavior you change and follow the [coverage policy](RUNNING.md#coverage-policy). When changing dependencies, follow the [dependency maintenance guidance](RUNNING.md#maintaining-dependencies), including manifest and lockfile updates.

Documentation-only changes do not require application builds or tests.

## Maintainer-Controlled Releases

Release authority, Semantic Versioning, and tag immutability are defined in [governance](GOVERNANCE.md#release-management). This section describes the maintainer procedure.

The semantic tag is separate from the [CI build tag](RUNNING.md#versioned-git-tags-and-image-artifacts) and can point to the same tested commit. For example, a maintainer can release the revision already identified by `main.12`:

```shell
git tag -a 1.4.0 main.12 -m "Release 1.4.0"
git push origin 1.4.0
```

Creating this tag does not currently trigger a release pipeline, publish an image/package, or create a GitHub Release. Manage announcements and distribution separately, and configure repository permissions and tag rulesets according to the [governance enforcement requirements](GOVERNANCE.md#enforcement).

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
