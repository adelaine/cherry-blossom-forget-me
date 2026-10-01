#!/usr/bin/env bash
set -euo pipefail

setup_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
nems_dir="${SUITECONTAINER_NEMS_DIR:-$HOME/.codex}"
source "$setup_dir/bootstrap-host.sh"
source "$setup_dir/web-host.sh"

if ! command -v podman >/dev/null 2>&1; then
  bash "$setup_dir/install-podman-codebox.sh"
fi

if reuse_web_app; then exit 0; fi

# Make the host npm credentials available only during dependency installation.
npmrc_file="${SUITECONTAINER_NPMRC:-${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-$HOME/.npmrc}}}"
build_secrets=()
if [[ -f "$npmrc_file" ]]; then
  build_secrets+=(--secret "id=npmrc,src=$npmrc_file")
  if [[ -n "${NSX_NPM_TOKEN:-}" ]]; then
    build_secrets+=(--secret "id=npm-token,env=NSX_NPM_TOKEN,type=env")
  fi
fi
export SUITECLOUD_PROXY="${SUITECLOUD_PROXY:-http://proxy.eng.netsuite.com:80}"
podman build ${build_secrets[@]+"${build_secrets[@]}"} -f "$setup_dir/Containerfile" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true --build-arg SUITECLOUD_PROXY -t suitecloud-workspace "$setup_dir"

start_web_app
