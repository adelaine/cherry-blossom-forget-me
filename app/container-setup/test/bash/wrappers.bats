#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "macOS wrapper finds its launcher from another directory and preserves visible failures" {
  printf 'printf "launcher failed\\n"\nexit 7\n' > "$fixture_root/app/container-setup/bootstrap/start-suitecloud.sh"
  cd "$BATS_TEST_TMPDIR"
  run bash -c 'printf "\n" | bash "$1"' _ "$fixture_root/start/start-macos.command"
  [ "$status" -eq 7 ]
  [[ "$output" == *'launcher failed'* ]]
  [[ "$output" == *'Press Return'* ]]
}

@test "codebox entry wrapper propagates launcher success" {
  printf 'printf "launcher reached\\n"\nexit 0\n' > "$fixture_root/app/container-setup/bootstrap/start-suitecloud-codebox.sh"
  cd "$BATS_TEST_TMPDIR"
  run bash "$fixture_root/start/start-codebox"
  [ "$status" -eq 0 ]
  [ "$output" = 'launcher reached' ]
}
