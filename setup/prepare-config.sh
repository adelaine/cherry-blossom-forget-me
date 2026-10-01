#!/usr/bin/env bash
set -euo pipefail

project_dir="$1"
config_file="$project_dir/suitecontainer.config.json"
template_file="$project_dir/suitecontainer.config.example.json"
credentials_dir="$project_dir/credentials"
auth_file="$credentials_dir/auth.json"

mkdir -p -m 700 "$credentials_dir"
if [[ ! -f "$auth_file" ]]; then
  if [[ ! -f "$credentials_dir/auth.example.json" ]]; then
    echo 'Missing credentials/auth.example.json. Restore the template and run the start script again.' >&2
    exit 1
  fi
  (umask 077; cp -- "$credentials_dir/auth.example.json" "$auth_file")
  echo 'Created credentials/auth.json. Set gitlab-token there; supply certificate paths or leave both empty to generate them.'
fi

if [[ -f "$config_file" ]]; then
  exit 0
fi
if [[ ! -f "$template_file" ]]; then
  echo 'Missing suitecontainer.config.example.json. Restore the template and run the start script again.' >&2
  exit 1
fi
cp -- "$template_file" "$config_file"
echo 'Created suitecontainer.config.json from the template.'
echo 'Add your SuiteApps and VMs, then run the start script again. Credentials belong in credentials/auth.json.'
# The launchers map this status to a successful first-run stop.
exit 10
