#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' oauth2 ;;
  *Password*) cat /tmp/suitecloud-gitlab-token ;;
  *) exit 1 ;;
esac
