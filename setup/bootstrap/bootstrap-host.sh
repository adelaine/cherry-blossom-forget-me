#!/usr/bin/env bash
# Sourced before Podman installation; never sources token files as shell code.
umask 077
mkdir -p "$project_dir/credentials" "$project_dir/repos"
if [[ ! -f "$project_dir/suitecontainer.config.json" ]]; then
  cp "$project_dir/suitecontainer.config.example.json" "$project_dir/suitecontainer.config.json"
fi
if [[ ! -f "$project_dir/credentials/auth.json" ]]; then
  cp "$project_dir/credentials/auth.example.json" "$project_dir/credentials/auth.json"
fi
token_sources=(
  "$project_dir/.codex/config.toml" "$nems_dir/config.toml"
  "$project_dir/.nems.env" "$nems_dir/.nems.env"
)
if [[ -z "${SUITECONTAINER_NEMS_DIR:-}" ]]; then token_sources+=("$HOME/.nems.env"); fi
if [[ "$(uname -s)" == Darwin ]]; then
  osascript -l JavaScript "$bootstrap_dir/bootstrap-token.cjs" "$project_dir/credentials/auth.json" "${token_sources[@]}"
elif command -v node >/dev/null 2>&1; then
  node "$bootstrap_dir/bootstrap-token.cjs" "$project_dir/credentials/auth.json" "${token_sources[@]}"
elif command -v python3 >/dev/null 2>&1; then
  python3 "$bootstrap_dir/bootstrap-token.py" "$project_dir/credentials/auth.json" "${token_sources[@]}"
else
  echo 'Token discovery is unavailable on this host. Enter your GitLab token on the deployment page if needed.'
fi
chmod 600 "$project_dir/credentials/auth.json"
