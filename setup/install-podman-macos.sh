#!/usr/bin/env bash
set -euo pipefail

if command -v podman >/dev/null 2>&1; then
  exit 0
fi

case "$(uname -m)" in
  arm64) package_arch=arm64 ;;
  x86_64)
    if ! command -v brew >/dev/null 2>&1; then
      echo 'Intel Macs need Homebrew to install Podman. Install it from https://brew.sh, then run start-macos.sh again.' >&2
      exit 1
    fi
    echo 'Installing Podman with Homebrew...'
    brew install podman
    exit 0
    ;;
  *) echo 'This Mac processor is not supported by the Podman installer.' >&2; exit 1 ;;
esac

package_dir="$(mktemp -d -t podman-installer.XXXXXX)"
package_file="$package_dir/podman-installer-macos-${package_arch}.pkg"
trap 'rm -f "$package_file"; rmdir "$package_dir"' EXIT
package_url="https://github.com/podman-container-tools/podman/releases/latest/download/podman-installer-macos-${package_arch}.pkg"

echo 'Downloading the official Podman installer...'
curl --fail --location --show-error --silent --output "$package_file" "$package_url"
pkgutil --check-signature "$package_file" >/dev/null

echo 'Installing Podman. macOS may ask for your password.'
sudo installer -pkg "$package_file" -target /

if [[ ! -x /opt/podman/bin/podman ]] && ! command -v podman >/dev/null 2>&1; then
  echo 'Podman was installed, but Terminal cannot find it yet. Close Terminal and run start-macos.sh again.' >&2
  exit 1
fi
