#!/usr/bin/env bash
# Configuration and environment values are passed as build secrets, never build arguments.
npmrc_file="${SUITECONTAINER_NPMRC:-${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-$HOME/.npmrc}}}"
npm_globalrc="${NPM_CONFIG_GLOBALCONFIG:-${npm_config_globalconfig:-}}"
if command -v npm >/dev/null 2>&1; then
  if [[ -z "${SUITECONTAINER_NPMRC:-}${NPM_CONFIG_USERCONFIG:-}${npm_config_userconfig:-}" ]]; then
    if reported_config="$(npm config get userconfig 2>/dev/null)" && [[ -n "$reported_config" ]]; then npmrc_file="$reported_config"; fi
  fi
  if [[ -z "$npm_globalrc" ]]; then
    if reported_config="$(npm config get globalconfig 2>/dev/null)" && [[ -n "$reported_config" ]]; then npm_globalrc="$reported_config"; fi
  fi
fi
build_secrets=()
npm_config_files=()
for entry in "npm-globalrc:$npm_globalrc" "npmrc:$npmrc_file" "npm-rootrc:$project_dir/.npmrc" "npm-projectrc:$project_dir/app/.npmrc"; do
  secret_id="${entry%%:*}"
  config_file="${entry#*:}"
  if [[ -n "$config_file" && -f "$config_file" && -r "$config_file" ]]; then
    build_secrets+=(--secret "id=$secret_id,src=$config_file")
    npm_config_files+=("$config_file")
    printf 'npm configuration: %s\n' "$config_file"
  fi
done
if [[ ${#npm_config_files[@]} -eq 0 ]]; then echo 'npm configuration: environment and container defaults'; fi
npm_env_file=''
trap 'if [[ -n "$npm_env_file" ]]; then rm -f "$npm_env_file"; fi' EXIT
write_npm_variable() {
  local variable="$1"
  if [[ "${!variable+x}" == x ]]; then
    if [[ -z "$npm_env_file" ]]; then
      npm_env_file="$(mktemp "${TMPDIR:-/tmp}/suitecontainer-npm-env.XXXXXX")"
      chmod 600 "$npm_env_file"
    fi
    printf '%s\0%s\0' "$variable" "${!variable}" >> "$npm_env_file"
  fi
}
while IFS= read -r variable; do
  case "$variable" in npm_config_*|NPM_CONFIG_*) write_npm_variable "$variable" ;; esac
done < <(compgen -e)
for config_file in ${npm_config_files[@]+"${npm_config_files[@]}"}; do
  while IFS= read -r line || [[ -n "$line" ]]; do
    while [[ "$line" =~ \$\{([A-Za-z_][A-Za-z0-9_]*)\} ]]; do
      reference="${BASH_REMATCH[0]}"
      write_npm_variable "${BASH_REMATCH[1]}"
      line="${line#*"$reference"}"
    done
  done < "$config_file"
done
if [[ -n "$npm_env_file" ]]; then build_secrets+=(--secret "id=npm-env,src=$npm_env_file"); fi
if [[ -n "${NSX_NPM_TOKEN:-}" ]]; then
  build_secrets+=(--secret "id=npm-token,env=NSX_NPM_TOKEN,type=env")
fi
