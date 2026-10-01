#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "macOS creates configuration from the example before invoking Podman" {
  rm "$fixture_root/suitecontainer.config.json"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  cmp "$fixture_root/suitecontainer.config.example.json" "$fixture_root/suitecontainer.config.json"
  [ -n "$output" ]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "macOS reports a missing configuration example before invoking Podman" {
  rm "$fixture_root/suitecontainer.config.json" "$fixture_root/suitecontainer.config.example.json"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'Missing suitecontainer.config.example.json'* ]]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "macOS creates auth from the example when missing" {
  rm "$fixture_root/credentials/auth.json"
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  cmp "$fixture_root/credentials/auth.example.json" "$fixture_root/credentials/auth.json"
}

@test "macOS preserves existing configuration and auth" {
  printf '%s\n' '{"gitlab-token":"fixture-token"}' > "$fixture_root/credentials/auth.json"
  cp "$fixture_root/suitecontainer.config.json" "$BATS_TEST_TMPDIR/original.json"
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  cmp "$BATS_TEST_TMPDIR/original.json" "$fixture_root/suitecontainer.config.json"
  grep -F fixture-token "$fixture_root/credentials/auth.json"
}

@test "macOS stops successfully after generating certificates" {
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called --prepare-certificates
  assert_not_called --certificate-paths
  assert_not_called --deploy
}

@test "macOS rejects missing auth and its template before invoking Podman" {
  rm "$fixture_root/credentials/auth.json" "$fixture_root/credentials/auth.example.json"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'Missing credentials/auth.example.json'* ]]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "macOS reuses certificates and deploys with space-containing paths intact" {
  touch "$fixture_nems/.nems.env" "$fixture_nems/config.toml"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called "<type=bind,src=$fixture_root/credentials/public.pem,dst=/config/certs/public.pem,ro=true>"
  assert_called "<build> <-f> <$fixture_root/setup/Containerfile> <--build-arg> <SUITECLOUD_CLI_ACCEPT_LICENSE=true> <-t> <suitecloud-workspace> <$fixture_root/setup>"
  assert_called '<--rm> <-it>'
  assert_called "<type=bind,src=$fixture_nems/.nems.env,dst=/config/.nems.env,ro=true>"
  assert_called "<type=bind,src=$fixture_nems/config.toml,dst=/config/config.toml,ro=true>"
  assert_called --deploy
}

@test "macOS mounts an existing local checkout" {
  mkdir -p "$fixture_root/local app/.git"
  TEST_LOCAL_PATHS_OUTPUT=$'app\tlocal app'
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called "<type=bind,src=$fixture_root/local app,dst=/workspace/app>"
}

@test "macOS skips deployment for an empty SuiteApp list" {
  TEST_VALIDATION_OUTPUT='There are no SuiteApps to install in suitecontainer.config.json.'
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_not_called --prepare-certificates
  assert_not_called --deploy
}

@test "macOS stops on invalid configuration" {
  TEST_VALIDATE_STATUS=1
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  assert_not_called --prepare-certificates
  assert_not_called --deploy
}

@test "macOS stops on partial certificate configuration during preparation" {
  TEST_PREPARE_STATUS=2
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 2 ]
  assert_not_called --certificate-paths
  assert_not_called --deploy
}

@test "macOS stops when certificate ID validation fails" {
  TEST_PATHS_STATUS=1
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  assert_not_called --deploy
}

@test "macOS stops when certificate files do not exist" {
  rm "$fixture_root/credentials/private.pem"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'Certificate files were not found'* ]]
  assert_not_called --deploy
}

@test "macOS declines the license before building" {
  TEST_IMAGE_STATUS=1
  run_launcher setup/start-suitecloud.sh no
  [ "$status" -ne 0 ]
  assert_not_called '<build>'
}

@test "macOS stops on build and deployment failures" {
  TEST_BUILD_STATUS=3
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  assert_not_called --prepare-certificates
  TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=4
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'The container stopped with an error.'* ]]
}

@test "macOS initializes and starts an absent Podman machine" {
  TEST_INFO_STATUS=1 TEST_MACHINE_LIST=''
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called '<machine> <init>'
  assert_called '<machine> <start>'
}
