#!/usr/bin/env bash
set -euo pipefail

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$test_dir/../.." && pwd)"
if command -v bats >/dev/null 2>&1; then
  bats "$test_dir/bash"
elif [[ -f "$project_dir/.cache/test-tools/bats-core-1.12.0/bin/bats" ]]; then
  bash "$project_dir/.cache/test-tools/bats-core-1.12.0/bin/bats" "$test_dir/bash"
else
  echo 'bats-core is required. Install it using https://bats-core.readthedocs.io/en/stable/installation.html.' >&2
  exit 1
fi
