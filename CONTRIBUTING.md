# Contributing

For project decisions, merge rules, and releases, see [Governance](GOVERNANCE.md). The current maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md).

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

Before submitting code, start and try the app using the [local Node.js setup in RUNNING.md](RUNNING.md#build-and-run-locally). Stop the app, [set up Chromium for tests](frontend/README.md#running-unit-tests), then run this from the repository root:

```shell
npm run verify
```

This lints, builds, and tests both applications and runs the CI workflow tests. Those tests need `curl`, Git, and Bash (Git Bash on Windows). Documentation-only changes do not require application builds or tests. For optional local CI and workflow details, see the [CI reference](docs/SYSTEM.md#105-continuous-integration).

### Coverage Policy

Verification enforces separate backend and frontend minimums: 80% coverage each for statements, lines, functions, and branches. Add focused tests for the behavior you change. CI uploads coverage reports to the workflow run.

## Maintaining Dependencies

Update the affected manifests and lockfiles together, verify the change, and follow the [dependency audit and install-script guidance](SECURITY.md#dependency-maintenance).

## Project Layout

```text
backend/   TypeScript/Express API, configuration, datastore files, and tests
frontend/  Angular application and tests
docs/      Application usage and design documentation
.github/   GitHub Actions CI, Copilot instructions, skills, and custom agents
```

For component boundaries and current gaps, see the [system reference](docs/SYSTEM.md) and [remaining work](docs/SYSTEM.md#remaining-work).

## Copilot Workflows

For planning approval, documentation checks, and validation rules, see the [Copilot instructions](.github/copilot-instructions.md).
