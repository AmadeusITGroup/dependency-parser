<p align="center">
  <img src="frontend/public/dependency-tree.svg" alt="Dependency Parser logo" width="112" height="112">
</p>

<h1 align="center">Dependency Parser</h1>

<p align="center">Understand dependency changes across project releases.</p>

## What Is It For?

Dependency Parser helps teams trace how their projects depend on one another across Git-tagged releases. Define the repositories and dependency links you care about, inspect direct and transitive dependencies, and understand which parent releases contain a dependency update.

- **Define project relationships** with Tree Builder, using npm or Maven manifests.
- **Browse dependency trees** for a selected release, including nested dependencies.
- **Resolve npm version ranges** to compatible Git tags with a configurable cache lifetime; see [npm range resolution](backend/README.md#npm-version-ranges).
- **Compare releases side by side** to identify changed, added, and removed dependencies.
- **Inspect Git commit changelogs** for the root project or a changed dependency.
- **Find Root Version** to locate the start of the latest release run containing a dependency at or above a requested version.
- **Keep project definitions and dependency history** with JSON or optional MongoDB persistence and background scans.

The application combines an Angular frontend with a TypeScript/Express backend that inspects the configured projects' Git repositories.

## How To Use

Follow the [usage how-to](HOWTO.md) for a step-by-step walkthrough: define a project tree, browse and compare releases, inspect commit changes, and find the parent release containing a dependency update.

## Contribute, Develop, Or Run

Dependency Parser is an open-source, self-hosted tool. We provide basic build, run, and container tooling; operators own their environment, deployment pipeline, and persistence. See [deployment responsibilities](CONTRIBUTING.md#deployment-responsibilities).

See [CONTRIBUTING.md](CONTRIBUTING.md) for GitHub contribution rules, the issue template, local Node.js setup, Docker and Podman commands, token input, verification, and versioned CI image artifacts.

For environment variables, follow the centralized [backend environment setup](backend/README.md#environment-setup), including local file creation, shell overrides, credentials, and the complete variable reference.

Local verification and CI enforce independent backend and frontend [test coverage minimums](CONTRIBUTING.md#coverage-policy), with downloadable coverage reports in CI.

See [GOVERNANCE.md](GOVERNANCE.md) for project decisions, commit access, merge requirements, and release management. The current project maintainers are listed in [MAINTAINERS.md](MAINTAINERS.md).

Development targets the `main` branch. CI build tags use the `main.` prefix and identify tested snapshots; human maintainers choose official Semantic Versioning release tags. See the [build-tag conventions](CONTRIBUTING.md#versioned-git-tags-and-image-artifacts) and [release policy](GOVERNANCE.md#release-management).

For security vulnerabilities, follow the private reporting instructions in [SECURITY.md](SECURITY.md); do not open a public issue or pull request.

## Technical Documentation

| Document | Contents |
| --- | --- |
| [Backend reference](backend/README.md) | API contracts, npm/Maven parsing, persistence, scans, logging, configuration, and container runtime details. |
| [Frontend reference](frontend/README.md) | Screen behavior, browser state, and Angular development commands. |
| [High-level design](docs/HLD.md) | As-built architecture, component interactions, and deployment considerations. |
| [Remaining work](docs/HLD.md#remaining-work) | Current gaps and follow-up improvements. |
