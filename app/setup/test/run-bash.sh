#!/usr/bin/env bash
set -euo pipefail

# A direct Git Bash invocation from PowerShell may inherit only Windows PATH entries.
if [[ "${OSTYPE:-}" == msys* ]]; then
  export PATH="/usr/bin:/bin:$PATH"
fi

test_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$test_dir/../../.." && pwd)"
python="$(bash "$project_dir/app/setup/bootstrap/start-suitecloud.sh" --runtime-only)"
"$python" -I -B "$test_dir/bootstrap_test.py"
if command -v bats >/dev/null 2>&1; then
  bats "$test_dir/bash"
elif [[ -f "$project_dir/app/.cache/test-tools/bats-core-1.12.0/bin/bats" ]]; then
  bash "$project_dir/app/.cache/test-tools/bats-core-1.12.0/bin/bats" "$test_dir/bash"
else
  echo 'bats-core is required. Install it using https://bats-core.readthedocs.io/en/stable/installation.html.' >&2
  exit 1
fi
