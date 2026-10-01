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
  bash "$setup_dir/install-podman-codebox.sh"
fi
if ! podman info >/dev/null 2>&1; then
  echo 'Podman is not ready on this codebox.' >&2
  exit 1
fi

mkdir -p "$repos_dir"

if ! podman image exists suitecloud-workspace; then
  echo 'Read the Oracle Free Use Terms and Conditions before building:'
  echo 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_155929845760.html'
  read -r -p 'Do you accept these terms? Type yes to continue: ' answer
  if [[ "$answer" != yes ]]; then
    echo 'Build cancelled.' >&2
    exit 1
  fi
fi
podman build -f "$setup_dir/Containerfile" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace "$setup_dir"

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
  --entrypoint node suitecloud-workspace \
  /opt/suitecontainer/install.js --certificate-paths)"
public_certificate="${certificate_paths%%$'\n'*}"
private_certificate="${certificate_paths#*$'\n'}"
[[ "$public_certificate" == /* ]] || public_certificate="$project_dir/$public_certificate"
[[ "$private_certificate" == /* ]] || private_certificate="$project_dir/$private_certificate"
if [[ ! -f "$public_certificate" || ! -f "$private_certificate" ]]; then
  echo 'Certificate files were not found. Update their paths in credentials/auth.json.' >&2
  exit 1
fi

mounts=(
  --mount "type=bind,src=$project_dir/credentials/auth.json,dst=/config/credentials/auth.json,ro=true"
  --mount "type=bind,src=$config_file,dst=/config/suitecontainer.config.json"
  --mount "type=bind,src=$repos_dir,dst=/workspace"
  --mount "type=bind,src=$public_certificate,dst=/config/certs/public.pem,ro=true"
  --mount "type=bind,src=$private_certificate,dst=/config/certs/private.pem,ro=true"
)

for name in .nems.env config.toml; do
  file="$nems_dir/$name"
  if [[ -f "$file" ]]; then
    mounts+=(--mount "type=bind,src=$file,dst=/config/$name,ro=true")
  fi
done

podman run --rm -it "${mounts[@]}" suitecloud-workspace --deploy
