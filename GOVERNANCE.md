# Governance

## Project decisions

Project decisions, including features, architecture, and breaking changes, are discussed openly through GitHub Issues and Pull Requests. [Maintainers](MAINTAINERS.md) have final responsibility for accepting changes and resolving disagreements.

Security vulnerabilities are an exception to public discussion: follow the private reporting instructions in the [security policy](SECURITY.md).

## Commit access

Write access to project code is limited to maintainers. Anyone can contribute without repository write access by using a fork and pull request.

Fork this repository into your GitHub account, then create a working branch in your fork and make your changes there. Open a pull request with the **original repository** as the base repository, **`main`** as the base branch, and your fork's working branch as the head/source branch. Follow the [contribution guide](CONTRIBUTING.md#github-contribution-rules) for the issue-first process, verification, and review steps.

Changes to the default/mainline branch, `main`, must go through pull requests with at least one maintainer approval and successful required CI checks before merging. Direct pushes are not permitted.

## Release management

Human maintainers decide when a verified mainline revision is ready and create an unused Semantic Versioning tag, `MAJOR.MINOR.PATCH`, such as `1.4.0`. MAJOR denotes breaking changes, MINOR backward-compatible features, and PATCH backward-compatible fixes.

Automated `main.<N>` mainline tags and `main.<N>-pr<PR-number>.<build-sequence>` PR tags identify tested CI snapshots, not official releases. See the [CI build-tag conventions](docs/SYSTEM.md#versioned-git-tags-and-image-artifacts).

Published build and release tags must not be moved or repurposed. Merging a pull request does not create an official release, and CI does not choose semantic release versions.

For example, to release the verified mainline revision tagged `main.12`:

```shell
git tag -a 1.4.0 main.12 -m "Release 1.4.0"
git push origin 1.4.0
```

No tag-triggered release publishing workflow is currently configured. Maintainers manage release announcements and distribution separately. Official releases do not establish separately maintained security-fix lines; see [supported versions](SECURITY.md#supported-versions).

## Enforcement

Maintainers must configure GitHub permissions and branch rulesets to restrict write access, require pull requests, at least one maintainer approval and successful required CI checks, and prevent direct pushes to the default branch, `main`. Tag rulesets must reserve semantic release-tag creation for maintainers while allowing the isolated CI tag job to create `main.*` build tags.

These are project policies. This document does not configure or verify GitHub permissions, branch protections, or tag rulesets; those settings are managed separately in GitHub.
