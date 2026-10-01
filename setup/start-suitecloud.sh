#!/usr/bin/env bash
set -euo pipefail

setup_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
nems_dir="${SUITECONTAINER_NEMS_DIR:-$HOME/.codex}"

if ! command -v podman >/dev/null 2>&1; then
  export PATH="/opt/podman/bin:$PATH"
fi
if ! command -v podman >/dev/null 2>&1; then
  bash "$setup_dir/install-podman-macos.sh"
fi
machines="$(podman machine list --format '{{.Name}}')"
if [[ -z "$machines" ]]; then
  podman machine init --now
elif [[ "$(podman machine list --format '{{.Running}}')" != *true* ]]; then
  podman machine start
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
if ! podman build "${build_secrets[@]}" -f "$setup_dir/Containerfile" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace "$setup_dir"; then
  echo 'The container build failed.' >&2
  exit 1
fi

prepare_status=0
podman run --rm --cgroups=disabled \
  --mount "type=bind,src=$project_dir,dst=/project" \
  suitecloud-workspace --prepare-launch || prepare_status=$?
if [[ "$prepare_status" -eq 10 ]]; then
  exit 0
fi
if [[ "$prepare_status" -ne 0 ]]; then
  exit "$prepare_status"
fi

launch_mounts="$(podman run --rm --cgroups=disabled \
  --mount "type=bind,src=$project_dir,dst=/project,ro=true" \
  --env "SUITECONTAINER_HOST_ROOT=$project_dir" \
  --env "SUITECONTAINER_HOST_PLATFORM=linux" \
  suitecloud-workspace --launch-mounts)"
mounts=()
while IFS= read -r mount; do
  [[ -n "$mount" ]] || continue
  mounts+=(--mount "$mount")
done <<< "$launch_mounts"

for name in .nems.env config.toml; do
  file="$nems_dir/$name"
  if [[ -f "$file" ]]; then
    mounts+=(--mount "type=bind,src=$file,dst=/config/$name,ro=true")
  fi
done

if ! podman run --rm -it --cgroups=disabled "${mounts[@]}" suitecloud-workspace --deploy; then
  echo 'The container stopped with an error.' >&2
  exit 1
fi
