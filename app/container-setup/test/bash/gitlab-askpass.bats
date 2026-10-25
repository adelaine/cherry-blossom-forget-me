#!/usr/bin/env bats
load helpers/fixtures
setup() { setup_fixture; }

@test "askpass supplies OAuth username without accessing a token" {
  run sh "$fixture_root/app/container-setup/gitlab-askpass.sh" 'Username for https://gitlab.example:'
  [ "$status" -eq 0 ]
  [ "$output" = oauth2 ]
}

@test "askpass reads the expected token path through a fake cat" {
  fake_command cat '[[ "$1" == /tmp/suitecloud-gitlab-token ]] || exit 2; echo fixture-token'
  run env PATH="$fixture_path" sh "$fixture_root/app/container-setup/gitlab-askpass.sh" 'Password for https://gitlab.example:'
  [ "$status" -eq 0 ]
  [ "$output" = fixture-token ]
}

@test "askpass propagates token read failures" {
  fake_command cat 'exit 3'
  run env PATH="$fixture_path" sh "$fixture_root/app/container-setup/gitlab-askpass.sh" Password
  [ "$status" -eq 3 ]
}

@test "askpass rejects unknown prompts" {
  run sh "$fixture_root/app/container-setup/gitlab-askpass.sh" Unknown
  [ "$status" -eq 1 ]
  [ -z "$output" ]
}
