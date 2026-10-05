#!/usr/bin/env bash
set -euo pipefail

bootstrap_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
setup_dir="$(cd -- "$bootstrap_dir/.." && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
nems_dir="${SUITECONTAINER_NEMS_DIR:-$HOME/.codex}"
source "$bootstrap_dir/bootstrap-host.sh"
source "$bootstrap_dir/web-host.sh"
export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:$PATH"

if ! command -v podman >/dev/null 2>&1; then
  export PATH="/opt/podman/bin:$PATH"
fi
if ! command -v podman >/dev/null 2>&1; then
  bash "$setup_dir/installers/install-podman-macos.sh"
fi
machines="$(podman machine list --format '{{.Name}}')"
if [[ -z "$machines" ]]; then
  podman machine init --now
elif [[ "$(podman machine list --format '{{.Running}}')" != *true* ]]; then
  podman machine start
fi

if reuse_web_app; then exit 0; fi

if podman image exists suitecloud-workspace; then
  start_web_app
  exit 0
fi
if [[ "$pm_mode" == true ]]; then
  echo 'Load the shared suitecloud-workspace image with podman load -i <archive-path>, then run the launcher again.' >&2
  exit 1
fi

echo 'Preparing the SuiteCloud container...'
# Make the host npm credentials available only during dependency installation.
npmrc_file="${SUITECONTAINER_NPMRC:-${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-$HOME/.npmrc}}}"
build_secrets=()
if [[ -f "$npmrc_file" ]]; then
  build_secrets+=(--secret "id=npmrc,src=$npmrc_file")
  if [[ -n "${NSX_NPM_TOKEN:-}" ]]; then
    build_secrets+=(--secret "id=npm-token,env=NSX_NPM_TOKEN,type=env")
  fi
fi
if ! podman build ${build_secrets[@]+"${build_secrets[@]}"} -f "$setup_dir/Containerfile" --ignorefile "$setup_dir/.containerignore" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace "$project_dir"; then
  echo 'The container build failed.' >&2
  exit 1
fi

start_web_app
