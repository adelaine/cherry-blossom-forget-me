#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "codebox creates configuration and exits before checking Podman" {
  rm "$fixture_root/suitecontainer.config.json"
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  cmp "$fixture_root/suitecontainer.config.example.json" "$fixture_root/suitecontainer.config.json"
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "codebox creates auth and exits after certificate generation" {
  rm "$fixture_root/credentials/auth.json"
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  cmp "$fixture_root/credentials/auth.example.json" "$fixture_root/credentials/auth.json"
  assert_not_called --certificate-paths
  assert_not_called --deploy
}

@test "codebox deploys with existing certificates and quoted mounts" {
  touch "$fixture_nems/.nems.env" "$fixture_nems/config.toml"
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_called "<type=bind,src=$fixture_root/repos,dst=/workspace>"
  assert_called "<build> <-f> <$fixture_root/setup/Containerfile> <--build-arg> <SUITECLOUD_CLI_ACCEPT_LICENSE=true> <--build-arg> <SUITECLOUD_PROXY> <-t> <suitecloud-workspace> <$fixture_root/setup>"
  assert_called "<type=bind,src=$fixture_nems/.nems.env,dst=/config/.nems.env,ro=true>"
  assert_called "<type=bind,src=$fixture_nems/config.toml,dst=/config/config.toml,ro=true>"
  assert_called --deploy
  assert_called "<type=bind,src=$fixture_root/credentials/auth.json,dst=/config/credentials/auth.json,ro=true>"
}

@test "codebox skips deployment for an empty SuiteApp list" {
  TEST_VALIDATION_OUTPUT='There are no SuiteApps to install in suitecontainer.config.json.'
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_not_called --prepare-certificates
  assert_not_called --deploy
}

@test "codebox stops on invalid configuration" {
  TEST_VALIDATE_STATUS=1
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  assert_not_called --prepare-certificates
  assert_not_called --deploy
}

@test "codebox stops when Podman is not ready" {
  TEST_INFO_STATUS=1
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'Podman is not ready'* ]]
  assert_not_called '<build>'
}

@test "codebox reports an unsupported package manager before building" {
  make_isolated_path
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  [[ "$output" == *'this codebox needs dnf or yum'* ]]
  [ ! -s "$TEST_COMMAND_LOG" ]
}

@test "codebox automatically installs missing Podman and continues setup" {
  cp "$fixture_bin/podman" "$fixture_root/podman-fixture"
  make_isolated_path
  fake_command id 'echo 0'
  fake_command dnf '[[ "$*" == "install -y podman" ]] || exit 2; cp "$TEST_FIXTURE_ROOT/podman-fixture" "$(dirname "$0")/podman"'
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_called dnf
  assert_called --prepare-certificates
}

@test "codebox stops before building when package installation fails" {
  make_isolated_path
  fake_command id 'echo 0'
  fake_command dnf 'echo "Repository unavailable" >&2; exit 7'
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 7 ]
  [[ "$output" == *'Repository unavailable'* ]]
  [[ "$output" == *'Podman installation failed'* ]]
  assert_not_called '<build>'
}

@test "codebox automatically accepts the license for a new image" {
  TEST_IMAGE_STATUS=1
  run_launcher setup/start-suitecloud-codebox.sh no
  [ "$status" -eq 0 ]
  assert_called '<SUITECLOUD_CLI_ACCEPT_LICENSE=true>'
  [[ "$output" != *'Do you accept these terms?'* ]]
}

@test "codebox stops on failed builds and failed deployments" {
  TEST_BUILD_STATUS=3
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  assert_not_called --prepare-certificates
  TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=4
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
}

@test "codebox stops on partial certificates and missing certificate IDs" {
  TEST_PREPARE_STATUS=2
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 2 ]
  assert_not_called --deploy
  TEST_PREPARE_STATUS=0 TEST_PATHS_STATUS=1
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  assert_not_called --deploy
}

@test "codebox stops when certificate files are absent" {
  rm "$fixture_root/credentials/public.pem"
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  assert_not_called --deploy
}

@test "codebox passes npm configuration as a build secret" {
  mkdir -p "$(dirname "$SUITECONTAINER_NPMRC")"
  printf '%s\n' 'registry=https://registry.example.test/' '//registry.example.test/:_authToken=test-secret' > "$SUITECONTAINER_NPMRC"
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_called "<--secret> <id=npmrc,src=$SUITECONTAINER_NPMRC>"
  assert_not_called test-secret
}

@test "codebox builds without a secret when npm configuration is absent" {
  run_launcher setup/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_not_called '<--secret>'
}
