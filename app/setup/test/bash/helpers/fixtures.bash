setup_fixture() {
  source_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixture_root="$BATS_TEST_TMPDIR/project with spaces"
  fixture_bin="$BATS_TEST_TMPDIR/bin"
  fixture_nems="$BATS_TEST_TMPDIR/nems"
  mkdir -p "$fixture_root/app/setup/bootstrap" "$fixture_root/app/setup/config-example" "$fixture_root/start" "$fixture_root/home/config" "$fixture_root/home/credentials" "$fixture_bin" "$fixture_nems"
  for script in bootstrap/start-suitecloud.sh bootstrap/start-suitecloud-codebox.sh gitlab-askpass.sh; do
    # Keep native installation directories out of fixtures so a future test run cannot invoke host Homebrew/Podman.
    sed -e 's/\r$//' -e 's|/opt/homebrew/bin:/usr/local/bin:/opt/podman/bin:||g' -e 's|/opt/podman/bin:||g' "$source_root/$script" > "$fixture_root/app/setup/$script"
  done
  for script in start-macos.command start-codebox; do
    sed 's/\r$//' "$source_root/../../start/$script" > "$fixture_root/start/$script"
  done
  sed 's/\r$//' "$source_root/config-example/suitecontainer.example.json" > "$fixture_root/app/setup/config-example/suitecontainer.example.json"
  printf '%s\n' '{"vms":[{"account":"123456_SB1","url":"example.netsuite.com"}],"suiteapps":[{"url":"https://gitlab.eng.netsuite.com/test/app.git","directory":"app"}]}' > "$fixture_root/home/config/suitecontainer.json"
  cp "$source_root/config-example/auth.example.json" "$fixture_root/app/setup/config-example/auth.example.json"
  printf '%s\n' '{"gitlab-token":"","suitecloud-certificates":{"id":"test","public":"credentials/public.pem","private":"credentials/private.pem"}}' > "$fixture_root/home/credentials/auth.json"
  touch "$fixture_root/home/credentials/public.pem" "$fixture_root/home/credentials/private.pem"
  export SUITECONTAINER_NPMRC="$BATS_TEST_TMPDIR/npm config/.npmrc"
  export TEST_COMMAND_LOG="$BATS_TEST_TMPDIR/commands"
  export TEST_FIXTURE_ROOT="$fixture_root"
  export TEST_PREPARE_STATUS=0 TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=0 TEST_PATHS_STATUS=0
  export TEST_MACHINE_LIST=true
  export TEST_APP_RUNNING=false TEST_APP_STARTED=false
  : > "$TEST_COMMAND_LOG"
  cat > "$fixture_bin/podman" <<'SH'
#!/usr/bin/env bash
printf 'podman' >> "$TEST_COMMAND_LOG"
printf ' <%s>' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"
case "$1" in
  inspect)
    if [[ "$3" == *suitecontainer.project* ]]; then echo "$TEST_FIXTURE_ROOT";
    elif [[ "$TEST_APP_RUNNING" == true || -f "$TEST_FIXTURE_ROOT/started" ]]; then echo true; else echo false; fi ;;
  port) echo '127.0.0.1:49123' ;;
  exec) echo '/#session=fixture-session' ;;
  container) exit 1 ;;
  machine) if [[ "$2" == list ]]; then printf '%s' "$TEST_MACHINE_LIST"; fi ;;
  build) exit "$TEST_BUILD_STATUS" ;;
  run)
    for argument in "$@"; do
      case "$argument" in
        --web-paths) exit "$TEST_PREPARE_STATUS" ;;
        --web-mounts)
          if [[ "$TEST_PATHS_STATUS" != 0 ]]; then exit "$TEST_PATHS_STATUS"; fi
          printf '%s\n' "type=bind,src=$TEST_FIXTURE_ROOT/home/repos,dst=/workspace"; exit 0 ;;
        --serve) if [[ "$TEST_DEPLOY_STATUS" != 0 ]]; then exit "$TEST_DEPLOY_STATUS"; fi; touch "$TEST_FIXTURE_ROOT/started" ;;
      esac
    done ;;
esac
SH
  chmod +x "$fixture_bin/podman"
  fake_command curl 'exit 0'
  fake_command open 'exit 0'
  fake_command osascript 'exit 0'
  fixture_path="$fixture_bin:$PATH"
}

run_launcher() {
  local script="$1" answer="${2:-yes}"
  run bash -c 'printf "%s\n" "$4" | env SUITECONTAINER_NEMS_DIR="$3" PATH="$2" bash "$1"' _ "$fixture_root/start/$script" "$fixture_path" "$fixture_nems" "$answer"
}

assert_called() { grep -F -- "$1" "$TEST_COMMAND_LOG"; }
assert_not_called() { ! grep -F -- "$1" "$TEST_COMMAND_LOG"; }

make_isolated_path() {
  # Keep only required utilities so host Podman and Homebrew cannot leak in.
  fixture_path="$fixture_bin"
  rm -f "$fixture_bin/podman"
  for utility in bash dirname mktemp rm rmdir cat touch chmod mkdir cp cksum awk head id hostname; do
    printf '#!/bin/bash\nexec %q "$@"\n' "$(command -v "$utility")" > "$fixture_bin/$utility"
    chmod +x "$fixture_bin/$utility"
  done
}

fake_command() {
  local name="$1" body="$2"
  printf '#!/usr/bin/env bash\nprintf "%s\\n" >> "$TEST_COMMAND_LOG"\n%s\n' "$name" "$body" > "$fixture_bin/$name"
  chmod +x "$fixture_bin/$name"
}
