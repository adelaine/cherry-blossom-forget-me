#!/usr/bin/env bash
set -euo pipefail

bootstrap_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
setup_dir="$(cd -- "$bootstrap_dir/.." && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
nems_dir="${SUITECONTAINER_NEMS_DIR:-$HOME/.codex}"
source "$bootstrap_dir/bootstrap-host.sh"
source "$bootstrap_dir/web-host.sh"

if ! command -v podman >/dev/null 2>&1; then
  bash "$setup_dir/installers/install-podman-codebox.sh"
fi

if reuse_web_app; then exit 0; fi

source "$bootstrap_dir/npm-host.sh"
export SUITECLOUD_PROXY="${SUITECLOUD_PROXY:-http://proxy.eng.netsuite.com:80}"
podman build ${build_secrets[@]+"${build_secrets[@]}"} -f "$setup_dir/Containerfile" --ignorefile "$setup_dir/.containerignore" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true --build-arg SUITECLOUD_PROXY -t suitecloud-workspace "$project_dir"

start_web_app
