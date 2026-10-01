#!/usr/bin/env bash
set -euo pipefail

setup_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
config_file="$project_dir/suitecontainer.config.json"
repos_dir="$project_dir/repos"
nems_dir="${SUITECONTAINER_NEMS_DIR:-$HOME/.codex}"

config_status=0
bash "$setup_dir/prepare-config.sh" "$project_dir" || config_status=$?
if [[ "$config_status" -eq 10 ]]; then
  exit 0
fi
if [[ "$config_status" -ne 0 ]]; then
  exit "$config_status"
fi
if ! command -v podman >/dev/null 2>&1; then
  export PATH="/opt/podman/bin:$PATH"
fi
if ! command -v podman >/dev/null 2>&1; then
  bash "$setup_dir/install-podman-macos.sh"
fi
if ! podman info >/dev/null 2>&1; then
  if [[ -z "$(podman machine list --format '{{.Name}}')" ]]; then
    podman machine init
  fi
  podman machine start
fi

mkdir -p "$repos_dir"


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

validation_output="$(podman run --rm \
  --mount "type=bind,src=$project_dir/credentials,dst=/config/credentials,ro=true" \
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json,ro=true" \
  suitecloud-workspace --validate /config/suitecontainer.config.json)"
echo "$validation_output"
if [[ "$validation_output" == 'There are no SuiteApps to install in suitecontainer.config.json.' ]]; then
  exit 0
fi

certificate_status=0
podman run --rm \
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json" \
  --mount "type=bind,src=$project_dir/credentials,dst=/config/credentials" \
  suitecloud-workspace --prepare-certificates || certificate_status=$?
if [[ "$certificate_status" -eq 10 ]]; then
  exit 0
fi
if [[ "$certificate_status" -ne 0 ]]; then
  exit "$certificate_status"
fi

certificate_paths="$(podman run --rm \
  --mount "type=bind,src=$project_dir/credentials,dst=/config/credentials,ro=true" \
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json,ro=true" \
  suitecloud-workspace --certificate-paths)"
public_certificate="${certificate_paths%%$'\n'*}"
private_certificate="${certificate_paths#*$'\n'}"
[[ "$public_certificate" == /* ]] || public_certificate="$project_dir/$public_certificate"
[[ "$private_certificate" == /* ]] || private_certificate="$project_dir/$private_certificate"
if [[ ! -f "$public_certificate" || ! -f "$private_certificate" ]]; then
  echo 'Certificate files were not found. Update their paths in credentials/auth.json and run start-macos.sh again.' >&2
  exit 1
fi

mounts=(
  --mount "type=bind,src=$project_dir/credentials/auth.json,dst=/config/credentials/auth.json,ro=true"
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json"
  --mount "type=bind,src=$repos_dir,dst=/workspace"
  --mount "type=bind,src=$public_certificate,dst=/config/certs/public.pem,ro=true"
  --mount "type=bind,src=$private_certificate,dst=/config/certs/private.pem,ro=true"
)

local_paths="$(podman run --rm \
  --mount "type=bind,src=$project_dir/credentials,dst=/config/credentials,ro=true" \
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json,ro=true" \
  suitecloud-workspace --local-paths)"
while IFS=$'\t' read -r directory local_path; do
  [[ -n "$directory" ]] || continue
  [[ "$local_path" == /* ]] || local_path="$project_dir/$local_path"
  if [[ ! -e "$local_path/.git" ]]; then
    echo "SuiteApp $directory localPath is not a Git checkout: $local_path" >&2
    exit 1
  fi
  local_path="$(cd -- "$local_path" && pwd -P)"
  mounts+=(--mount "type=bind,src=$local_path,dst=/workspace/$directory")
done <<< "$local_paths"

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
