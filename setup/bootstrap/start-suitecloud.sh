#!/usr/bin/env bash
set -euo pipefail
bootstrap_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$bootstrap_dir/../.." && pwd)"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64) target=macos-arm64; digest_command=(shasum -a 256) ;;
  Linux:x86_64) target=linux-x64; digest_command=(sha256sum) ;;
  *) echo 'This package supports Apple Silicon Macs and Intel/AMD 64-bit Linux codeboxes.' >&2; exit 1 ;;
esac
metadata="$project_dir/setup/python/runtimes.tsv"
version='' release='' digest='' url=''
while IFS=$'\t' read -r entry entry_version entry_release entry_digest entry_url; do
  if [[ "$entry" == "$target" ]]; then
    version="$entry_version" release="$entry_release" digest="$entry_digest" url="$entry_url"
    break
  fi
done < "$metadata"
if [[ ! "$digest" =~ ^[a-f0-9]{64}$ || "$url" != https://* ]]; then echo 'The Python download metadata is missing or invalid.' >&2; exit 1; fi
runtime_dir="$project_dir/.cache/python/$digest"
python="$runtime_dir/python/bin/python3"
if [[ ! -f "$runtime_dir/.ready" || ! -x "$python" ]]; then
  mkdir -p "$runtime_dir"
  archive="$(mktemp "$runtime_dir/download.XXXXXX")"
  trap 'rm -f "$archive"' EXIT
  printf 'Downloading Python %s for %s...\n' "$version" "$target" >&2
  if ! curl --fail --location --show-error --silent --output "$archive" "$url"; then
    echo 'Could not download Python. Check network access, proxy settings, and VPN/Banyan sign-in, then retry.' >&2
    exit 1
  fi
  actual_digest="$("${digest_command[@]}" "$archive")"
  if [[ "${actual_digest%% *}" != "$digest" ]]; then
    echo 'The Python download checksum did not match. A proxy or VPN/Banyan sign-in page may have replaced the archive. Reconnect/sign in and retry.' >&2
    exit 1
  fi
  tar -xzf "$archive" -C "$runtime_dir"
  [[ -x "$python" ]] || { echo 'The downloaded Python archive does not contain its interpreter.' >&2; exit 1; }
  touch "$runtime_dir/.ready"
  rm -f "$archive"
  trap - EXIT
fi
if [[ "${1:-}" == --runtime-only ]]; then printf '%s\n' "$python"; exit 0; fi
exec "$python" -I -B "$bootstrap_dir/bootstrap.py"
