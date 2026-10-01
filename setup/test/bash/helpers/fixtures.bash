setup_fixture() {
  source_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixture_root="$BATS_TEST_TMPDIR/project with spaces"
  fixture_bin="$BATS_TEST_TMPDIR/bin"
  fixture_nems="$BATS_TEST_TMPDIR/nems"
  mkdir -p "$fixture_root/setup" "$fixture_root/credentials" "$fixture_bin" "$fixture_nems"
  for script in start-suitecloud.sh start-suitecloud-codebox.sh install-podman-macos.sh install-podman-codebox.sh gitlab-askpass.sh; do
    sed 's/\r$//' "$source_root/$script" > "$fixture_root/setup/$script"
  done
  for script in start-macos.sh start-codebox; do
    sed 's/\r$//' "$source_root/../$script" > "$fixture_root/$script"
  done
  sed 's/\r$//' "$source_root/../suitecontainer.config.example.json" > "$fixture_root/suitecontainer.config.example.json"
  printf '%s\n' '{"vms":[{"account":"123456_SB1","url":"example.netsuite.com"}],"suiteapps":[{"url":"https://gitlab.eng.netsuite.com/test/app.git","directory":"app"}]}' > "$fixture_root/suitecontainer.config.json"
  cp "$source_root/../credentials/auth.example.json" "$fixture_root/credentials/auth.example.json"
  printf '%s\n' '{"gitlab-token":"","suitecloud-certificates":{"id":"test","public":"credentials/public.pem","private":"credentials/private.pem"}}' > "$fixture_root/credentials/auth.json"
  touch "$fixture_root/credentials/public.pem" "$fixture_root/credentials/private.pem"
  export SUITECONTAINER_NPMRC="$BATS_TEST_TMPDIR/npm config/.npmrc"
  export TEST_COMMAND_LOG="$BATS_TEST_TMPDIR/commands"
  export TEST_FIXTURE_ROOT="$fixture_root"
  export TEST_PREPARE_STATUS=0 TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=0 TEST_PATHS_STATUS=0
  export TEST_MACHINE_LIST=true
  : > "$TEST_COMMAND_LOG"
  cat > "$fixture_bin/podman" <<'SH'
#!/usr/bin/env bash
printf 'podman' >> "$TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"
case "$1" in
  machine) if [[ "$2" == list ]]; then printf '%s' "$TEST_MACHINE_LIST"; fi ;;
  build) exit "$TEST_BUILD_STATUS" ;;
  run)
    for argument in "$@"; do
      case "$argument" in
        --prepare-launch) echo 'Installer preparation'; exit "$TEST_PREPARE_STATUS" ;;
        --launch-mounts)
          if [[ "$TEST_PATHS_STATUS" != 0 ]]; then exit "$TEST_PATHS_STATUS"; fi
          printf '%s\n' "type=bind,src=$TEST_FIXTURE_ROOT/repos,dst=/workspace"; exit 0 ;;
        --deploy) exit "$TEST_DEPLOY_STATUS" ;;
      esac
    done ;;
esac
SH
  chmod +x "$fixture_bin/podman"
  fixture_path="$fixture_bin:$PATH"
}

run_launcher() {
  local script="$1" answer="${2:-yes}"
  run bash -c 'printf "%s\n" "$4" | env SUITECONTAINER_NEMS_DIR="$3" PATH="$2" bash "$1"' _ "$fixture_root/$script" "$fixture_path" "$fixture_nems" "$answer"
}

assert_called() { grep -F -- "$1" "$TEST_COMMAND_LOG"; }
assert_not_called() { ! grep -F -- "$1" "$TEST_COMMAND_LOG"; }

make_isolated_path() {
  # Keep only required utilities so host Podman and Homebrew cannot leak in.
  fixture_path="$fixture_bin"
  rm -f "$fixture_bin/podman"
  for utility in bash dirname mktemp rm rmdir cat touch chmod mkdir cp; do
    printf '#!/bin/bash\nexec %q "$@"\n' "$(command -v "$utility")" > "$fixture_bin/$utility"
    chmod +x "$fixture_bin/$utility"
  done
}

fake_command() {
  local name="$1" body="$2"
  printf '#!/usr/bin/env bash\nprintf "%s\\n" >> "$TEST_COMMAND_LOG"\n%s\n' "$name" "$body" > "$fixture_bin/$name"
  chmod +x "$fixture_bin/$name"
}
