#!/usr/bin/env bash
set -euo pipefail
bootstrap_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$bootstrap_dir/start-suitecloud.sh"
