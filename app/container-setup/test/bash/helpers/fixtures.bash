setup_fixture() {
  source_root="$(cd "$BATS_TEST_DIRNAME/../.." && pwd)"
  fixture_root="$BATS_TEST_TMPDIR/project with spaces"
  fixture_bin="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$fixture_root/app/container-setup/bootstrap" "$fixture_root/start" "$fixture_bin"
  sed 's/\r$//' "$source_root/gitlab-askpass.sh" > "$fixture_root/app/container-setup/gitlab-askpass.sh"
  for script in start-macos.command start-codebox; do
    sed 's/\r$//' "$source_root/../../start/$script" > "$fixture_root/start/$script"
  done
  export TEST_COMMAND_LOG="$BATS_TEST_TMPDIR/commands"
  : > "$TEST_COMMAND_LOG"
  fixture_path="$fixture_bin:$PATH"
}

fake_command() {
  local name="$1" body="$2"
  printf '#!/usr/bin/env bash\nprintf "%s\\n" >> "$TEST_COMMAND_LOG"\n%s\n' "$name" "$body" > "$fixture_bin/$name"
  chmod +x "$fixture_bin/$name"
}
