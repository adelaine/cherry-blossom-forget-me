# Run SuiteContainer tests in local Chrome

Playwright tests and dependencies run in the container. A Playwright server on
your laptop opens a separate Chrome test window. Standard SSH remote forwarding
connects the container to that server.

This follows [Playwright > Run in Remote Chrome](https://confluence.nsgbu.netsuitecorp.com/spaces/SECP/pages/1329385364/Playwright+Run+in+Remote+Chrome),
with the runner container taking the place of Codebox.

## Prerequisites

- Google Chrome and Node.js/npm installed on the laptop.
- OpenSSH client and `ssh-keygen` available in PowerShell.
- SuiteContainer registry access already configured so project dependencies can install.
- The project's NetSuite login mapping and `.env` configured in its `test-pw` folder.
- Matching Playwright major and minor versions on the laptop and in the project.
  The current ABSI lockfile uses **1.61.0**; the commands below pin that version.

Chrome opens in a separate test profile. Your regular Chrome window is not used.

## 1. Select local Chrome and relaunch SuiteContainer

In the app's Playwright section, select **Local Chrome (separate window)**,
save test settings, and relaunch SuiteContainer with its usual start script.

For ABSI, the settings are:

```json
{
    "enabled": true,
    "project": "absi-nsn/FileCabinet/SuiteApps/com.netsuite.autobankstmtimport/test/test-pw",
    "browser": "local-chrome",
    "testFile": "",
    "workers": 1
}
```

The project is relative to `repos`; it does not use the SuiteApp's `localPath`.
Set **Test file** if you want to run only one file.

The launcher prepares a dedicated SSH key and a pinned SSH host key under the
ignored `.cache` folder. The runner's SSH port is published on laptop localhost.
The SSH account permits remote forwarding to `127.0.0.1:9222` and does not permit
shell or SFTP sessions. No laptop SSH server is required.

## 2. Laptop terminal 1: start the Playwright server

Open PowerShell on the laptop and run:

```powershell
npx --yes playwright@1.61.0 run-server --host 127.0.0.1 --port 9222
```

Leave this terminal running. Chrome opens when a test connects, rather than when
the server starts. No Chrome remote-debugging flags are needed.

## 3. Laptop terminal 2: open the reverse SSH forward

Open another PowerShell terminal in the SuiteContainer repository root:

```powershell
.\connect-local-chrome.ps1
```

The helper finds this repository's runner, generated keys, and published SSH port,
then starts standard SSH remote forwarding. Leave this terminal running too.
After the opening message, a successful SSH connection normally prints nothing.
It forwards port 9222 inside the runner to port 9222 on your laptop.
It should not ask for a password or an unverified host-key confirmation.

## 4. Run tests from the app

Click **Run tests**. Laptop mode supplies:

- `PLAYWRIGHT_REMOTE_WS_ENDPOINT=ws://127.0.0.1:9222/`
- `PW_CHANNEL=chrome`
- Playwright's `--headed` option.

ABSI's `playwright.config.ts` reads `PLAYWRIGHT_REMOTE_WS_ENDPOINT` and supplies
`use.connectOptions.wsEndpoint`. Its normal `pw-utils` fixtures handle the browser.
Test output and reports remain in the project under `build/`.

Other Playwright projects need the same `connectOptions` support in their config.
For example:

```typescript
const value = process.env["PLAYWRIGHT_REMOTE_WS_ENDPOINT"]?.trim();
const endpoint = value
    ? /^wss?:\/\//.test(value) ? value : `ws://${value}`
    : undefined;

// Inside the existing use configuration:
connectOptions: endpoint ? {wsEndpoint: endpoint} : undefined,
channel: process.env["PW_CHANNEL"],
```

## Stop and reconnect

Use **Stop tests** to cancel a run. Keep both laptop terminals open for subsequent
runs. Press Ctrl+C in each terminal when you are finished with laptop testing.

After SuiteContainer recreates the runner, repeat step 3 because its published
SSH port or generated key directory may have changed. The old SSH connection
ends when its runner stops.

To run browsers inside the container again, select **Container browser**, save,
and relaunch SuiteContainer.

## Troubleshooting

- **Version mismatch:** find the Playwright container name with `podman ps`, then run
  `podman exec --workdir /workspace/absi-nsn/FileCabinet/SuiteApps/com.netsuite.autobankstmtimport/test/test-pw <runner-name> pnpm exec playwright --version`.
  Restart terminal 1 using that exact version.
- **Connection refused / no Chrome window:** confirm the Playwright server and
  SSH terminal are still running, and Local Chrome is selected in the app.
- **Remote port forwarding failed:** close the previous SSH forward before
  opening another. The runner reserves its loopback port 9222 for this connection.
- **Laptop port 9222 is occupied:** use a different server port, such as
  `--port 9223`, and connect with `.\connect-local-chrome.ps1 -LocalPort 9223`.
- **SSH key rejected:** rerun the normal SuiteContainer launcher to prepare its
  key permissions, then repeat step 3. Do not disable strict host-key checking.
- **Browser connects but NetSuite login fails:** check the project's login
  mapping, account ID and target hostname. The remote browser connection does not
  supply NetSuite user credentials.

Completed output lines appear as the app polls the runner. Partial lines may stay
buffered until more output arrives so credentials split across writes remain redacted.
