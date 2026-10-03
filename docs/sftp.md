# Share laptop files with NetSuite over SFTP

Put files in `sftp-files`, beside `repos`. Start SuiteContainer with the usual platform launcher, then run this from `app`:

```sh
npm run sftp
```

SFTP runs inside SuiteContainer. The command opens an SSH tunnel to `nsbuild@vms[0].url`, forwarding runbox `127.0.0.1:8000` to the laptop. Keep the laptop and tunnel running while NetSuite uses the files.

Use these connection details:

- Host: `127.0.0.1`
- Port: `8000`
- Username: `sftp.username` in `credentials/auth.json` (currently `suitecontainer`)
- Password: `sftp.password` in `credentials/auth.json`
- Directory: `/files`

SuiteContainer reads the existing `sftp` settings from `credentials/auth.json`. Set or change `sftp.username`, `sftp.password`, or `sftp.port` and restart SuiteContainer to apply it. If it is missing or empty, the app remains available with SFTP disabled. Credentials are ignored by Git. File access is read-only.

## NetSuite

No client certificate or private-key upload is required. For an SFTP connection form, select password authentication and enter the password. For SuiteScript `N/sftp`, store the password as an API Secret and use its script ID in `secret`, or use a credential field's `passwordGuid`. `N/sftp` does not accept a plaintext password parameter. See [NetSuite's connection API](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4617005472.html).

The server host key is still required to verify the SFTP server. The tunnel command writes it and the other public settings to `credentials/sftp/connection.json`:

```js
const connection = sftp.createConnection({
    username: 'suitecontainer',
    url: '127.0.0.1',
    port: 8000,
    directory: '/files',
    secret: 'YOUR_PASSWORD_API_SECRET_ID',
    hostKeyType: 'rsa',
    hostKey: 'BASE64_HOST_KEY_FROM_CONNECTION_JSON'
});
const entries = connection.list({ path: '.' });
```

Enable `SUITE_SCRIPT_SFTP_ALLOW_INTERNAL_IPS` on the runbox for SuiteScript access to localhost. The listener remains on loopback, preserving `GatewayPorts no`; the launcher does not change SSH, firewall, Banyan, or canary settings. A normal VM-name connection cannot reach a loopback-only listener. Port 8000 carries SSH/SFTP traffic, not HTTP.

Ctrl+C closes the tunnel and SuiteContainer returns to its normal inactivity timeout. Use `npm run sftp -- --help` for another runbox, port, or SSH identity.


