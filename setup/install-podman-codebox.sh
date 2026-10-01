#!/usr/bin/env bash
set -euo pipefail

if command -v podman >/dev/null 2>&1; then
  exit 0
fi

if command -v dnf >/dev/null 2>&1; then
  package_manager=dnf
elif command -v yum >/dev/null 2>&1; then
  package_manager=yum
else
  echo 'Cannot install Podman automatically: this codebox needs dnf or yum. Ask your codebox administrator to install Podman.' >&2
  exit 1
fi

elevate=()
if [[ "$(id -u)" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo 'Installing Podman requires sudo access. Ask your codebox administrator to install Podman.' >&2
    exit 1
  fi
  elevate=(sudo)
fi

echo "Podman is missing. Installing it with $package_manager..."
install_status=0
"${elevate[@]}" "$package_manager" install -y podman || install_status=$?
if [[ "$install_status" -ne 0 ]]; then
  echo 'Podman installation failed. Check the package manager error above, repository access, and sudo permissions, then run start-codebox again.' >&2
  exit "$install_status"
fi

hash -r
if ! command -v podman >/dev/null 2>&1; then
  echo 'Installation completed, but Podman is still not on PATH. Ask your codebox administrator to check the installation.' >&2
  exit 1
fi
