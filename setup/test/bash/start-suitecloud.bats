#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "macOS builds and launches with mounts supplied by the app" {
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called '<build>'
  assert_called --prepare-launch
  assert_called --launch-mounts
  assert_called --deploy
  assert_called "<type=bind,src=$fixture_root,dst=/project>"
  assert_called "<type=bind,src=$fixture_root/repos,dst=/workspace>"
}

@test "macOS stops successfully when the app requests configuration or certificate setup" {
  TEST_PREPARE_STATUS=10
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_not_called --launch-mounts
  assert_not_called --deploy
}

@test "macOS propagates app preparation and mount failures" {
  TEST_PREPARE_STATUS=2
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 2 ]
  assert_not_called --deploy
  TEST_PREPARE_STATUS=0 TEST_PATHS_STATUS=3
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 3 ]
  assert_not_called --deploy
}

@test "macOS stops on build and deployment failures" {
  TEST_BUILD_STATUS=3
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
  assert_not_called --prepare-launch
  TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=4
  run_launcher setup/start-suitecloud.sh
  [ "$status" -ne 0 ]
}

@test "macOS passes npm configuration as a build secret" {
  mkdir -p "$(dirname "$SUITECONTAINER_NPMRC")"
  printf '%s\n' 'registry=https://registry.example.test/' > "$SUITECONTAINER_NPMRC"
  run_launcher setup/start-suitecloud.sh
  [ "$status" -eq 0 ]
  assert_called "<--secret> <id=npmrc,src=$SUITECONTAINER_NPMRC>"
}
