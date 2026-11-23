# Running Dependency Parser

Choose [local Node.js](#build-and-run-locally) or [Docker/Podman](#build-and-run-in-a-container). Once the app is running, try the [Express demo](DEMO.md).

## Build And Run Locally

### Prerequisites

- **Node.js:** 24.15.0+ on the 24.x line is recommended. The [supported alternatives](package.json) are 22.22.3+ on the 22.x line, or 26+.
- **npm:** 10 or later.
- **Git:** 2.29 or later for repository inspection and adaptive commit comparisons; optional GitHub token authentication requires 2.31+. Git 2.45+ is recommended for selective tag discovery.

### Install Dependencies

After cloning, install all three packages from the repository root:

```shell
npm ci
npm --prefix backend ci
npm --prefix frontend ci
```

### Start Both Applications

[Configure the backend](backend/README.md#environment-setup) with `DATASTORE=json` for local persistence without MongoDB. Then run from the repository root:

```shell
npm start
```

This starts the backend watcher and builds and serves the frontend. Open [http://localhost:4200](http://localhost:4200); the [backend health endpoint](http://localhost:3000/api/health) should return `{"status":"ok"}`. Press Ctrl+C to stop both.

### Run Components Separately (Optional)

As an alternative to the combined launcher, use the same dependencies and backend settings. From the repository root, start one backend mode, then start the frontend in another terminal:

| Component | Commands |
| --- | --- |
| Backend with automatic restart | `npm --prefix backend run dev` |
| Compiled backend | `npm --prefix backend run build`, then `npm --prefix backend start` |
| Frontend development server | `npm --prefix frontend run build`, then `npm --prefix frontend start` |

## Build And Run In A Container

Choose one Linux-container engine and run its commands from the repository root. The image includes both applications and uses port **3000**; stop any local backend using that port first. JSON data is saved in the `dependency-parser-data` volume. For private repositories, see [optional token input](#optional-github-token-input).

### Docker

Start Docker Engine or Docker Desktop with Linux containers enabled, then:

```shell
docker build --tag dependency-parser:local .
docker run --detach --pull=never --name dependency-parser --publish 127.0.0.1:3000:3000 --volume dependency-parser-data:/app/backend/data dependency-parser:local
```

### Podman

On Windows or macOS, create the Podman machine with `podman machine init` if needed, and start it with `podman machine start` if stopped.

```shell
podman build --tag localhost/dependency-parser:local .
podman run --detach --pull=never --name dependency-parser --publish 127.0.0.1:3000:3000 --volume dependency-parser-data:/app/backend/data localhost/dependency-parser:local
```

### Check, Stop, And Restart

Open [http://localhost:3000](http://localhost:3000). The [API health endpoint](http://localhost:3000/api/health) should return `{"status":"ok"}`.

| Action | Docker | Podman |
| --- | --- | --- |
| Read logs | `docker logs dependency-parser` | `podman logs dependency-parser` |
| Stop | `docker stop dependency-parser` | `podman stop dependency-parser` |
| Start the existing container | `docker start dependency-parser` | `podman start dependency-parser` |

To change the image or token, stop and remove the container (`docker rm dependency-parser` or `podman rm dependency-parser`), then repeat the run command. Keep the named volume to preserve data.

### Optional GitHub Token Input

For private GitHub repositories, create a dedicated `.env` in the repository root:

```dotenv
GITHUB_TOKEN=replace-with-your-read-only-token
```

Add `--env-file .env` before the image name in the run command. Keep this file private; do not commit it or reuse the backend dotenv file, which can contain inline comments that container engines do not parse. Use HTTPS URLs and a token with [read access to each required repository](backend/README.md#github-token-authentication).

### Loading A CI Image

Download and unzip the image artifact from a successful `main` or pull-request Actions run. Load the archive with `docker load --input dependency-parser-main.12.tar.gz` (or `podman load --input dependency-parser-main.12.tar.gz`), substituting the actual file name. Skip the build and use the tag printed by the load command in place of the example image name in the run command. Artifacts expire after 14 days.

## Deployment Responsibilities

The examples are for local use: the API has no user authentication, and `GITHUB_TOKEN` only grants backend repository access. Operators own access controls, TLS, secrets, deployment, backups, and optional MongoDB. Review the [deployment limitations](docs/SYSTEM.md#104-gaps-to-close-before-a-shared-or-production-deployment) before shared or production use.
