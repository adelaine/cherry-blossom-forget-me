#!/usr/bin/env bash
set -uo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
status=0
noninteractive=false
for argument in "$@"; do
  if [[ "$argument" == --json || "$argument" == --non-interactive ]]; then noninteractive=true; fi
done
bash "$script_dir/setup/bootstrap/start-suitecloud.sh" "$@" || status=$?
if [[ "$status" -ne 0 && "$status" -ne 10 && "$noninteractive" == false ]]; then
  printf '\nSetup could not finish. Review the message above.\nPress Return to close this window. '
  read -r _
fi
exit "$status"
