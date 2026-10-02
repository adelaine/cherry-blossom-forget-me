#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "codebox builds and starts the page without deploying" {
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_called '<build>'
  assert_called "<-f> <$fixture_root/setup/Containerfile> <--ignorefile> <$fixture_root/setup/.containerignore>"
  assert_called "<-t> <suitecloud-workspace> <$fixture_root>"
  assert_called --web-paths
  assert_called --web-mounts
  assert_called --serve
  assert_not_called --deploy
  assert_called '<127.0.0.1::8080>'
  [[ "$output" == *'ssh -N -L'* ]]
  assert_called "<type=bind,src=$fixture_root,dst=/project>"
  assert_called "<type=bind,src=$fixture_root/repos,dst=/workspace>"
}

@test "codebox creates first-run files and continues without configuration prompts" {
  rm "$fixture_root/suitecontainer.config.json" "$fixture_root/credentials/auth.json"
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  [ -f "$fixture_root/suitecontainer.config.json" ]
  [ -f "$fixture_root/credentials/auth.json" ]
  [ -d "$fixture_root/repos" ]
  assert_called --serve
}

@test "codebox propagates app preparation and mount failures" {
  TEST_PREPARE_STATUS=2
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 2 ]
  assert_not_called --serve
  TEST_PREPARE_STATUS=0 TEST_PATHS_STATUS=3
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 3 ]
  assert_not_called --serve
}

@test "codebox stops on build and page start failures" {
  TEST_BUILD_STATUS=3
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
  assert_not_called --web-paths
  TEST_BUILD_STATUS=0 TEST_DEPLOY_STATUS=4
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -ne 0 ]
}

@test "codebox reuses the running app without rebuilding" {
  TEST_APP_RUNNING=true
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_not_called '<build>'
  assert_not_called --serve
}

@test "codebox passes npm configuration as a build secret" {
  mkdir -p "$(dirname "$SUITECONTAINER_NPMRC")"
  printf '%s\n' 'registry=https://registry.example.test/' > "$SUITECONTAINER_NPMRC"
  run_launcher setup/bootstrap/start-suitecloud-codebox.sh
  [ "$status" -eq 0 ]
  assert_called "<--secret> <id=npmrc,src=$SUITECONTAINER_NPMRC>"
}
