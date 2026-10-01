#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "macOS entry wrapper locates its launcher from a different working directory" {
  printf 'printf "launcher reached\\n"\nexit 7\n' > "$fixture_root/setup/start-suitecloud.sh"
  cd "$BATS_TEST_TMPDIR"
  run bash "$fixture_root/start-macos.sh"
  [ "$status" -eq 7 ]
  [ "$output" = 'launcher reached' ]
}

@test "Finder wrapper leaves a failure visible and preserves its exit status" {
  printf 'printf "launcher failed\\n"\nexit 7\n' > "$fixture_root/setup/start-suitecloud.sh"
  run bash -c 'printf "\\n" | bash "$1"' _ "$fixture_root/start-macos.command"
  [ "$status" -eq 7 ]
  [[ "$output" == *'launcher failed'* ]]
  [[ "$output" == *'Press Return'* ]]
}

@test "codebox entry wrapper propagates launcher success" {
  printf 'printf "launcher reached\\n"\nexit 0\n' > "$fixture_root/setup/start-suitecloud-codebox.sh"
  cd "$BATS_TEST_TMPDIR"
  run bash "$fixture_root/start-codebox"
  [ "$status" -eq 0 ]
  [ "$output" = 'launcher reached' ]
}
