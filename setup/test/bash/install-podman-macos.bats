#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "installer exits when Podman is already available" {
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 0 ]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "Intel installation invokes Homebrew" {
  make_isolated_path
  fake_command uname 'echo x86_64'
  fake_command brew '[[ "$1" == install && "$2" == podman ]]'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 0 ]
  assert_called brew
}

@test "Intel installation propagates Homebrew failures" {
  make_isolated_path
  fake_command uname 'echo x86_64'
  fake_command brew 'exit 4'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 4 ]
}

@test "Intel installation fails clearly when Homebrew is missing" {
  make_isolated_path
  fake_command uname 'echo x86_64'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'Intel Macs need Homebrew'* ]]
}

@test "unsupported architectures stop before downloading" {
  make_isolated_path
  fake_command uname 'echo unknown'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'not supported'* ]]
}

@test "Apple Silicon checks signatures before installation and removes the download" {
  make_isolated_path
  fake_command uname 'echo arm64'
  fake_command curl 'while [[ "$1" != --output ]]; do shift; done; printf "%s\n" "$2" > "$TEST_FIXTURE_ROOT/package-path"; touch "$2"'
  fake_command pkgutil '[[ "$1" == --check-signature ]]'
  fake_command sudo 'printf "#!/usr/bin/env bash\nexit 0\n" > "$(dirname "$0")/podman"; chmod +x "$(dirname "$0")/podman"'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 0 ]
  [ "$(cat "$TEST_COMMAND_LOG")" = $'uname\ncurl\npkgutil\nsudo' ]
  [ ! -e "$(cat "$fixture_root/package-path")" ]
}

@test "failed signature verification stops installation and cleans the download" {
  make_isolated_path
  fake_command uname 'echo arm64'
  fake_command curl 'while [[ "$1" != --output ]]; do shift; done; printf "%s\n" "$2" > "$TEST_FIXTURE_ROOT/package-path"; touch "$2"'
  fake_command pkgutil 'exit 2'
  fake_command sudo 'exit 0'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 2 ]
  assert_not_called sudo
  [ ! -e "$(cat "$fixture_root/package-path")" ]
}

@test "failed downloads stop before signature verification or installation" {
  make_isolated_path
  fake_command uname 'echo arm64'
  fake_command curl 'exit 5'
  fake_command pkgutil 'exit 0'
  fake_command sudo 'exit 0'
  run_launcher setup/install-podman-macos.sh
  [ "$status" -eq 5 ]
  assert_not_called pkgutil
  assert_not_called sudo
}
