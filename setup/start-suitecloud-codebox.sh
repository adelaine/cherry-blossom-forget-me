#!/usr/bin/env bash
set -euo pipefail

setup_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$setup_dir/.." && pwd)"
config_file="$project_dir/suiteapps-to-install.json"
repos_dir="$project_dir/repos"
nems_dir="$HOME/.codex"

if [[ ! -f "$config_file" ]]; then
  echo 'Missing suiteapps-to-install.json.' >&2
  exit 1
fi
if ! command -v podman >/dev/null 2>&1; then
  echo 'Podman is not available on this codebox.' >&2
  exit 1
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
podman build -f "$setup_dir/Containerfile" --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace "$project_dir"

certificate_paths="$(podman run --rm \
  --mount "type=bind,src=$config_file,dst=/config/suiteapps-to-install.json,ro=true" \
  --entrypoint node suitecloud-workspace \
  /opt/suitecontainer/install.js --certificate-paths)"
public_certificate="${certificate_paths%%$'\n'*}"
private_certificate="${certificate_paths#*$'\n'}"
if [[ ! -f "$public_certificate" || ! -f "$private_certificate" ]]; then
  echo 'Certificate files were not found. Update their paths in suiteapps-to-install.json.' >&2
  exit 1
fi

mounts=(
  --mount "type=bind,src=$config_file,dst=/config/suiteapps-to-install.json"
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
