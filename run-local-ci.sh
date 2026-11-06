#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .github/workflows/ci.yml ]]; then
    printf '%s\n' 'Run this script from the dependency-parser repository root.' >&2
    exit 1
fi

host_os="$(uname -s)"
case "$host_os" in
    Linux) platform=linux ;;
    MINGW*|MSYS*|CYGWIN*) platform=windows ;;
    *)
        printf 'Unsupported operating system: %s. Use Windows (Git Bash) or Linux.\n' "$host_os" >&2
        exit 1
        ;;
esac

select_engine() {
    local key prefix
    engine=docker
    printf '%s\n' 'Container engine (Up/Down to choose, Enter to confirm):'
    while true; do
        if [[ "$engine" == docker ]]; then
            printf '\r\033[K> Docker\n\r\033[K  Podman\n'
        else
            printf '\r\033[K  Docker\n\r\033[K> Podman\n'
        fi

        if ! IFS= read -rsn1 key; then
            printf '%s\n' 'No selection received. Use Up/Down and Enter to choose Docker or Podman.' >&2
            return 1
        fi
        case "$key" in
            ''|$'\r') return 0 ;;
            $'\e')
                if IFS= read -rsn1 -t 1 prefix && [[ "$prefix" == '[' || "$prefix" == O ]] &&
                    IFS= read -rsn1 -t 1 key; then
                    case "$key" in
                        A|B)
                            if [[ "$engine" == docker ]]; then
                                engine=podman
                            else
                                engine=docker
                            fi
                            ;;
                    esac
                fi
                ;;
        esac
        printf '\033[2A'
    done
}

if [[ -t 0 && -t 1 && "${TERM:-dumb}" != dumb ]]; then
    select_engine
else
    printf 'Container engine [docker/podman] (default: docker): '
    if ! IFS= read -r engine; then
        printf '%s\n' 'No selection received. Enter docker or podman, or press Enter for Docker.' >&2
        exit 1
    fi
fi

case "$engine" in
    ''|[Dd][Oo][Cc][Kk][Ee][Rr]) engine=docker ;;
    [Pp][Oo][Dd][Mm][Aa][Nn]) engine=podman ;;
    *)
        printf 'Invalid container engine: %s. Choose docker or podman.\n' "$engine" >&2
        exit 1
        ;;
esac

if ! command -v "$engine" >/dev/null 2>&1; then
    printf '%s is not on PATH. Install it and open a new terminal.\n' "$engine" >&2
    exit 1
fi

if command -v act >/dev/null 2>&1; then
    act_bin=act
else
    act_bin=''
    if [[ "$platform" == windows ]] && command -v cygpath >/dev/null 2>&1 && [[ -n "${LOCALAPPDATA:-}" ]]; then
        act_bin="$(cygpath -u "$LOCALAPPDATA")/Microsoft/WinGet/Packages/nektos.act_Microsoft.Winget.Source_8wekyb3d8bbwe/act.exe"
    fi
    if [[ -z "$act_bin" || ! -x "$act_bin" ]]; then
        if [[ "$platform" == windows ]]; then
            printf '%s\n' 'act was not found. Install it with: winget install --id nektos.act --exact' >&2
        else
            printf '%s\n' 'act was not found. Install it on PATH using https://nektosact.com/installation/' >&2
        fi
        exit 1
    fi
fi

if [[ "$platform" == windows ]]; then
    export MSYS_NO_PATHCONV=1
fi
engine_env=()
case "$engine" in
    docker)
        # Do not reuse a Podman endpoint inherited from an earlier run.
        unset DOCKER_HOST
        if ! docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" || [[ -z "$docker_host" ]]; then
            printf '%s\n' 'Cannot resolve the current Docker context endpoint.' >&2
            exit 1
        fi
        export DOCKER_HOST="$docker_host"
        container_socket="${docker_host#unix://}"
        if [[ "$docker_host" != unix://* ]]; then
            container_socket=/var/run/docker.sock
        fi
        if ! docker_os="$(docker info --format '{{.OSType}}')"; then
            printf '%s\n' 'Docker is unavailable. Start Docker and check its current context.' >&2
            exit 1
        fi
        if [[ "$docker_os" != linux ]]; then
            printf '%s\n' 'Docker must be configured to use Linux containers.' >&2
            exit 1
        fi
        runner_image=docker.io/catthehacker/ubuntu:act-latest
        pull_image=true
        ;;
    podman)
        if [[ "$platform" == windows ]]; then
            machine=podman-machine-default
            if ! state="$(podman machine inspect "$machine" --format '{{.State}}')"; then
                printf 'Cannot inspect Podman machine %s. Initialize it before running CI.\n' "$machine" >&2
                exit 1
            fi
            if [[ "$state" != running ]]; then
                if ! podman machine start "$machine"; then
                    printf 'Could not start Podman machine %s.\n' "$machine" >&2
                    exit 1
                fi
            fi

        fi
        if ! podman_socket="$(podman info --format '{{.Host.RemoteSocket.Path}}')"; then
            printf '%s\n' 'Podman is unavailable. Check your Podman installation and connection.' >&2
            exit 1
        fi
        container_socket="${podman_socket#unix://}"
        if [[ "$container_socket" != /* ]]; then
            printf '%s\n' 'Cannot resolve the Podman API socket path inside the container host.' >&2
            exit 1
        fi
        if [[ "$platform" == windows ]]; then
            export DOCKER_HOST="npipe:////./pipe/$machine"
        else
            podman_socket="$container_socket"
            export DOCKER_HOST="unix://$podman_socket"
            if ! podman --remote --url "$DOCKER_HOST" info >/dev/null; then
                printf 'Cannot connect to the Podman API at %s.\n' "$DOCKER_HOST" >&2
                printf '%s\n' 'Start it with "systemctl --user start podman.socket" (rootless) or "sudo systemctl start podman.socket" (rootful).' >&2
                printf '%s\n' 'Without systemd, run "podman system service --time=0" in another terminal, then retry.' >&2
                exit 1
            fi
        fi
        runner_image=localhost/dependency-parser-act-podman:local
        runner_network=podman
        engine_env=(--env DOCKER_BUILDKIT=0)
        if ! podman image exists "$runner_image"; then
            printf 'The previously built Podman-compatible runner image is unavailable: %s\n' "$runner_image" >&2
            exit 1
        fi
        pull_image=false
        ;;
esac

if ! branch="$(git symbolic-ref --quiet --short HEAD)" || [[ -z "$branch" ]]; then
    printf '%s\n' 'Check out a branch before running local CI; detached HEAD is not supported.' >&2
    exit 1
fi

local_run_id="local-$(date +%s)-$$"
network_created=false
event_file="$(mktemp)"
cleanup() {
    local status=$?
    if ! rm -f -- "$event_file"; then
        if [[ "$status" == 0 ]]; then status=1; fi
    fi
    if [[ "$network_created" == true ]] && ! docker network rm "$runner_network" >/dev/null; then
        printf 'Could not remove local CI Docker network %s. Remove it once its containers have stopped.\n' "$runner_network" >&2
        if [[ "$status" == 0 ]]; then status=1; fi
    fi
    exit "$status"
}
trap cleanup EXIT
# Simulate a default-branch dispatch without changing hosted workflow conditions.
branch_json="${branch//\"/\\\"}"
printf '{"ref":"refs/heads/%s","repository":{"default_branch":"%s"},"local_ci_run_id":"%s"}\n' \
    "$branch_json" "$branch_json" "$local_run_id" > "$event_file"
event_path="$event_file"
if [[ "$platform" == windows ]]; then
    event_path="$(cygpath -w "$event_file")"
fi

if [[ "$engine" == docker ]]; then
    runner_network="dependency-parser-ci-$local_run_id"
    if ! docker network create --driver bridge "$runner_network" >/dev/null; then
        printf 'Cannot create local CI Docker network %s.\n' "$runner_network" >&2
        exit 1
    fi
    network_created=true
fi

printf '%s\n' 'Running verification, image build/smoke/export, and a Git-tag dry run. GitHub uploads and remote tag creation are disabled.'

"$act_bin" workflow_dispatch \
    --workflows .github/workflows/ci.yml \
    --eventpath "$event_path" \
    --defaultbranch "$branch" \
    --platform "ubuntu-latest=$runner_image" \
    --container-daemon-socket "$container_socket" \
    --env ACT=true \
    --env DOCKER_HOST=unix:///var/run/docker.sock \
    "${engine_env[@]}" \
    --network "$runner_network" \
    --pull="$pull_image" \
    --rm
