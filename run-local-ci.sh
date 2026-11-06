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
case "$engine" in
    docker)
        # Do not reuse a Podman endpoint inherited from an earlier run.
        unset DOCKER_HOST
        if ! docker_host="$(docker context inspect --format '{{.Endpoints.docker.Host}}')" || [[ -z "$docker_host" ]]; then
            printf '%s\n' 'Cannot resolve the current Docker context endpoint.' >&2
            exit 1
        fi
        export DOCKER_HOST="$docker_host"
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

            if ! podman info >/dev/null; then
                printf '%s\n' 'Podman is unavailable. Check the Podman machine connection.' >&2
                exit 1
            fi
            export DOCKER_HOST="npipe:////./pipe/$machine"
        else
            if ! podman_socket="$(podman info --format '{{.Host.RemoteSocket.Path}}')"; then
                printf '%s\n' 'Podman is unavailable. Check your local Podman installation and permissions.' >&2
                exit 1
            fi
            if [[ "$podman_socket" != /* ]]; then
                printf '%s\n' 'Cannot resolve the native Podman API socket path.' >&2
                exit 1
            fi
            export DOCKER_HOST="unix://$podman_socket"
            if ! podman --remote --url "$DOCKER_HOST" info >/dev/null; then
                printf 'Cannot connect to the Podman API at %s.\n' "$DOCKER_HOST" >&2
                printf '%s\n' 'Start it with "systemctl --user start podman.socket" (rootless) or "sudo systemctl start podman.socket" (rootful).' >&2
                printf '%s\n' 'Without systemd, run "podman system service --time=0" in another terminal, then retry.' >&2
                exit 1
            fi
        fi
        runner_image=localhost/dependency-parser-act-podman:local
        if ! podman image exists "$runner_image"; then
            printf 'The previously built Podman-compatible runner image is unavailable: %s\n' "$runner_image" >&2
            exit 1
        fi
        pull_image=false
        ;;
esac

exec "$act_bin" workflow_dispatch \
    --workflows .github/workflows/ci.yml \
    --job verify \
    --platform "ubuntu-latest=$runner_image" \
    --container-daemon-socket - \
    --pull="$pull_image" \
    --rm
