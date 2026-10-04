#!/usr/bin/env bash
# Shared by the Mac and codebox launchers after the host is bootstrapped.
container_name="suitecontainer-$(printf '%s' "$project_dir" | cksum | awk '{print $1}')"

check_web_owner() {
  local owner
  owner="$(podman inspect --format '{{index .Config.Labels "suitecontainer.project"}}' "$container_name")" || return $?
  if [[ "$owner" != "$project_dir" ]]; then
    echo 'Another container has this app name. It will not be reused or removed.' >&2
    return 1
  fi
}

open_web_page() {
  local address suffix port attempt
  address="$(podman port "$container_name" 8080/tcp | head -n 1)"
  port="${address##*:}"
  for ((attempt=0; attempt<60; attempt++)); do
    if suffix="$(podman exec "$container_name" cat /tmp/suitecontainer-web-url 2>/dev/null)" &&
      curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health" >/dev/null; then
      local url="http://127.0.0.1:$port$suffix"
      echo "Deployment page: $url"
      if [[ "$(uname -s)" == Darwin ]]; then
        open "$url" || echo 'Open the address above in your browser.'
      else
        echo "From your computer, forward the port: ssh -N -L $port:127.0.0.1:$port $(id -un)@$(hostname -f)"
        echo 'Then open the deployment page address above in your browser.'
      fi
      echo 'The app stops automatically when unused. Running deployments and SQL jobs are allowed to finish. Use Stop app to stop it sooner, or run the launcher again to reopen it.'
      return 0
    fi
    if [[ "$(podman inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" != true ]]; then
      podman logs "$container_name" >&2 || true
      echo 'The deployment page could not start.' >&2
      return 1
    fi
    sleep 1
  done
  echo 'The deployment page did not become ready. Check the container logs and relaunch.' >&2
  return 1
}

reuse_web_app() {
  if [[ "$(podman inspect --format '{{.State.Running}}' "$container_name" 2>/dev/null)" == true ]]; then
    check_web_owner || exit $?
    open_web_page || exit $?
    return 0
  fi
  return 1
}

start_web_app() {
  local requests kind name path launch_mounts mount
  local ssh_target ssh_resolved=''
  ssh_target="$(podman run --rm --cgroups=disabled \
    --mount "type=bind,src=$project_dir,dst=/project,ro=true" suitecloud-workspace --web-ssh-target)" || return $?
  if [[ -n "$ssh_target" ]] && command -v ssh >/dev/null; then
    ssh_resolved="$(ssh -G -T "nsbuild@$ssh_target" 2>/dev/null)" || ssh_resolved=''
  fi
  local ssh_environment=(--env "SUITECONTAINER_SSH_TARGET=$ssh_target" --env "SUITECONTAINER_SSH_RESOLVED=$ssh_resolved" --env "SUITECONTAINER_SSH_HOME=$HOME")
  [[ -n "${SUITECONTAINER_SSH_KEY:-}" ]] && ssh_environment+=(--env "SUITECONTAINER_SSH_KEY=$SUITECONTAINER_SSH_KEY")
  [[ -n "${SUITECONTAINER_SSH_KNOWN_HOSTS:-}" ]] && ssh_environment+=(--env "SUITECONTAINER_SSH_KNOWN_HOSTS=$SUITECONTAINER_SSH_KNOWN_HOSTS")
  local staged=(--mount "type=bind,src=$project_dir,dst=/project")
  requests="$(podman run --rm --cgroups=disabled \
    --mount "type=bind,src=$project_dir,dst=/project,ro=true" \
    --env "SUITECONTAINER_HOST_ROOT=$project_dir" \
    --env SUITECONTAINER_HOST_PLATFORM=linux "${ssh_environment[@]}" suitecloud-workspace --web-paths)" || return $?
  while IFS=$'\t' read -r kind name path; do
    [[ -n "$path" ]] || continue
    if { [[ ( "$kind" == local || "$kind" == sftp ) && -d "$path" ]]; } || { [[ ( "$kind" == external || "$kind" == ssh ) && -f "$path" ]]; }; then
      if [[ "$kind" == external ]]; then name="$name.pem"; fi
      staged+=(--mount "type=bind,src=$path,dst=/$kind/$name,ro=true")
    fi
  done <<< "$requests"
  launch_mounts="$(podman run --rm --cgroups=disabled "${staged[@]}" \
    --env "SUITECONTAINER_HOST_ROOT=$project_dir" \
    --env SUITECONTAINER_HOST_PLATFORM=linux "${ssh_environment[@]}" suitecloud-workspace --web-mounts)" || return $?
  local mounts=()
  while IFS= read -r mount; do
    [[ -n "$mount" ]] && mounts+=(--mount "$mount")
  done <<< "$launch_mounts"
  if podman container exists "$container_name"; then
    check_web_owner || return $?
    podman rm "$container_name" >/dev/null
  fi
  podman run -d --name "$container_name" --label "suitecontainer.project=$project_dir" \
    --cgroups=disabled -p 127.0.0.1::8080 -p 127.0.0.1::8000 --env SUITECONTAINER_SFTP=1 \
    --env "SUITECONTAINER_HOST_FQDN=$(hostname -f 2>/dev/null || true)" "${mounts[@]}" suitecloud-workspace --serve >/dev/null
  open_web_page
}
