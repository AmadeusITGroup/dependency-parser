# Security Policy

Dependency Parser is an open-source, self-hosted application with an Angular frontend and a TypeScript/Express backend that inspects Git repositories and npm/Maven manifests.

## Supported versions

Security fixes target the current `main` branch. Automated `main.<N>` mainline tags, `main.<N>-pr<PR-number>.<build-sequence>` PR tags, and downloadable Docker images identify CI snapshots, not official releases or separately maintained security-fix lines.

Human maintainers choose official `MAJOR.MINOR.PATCH` release tags from verified mainline revisions under the [release policy](GOVERNANCE.md#release-management). An official release does not establish a backport or long-term-support commitment.

| Version | Supported |
| --- | --- |
| `main` / current mainline, including tags pointing to that revision | Yes |
| Older revisions, including official release tags, CI tags and container images | No |
| Other branches and forks | No |

Operators are responsible for updating or rebuilding their self-hosted deployments to include security fixes.

## Reporting a vulnerability

Please do **not** report security vulnerabilities through public GitHub issues or pull requests.

Report them privately to **[opensource@amadeus.com](mailto:opensource@amadeus.com)** with:

- the project repository reference
- a description of the issue;
- the affected commit, Git tag or container image revision;
- the affected component, API endpoint, file, dependency or workflow;
- reproduction steps or a proof of concept;
- the potential impact; and
- any suggested mitigation.

Relevant reports may include cross-site scripting or unsafe input handling, unsafe Git invocation or repository access, npm/Maven manifest parsing issues, exposure of credentials or stored repository data, resource exhaustion during dependency resolution or background scans, dependency vulnerabilities, or compromised CI and container builds.

Redact credentials and unrelated private data from reproduction material and logs.

The private mailbox above is the reporting route for this project.

## What to expect

The initial project target is to acknowledge a report within five business days and communicate next steps as soon as practical. This is a proposed repository target, not a service-level agreement. Response and disclosure timing will depend on severity, affected systems and coordination requirements.

Please allow the maintainers to investigate and coordinate a fix before public disclosure.

## Security practices

- Keep npm dependencies, Node.js, Git, container base images and GitHub Actions updated. Follow the [dependency maintenance guidance](RUNNING.md#maintaining-dependencies), including lockfile updates and audits of all three npm packages.
- Do not commit secrets, private data, confidential repository contents or internal documents. Keep `.env`, `.env.*`, local datastore and clone-cache directories, and temporary files out of public commits and build artifacts. Sanitized `.env.example` templates may be committed.
- Inject credentials at runtime, keep repository tokens backend-only and minimally scoped, and never put them in frontend code, repository URLs or container images.
- Review handling of repository URLs, Git refs, regular expressions, npm/Maven manifests and imported project JSON, as well as frontend rendering of repository-derived data.
- Require review for changes to GitHub Actions workflows, the Dockerfile, npm manifests and lockfiles, backend Git and credential handling, API input validation, and frontend rendering.
- Keep published build and release tags immutable. Reserve semantic release-tag creation for maintainers through repository permissions and tag rulesets; the CI workflow creates only `main.*` build tags. See the [build-tag policy](RUNNING.md#versioned-git-tags-and-image-artifacts).

Build/test jobs have read-only repository contents access. Only the isolated tag-only job has `contents: write`, and it never checks out or executes project code. Fork PRs receive image artifacts but cannot write Git tags. A passing build or an official release tag is not a security certification.

The API currently has no user authentication or authorization. Optional `GITHUB_TOKEN` authentication grants the backend access to GitHub repositories; it does not protect the API or sign users in. Do not expose an unprotected instance to untrusted networks.

Operators must secure network access, TLS, persistent JSON files or MongoDB, and cloned repository data. See [deployment responsibilities](RUNNING.md#deployment-responsibilities) and the [shared/production deployment gaps](docs/HLD.md#104-gaps-to-close-before-a-shared-or-production-deployment).
