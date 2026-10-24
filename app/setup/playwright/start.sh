#!/bin/sh
set -eu

if [ -f /run/playwright/ca.pem ]; then
  export NODE_EXTRA_CA_CERTS=/run/playwright/ca.pem
fi
if [ -f /run/playwright/npmrc ]; then
  export NPM_CONFIG_USERCONFIG=/run/playwright/npmrc
fi
export npm_config_store_dir=/pnpm/store
mkdir -p /pnpm/store

if [ "${SUITECONTAINER_PLAYWRIGHT_BROWSER:-container}" = local-chrome ]; then
  mkdir -p /run/sshd /run/suitecontainer-playwright-ssh
  chmod 700 /run/suitecontainer-playwright-ssh
  cp /run/playwright/ssh/ssh_host_ed25519_key /run/suitecontainer-playwright-ssh/ssh_host_ed25519_key
  cp /run/playwright/ssh/authorized_keys /run/suitecontainer-playwright-ssh/authorized_keys
  chmod 600 /run/suitecontainer-playwright-ssh/*
  /usr/sbin/sshd -f /opt/suitecontainer-playwright/sshd_config
fi

exec node /opt/suitecontainer-playwright/server.mjs
