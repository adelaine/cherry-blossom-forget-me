#!/usr/bin/env bats
load helpers/fixtures

setup() {
  setup_fixture
  cp "$fixture_bin/podman" "$fixture_root/podman-fixture"
}

@test "codebox installer reuses existing Podman without installing packages" {
  run_launcher setup/installers/install-podman-codebox.sh
  [ "$status" -eq 0 ]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "codebox installer automatically uses sudo dnf for a regular user" {
  make_isolated_path
  fake_command id 'echo 1000'
  fake_command sudo '[[ "$*" == "dnf install -y podman" ]] || exit 2; "$@"'
  fake_command dnf 'cp "$TEST_FIXTURE_ROOT/podman-fixture" "$(dirname "$0")/podman"'
  run_launcher setup/installers/install-podman-codebox.sh
  [ "$status" -eq 0 ]
  assert_called sudo
  assert_called dnf
}

@test "codebox installer uses yum without sudo when running as root" {
  make_isolated_path
  fake_command id 'echo 0'
  fake_command yum '[[ "$*" == "install -y podman" ]] || exit 2; cp "$TEST_FIXTURE_ROOT/podman-fixture" "$(dirname "$0")/podman"'
  run_launcher setup/installers/install-podman-codebox.sh
  [ "$status" -eq 0 ]
  assert_called yum
  assert_not_called sudo
}

@test "codebox installer explains missing sudo access" {
  make_isolated_path
  fake_command id 'echo 1000'
  fake_command dnf 'exit 0'
  run_launcher setup/installers/install-podman-codebox.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'requires sudo access'* ]]
  assert_not_called dnf
}

@test "codebox installer preserves package manager failures" {
  make_isolated_path
  fake_command id 'echo 0'
  fake_command dnf 'echo "Repository unavailable" >&2; exit 4'
  run_launcher setup/installers/install-podman-codebox.sh
  [ "$status" -eq 4 ]
  [[ "$output" == *'Repository unavailable'* ]]
  [[ "$output" == *'Podman installation failed'* ]]
}
