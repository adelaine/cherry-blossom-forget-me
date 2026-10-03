# Share laptop files with NetSuite over SFTP

Leave the local folder field blank to use `sftp-files`, beside `repos`, or enter an absolute path to another folder. Start SuiteContainer with the usual platform launcher, then open the SFTP article after SQL and select **Start SFTP**. SFTP does not start automatically. **Stop SFTP** closes both the server and its tunnel.

Both run inside SuiteContainer. On Windows and macOS, the launcher asks your laptop's OpenSSH client to resolve the settings for `nsbuild@vms[0].url` using `ssh -G`. This evaluates your SSH configuration, including matching `Host`, `Match`, and `Include` rules. It detects the effective hostname, SSH port, identity files, host-key alias, certificates, and known-hosts files, then mounts the available files read-only. You do not need to enter the runbox again or locate SSH files. See [OpenSSH's configuration resolution](https://man.openbsd.org/ssh#G).

Private keys are loaded into an in-container SSH agent without creating private-key copies. At least one detected key must work without a passphrase. Laptop SSH Agent/macOS Keychain integration, hardware keys, jump hosts, and laptop proxy commands are not supported; Start SFTP reports when that setup is required. `ssh -G` discovers candidate keys without proving they can authenticate. Optional `SUITECONTAINER_SSH_KEY` and `SUITECONTAINER_SSH_KNOWN_HOSTS` overrides are still supported.

SSH settings are detected when the launcher creates the app container. After changing the laptop SSH configuration or Current VM, stop the app and relaunch it to detect and mount the new settings.

The tunnel connects to `nsbuild@vms[0].url`, forwarding runbox `localhost:8000` to the SFTP server. Keep the laptop and SuiteContainer running while NetSuite uses the files.

Use these connection details:

- Host: `localhost`
- Port: `8000`
- Username: `sftp.username` in `credentials/auth.json` (currently `suitecontainer`)
- Password: `sftp.password` in `credentials/auth.json`
- Directory: `/files`

SuiteContainer reads and saves `sftp.username`, `sftp.password`, `sftp.port`, and `sftp.path` in `credentials/auth.json`. Stop SFTP before changing settings. A blank password field keeps the saved password. Changing the local folder requires stopping the app and relaunching it so the new folder can be mounted. Credentials are ignored by Git. File access is read-only.

## NetSuite

No client certificate or private-key upload is required. For an SFTP connection form, select password authentication and enter the password. For SuiteScript `N/sftp`, store the password as an API Secret and use its script ID in `secret`, or use a credential field's `passwordGuid`. `N/sftp` does not accept a plaintext password parameter. See [NetSuite's connection API](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4617005472.html).

The server host key is still required to verify the SFTP server. The SFTP article shows the NetSuite connection fields, including the persistent host key. Starting SFTP also writes the public settings to `credentials/sftp/connection.json`:

```js
const connection = sftp.createConnection({
    username: 'suitecontainer',
    url: 'localhost',
    port: 8000,
    directory: '/files',
    secret: 'YOUR_PASSWORD_API_SECRET_ID',
    hostKeyType: 'rsa',
    hostKey: 'BASE64_HOST_KEY_FROM_CONNECTION_JSON'
});
const entries = connection.list({ path: '.' });
```

Enable `SUITE_SCRIPT_SFTP_ALLOW_INTERNAL_IPS` on the runbox for SuiteScript access to localhost. The listener remains on loopback, preserving `GatewayPorts no`; the launcher does not change SSH, firewall, Banyan, or canary settings. A normal VM-name connection cannot reach a loopback-only listener. Port 8000 carries SSH/SFTP traffic, not HTTP.

Stopping SFTP restores SuiteContainer's normal inactivity timeout.


