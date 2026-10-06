#!/usr/bin/env bash
set -uo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
status=0
bash "$script_dir/setup/bootstrap/start-suitecloud.sh" || status=$?
if [[ "$status" -ne 0 ]]; then
  printf '\nSetup could not finish. Review the message above.\nPress Return to close this window. '
  read -r _
fi
exit "$status"
