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

exec node /opt/suitecontainer-playwright/server.mjs
