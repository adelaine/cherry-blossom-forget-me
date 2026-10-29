# SuiteContainer instructions

SuiteContainer runs the SuiteCloud CLI inside a Podman container and provides a browser interface for credentials, configuration, deployment, SQL, and SFTP.

The computer or **codebox** runs the container. A **deployment scrumbox**, listed under `vms`, is a NetSuite deployment target.

## Starting the app

Run the launcher for your platform from `start/`: [Windows](../../start/start-windows.cmd), [macOS](../../start/start-macos.command), or [codebox](../../start/start-codebox). The launcher first tries the internal base image and falls back to Oracle’s public `ghcr.io/oracle/oraclelinux9-nodejs:24` image if the internal image cannot be pulled. Package downloads use your existing npm configuration and may still require internal registry access. Copying SuiteApps from GitLab needs GitLab access. Deployment needs access to your scrumboxes.

When application source files are unavailable, copy the shared image archive to `home/container-image/suitecontainer-workspace.tar` before launching. The launcher loads it into Podman automatically if the image is missing. The archive is not included in Git or the team ZIP. Use an image built for the recipient's computer architecture. SuiteApps with an explicit `localPath` can be used without GitLab access.

### npm registry fallback

The lockfile uses npmjs.org URLs so npm can substitute your configured registry. To prefer the internal registry, set `registry=https://repository.eng.netsuite.com/3/repository/npm-stable/` in your npm user configuration. The launcher uses that registry first.

Public fallback is off by default. Set `SUITECONTAINER_NPM_PUBLIC_FALLBACK=1` before launching to allow one retry of locked application dependencies against npmjs.org after a connection, certificate, invalid archive, missing package, or server error. The launcher reports when it switches registries. Authentication, permission, rate limit, and integrity errors stop the installation. Versions and integrity hashes remain fixed, and every locked dependency must have an npmjs.org URL and an integrity hash for fallback to proceed. Public retries use empty user and global npm configuration files, omit forwarded npm settings and the internal token, and override scoped registries for locked packages.

For example, on macOS, run this from the installation folder after configuring the internal registry:

```sh
SUITECONTAINER_NPM_PUBLIC_FALLBACK=1 ./start/start-macos.command
```

The setting applies to container builds and development dependency refreshes. Global SuiteCloud CLI installation continues to use the configured registry without public fallback. Leave the setting unset when testing internal registry access so a public retry cannot hide a failure.

### Launcher behavior

On first launch, the launcher downloads a private Python runtime for Windows x64, Apple Silicon macOS, or Linux x64. You do not need to install Python or Node on the host. Intel Macs and Windows ARM computers are not supported by these launchers.

The first launch needs HTTPS access to GitHub release downloads. The launcher verifies the pinned SHA-256 checksum before extracting Python into `app/.cache/python` inside the installation. Later launches reuse that runtime without downloading it again. A pinned runtime update downloads the new version on its next launch. Cached runtimes are Git-ignored and remain outside the container build.

Team distribution ZIPs contain one platform's launcher, download metadata, shared application source, and example settings. Personal settings, credentials, repositories, and cached files are excluded. Extract the entire ZIP before running its launcher. If the download fails or its checksum does not match, check network/proxy access and VPN/Banyan sign-in, then retry.

The launcher prepares local configuration files, installs Podman when needed, builds the container image, and starts the deployment page. If the app is already running, the launcher reopens it without rebuilding.

On a remote codebox, follow the SSH port-forwarding instructions printed by the launcher, then open the displayed deployment URL on your computer. The app's port is bound to the host's loopback address.

Starting the app does not deploy anything. Deployment begins when you click **Deploy**.

## SuiteCloud authentication

SuiteContainer uses browser authentication by default. Set your VM domain and account, then open **SuiteCloud Authentication** and click **Sign in with browser**. Complete the NetSuite login and select the account and role. The saved sign-in and its encryption passkey are stored privately under `home/credentials/` and survive container replacement. Sign in again when authorization expires or the SuiteCloud SDK version changes.

The launcher publishes the browser callback on host loopback port **52300**. On a remote codebox, forward that port as well as the application port using the launcher's printed SSH command.

To use certificates, select **Use certificates instead**, expand **Certificates**, and follow the registration steps below. Click **Save credentials** to save your authentication method.

## Certificate registration

1. Set **Current VM** to your scrumbox domain, without `https://` or `/devhome`.
2. Enter a GitLab token if you use remote repositories. Configurations using only local checkouts do not need a GitLab token.
3. Supply both existing certificate paths, or click **Generate certificates**.
4. Download the public certificate and register it on the target scrumbox under **Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup**. Select SuiteCloud Development Integration and the appropriate entity and role.
5. Enter the certificate ID assigned by NetSuite and click **Save credentials**.

Credentials are stored separately from deployment settings:

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `home/credentials/auth.json`   | GitLab token, certificate paths, and NetSuite certificate ID |
| `home/credentials/public.pem`  | Public certificate generated by the app                      |
| `home/credentials/private.pem` | Matching private key generated by the app                    |

The launcher creates `home/credentials/auth.json` from `app/container-setup/config-example/auth.example.json`. When the saved token is empty, it can import an existing GitLab token from supported `.codex/config.toml` or `.nems.env` files on the host.

Existing certificates can remain outside this repository. Set both certificate paths and their assigned NetSuite certificate ID. Paths refer to files on the computer running the launcher.

Generating a replacement pair replaces certificates generated by this app and clears the saved certificate ID. Register the replacement public certificate before deploying again. Files stored elsewhere are not changed.

Local configuration, authentication settings, and certificate files are Git-ignored. Keep the private key on the computer running the launcher.

## Configuration

`home/config/suitecontainer.json` holds the SuiteApps, deployment targets, database defaults, and interface preferences. When that file is absent, the launcher automatically migrates an existing `home/suitecontainer.config.json`. If neither file exists, it creates the configuration from `app/container-setup/config-example/suitecontainer.example.json`.

Inside the container, the configuration is available at `/config/suitecontainer.json`, and the example templates are under `/config-example`. Credentials remain in `home/credentials/` on the host.

Example:

```json
{
	"suiteapps": [
		{
			"url": "https://gitlab.eng.netsuite.com/erpsuiteapps-prod/cash-management/bsp-nsn.git",
			"directory": "bsp-nsn",
			"branch": "develop"
		}
	],
	"vms": [
		{
			"url": "your-scrumbox.vm.eng.netsuite.com",
			"account": "000071",
			"database": {
				"user": "shared",
				"service": "singletonpdb"
			}
		}
	]
}
```

- `directory` identifies the SuiteApp's workspace folder and must be unique.
- `url` identifies a repository on `gitlab.eng.netsuite.com`.
- `branch` is optional for remote repositories. With a branch specified, an existing clone is fetched, checked out to that branch, and updated with a fast-forward pull.
- `account` is the NetSuite account ID; `url` in a VM entry is its scrumbox domain.
- **Current VM** edits the first entry in `vms`. Deployment uses every listed entry.
- `database.user` and `database.service` prepopulate the SQL connection fields.

### Using a local checkout

Set `localPath` to an existing Git checkout on the computer running the launcher:

```json
{
	"directory": "bsp-nsn",
	"localPath": "C:/webdev/bsp-nsn"
}
```

Relative data paths are resolved from the SuiteContainer `home/` folder. Cloned SuiteApps are stored in `home/repos/`. The checkout must contain `.git`, `manifest.xml`, and `deploy.xml`.

The app uses the checkout's current branch and working files without cloning, switching branches, or pulling updates. The SuiteCloud CLI can write project configuration files into that checkout.

Adding or changing external checkout or certificate paths may require stopping the app and relaunching it to refresh its mounts.

## Deployment

Review the SuiteApps and targets in **Settings**, then click **Deploy**. Deployment saves the settings shown in the editor before starting.

Deployment processes the VMs in order and, within each VM, the SuiteApps in order. Each SuiteApp runs a SuiteCloud deployment preview before the actual deployment.

Progress, warnings, and errors appear in the deployment output. If deployment fails, correct the reported issue and retry. Earlier successful deployments are not rolled back automatically.

The existing workspace command also accepts `--deploy` while SuiteContainer is running. It uses the saved settings and deploys all configured targets through the authenticated API. Add `--target <id>` to select one target using its ID from `/api/targets`. The command prints deployment output and exits when the operation completes. It does not save configuration changes.

If the command loses its connection or you interrupt it, deployment may continue. Check the operation in SuiteContainer before starting another deployment. The command never automatically resubmits a deployment.

After a deployment starts, Credentials, Settings, SQL, and SFTP collapse. You can reopen them whenever needed. When all four are collapsed, they appear horizontally on wider screens.

## SQL

The SQL section connects to **Current VM** using Oracle SQL*Plus. Enter the database user, service name, and either a manual password or the answer that unlocks a saved encrypted password. Entering one clears the other.

End SQL statements with a semicolon. End PL/SQL blocks with `/` on its own line.

SQL runs separately from SuiteCloud authentication. Uncommitted changes are rolled back when the session exits; explicit commits and Oracle implicit commits remain committed. SQL execution times out after 60 seconds.

Deployment and SQL operations cannot run concurrently.

## SFTP

SFTP uses the first target in `vms`. Open **SFTP**, enter a username and password under **SFTP settings**, and click **Start SFTP**. The default port is `8000`. The supported port range is `1024–65535`. A blank password field keeps the saved password. The app stores these settings separately in `home/credentials/auth.json`.

### Sharing files from Windows or macOS

The SFTP server runs inside SuiteContainer. An SSH tunnel forwards the configured port on the deployment scrumbox's loopback address to this server. Leave the local folder field blank to share `home/sftp-files` beside `home/repos`, or enter an absolute path to another folder. File access is read-only. Changing the folder requires stopping the app and relaunching it to refresh its mounts.

The launcher detects the host's SSH settings for `nsbuild@vms[0].url` and mounts the available key files read-only. For local file sharing, SuiteContainer saves the scrumbox SSH host key in `home/credentials/sftp/known_hosts`. If that key changes, SuiteContainer replaces its saved entry and retries the tunnel once. This automatic replacement is intended for controlled environments where scrumboxes are periodically redeployed. At least one SSH key must work without a passphrase. Host SSH agents, hardware keys, jump hosts, and proxy commands are not supported in this mode. After changing SSH configuration or Current VM, stop the app and relaunch it to refresh the detected settings.

Keep the computer and SuiteContainer running while NetSuite uses the shared files. **Stop SFTP** closes both the local server and its tunnel. Stop SFTP before changing its settings.

### Running SFTP on a deployment target

When the codebox hostname ends in `.vm.eng.netsuite.com`, SuiteContainer runs SFTP on the deployment target instead of sharing a local folder through a tunnel. The page checks SSH access to the target. **Start SFTP** checks an existing SFTP service with the saved credentials or creates a target-side Podman container when the configured port has no listener.

After access is verified, the page displays an SFTP address for uploading files directly to the target. **Recreate SFTP**, when offered, requires confirmation because replacing the existing container discards files stored inside it. **Stop SFTP** can stop only a target container created by the current app session. Stopping SuiteContainer leaves the target container running.

### NetSuite connection details

Use the **NetSuite connection fields** shown by the page. NetSuite connects to `localhost` on the deployment scrumbox using the configured port, username, password, and SFTP host key. In local sharing mode, the directory is `/files`. In target-side mode, use a directory available to the remote SFTP user.

Starting SFTP saves the public connection settings to `home/credentials/sftp/connection.json`. The local sharing server's host key persists under `home/credentials/sftp/host-keys`. Internal SFTP addresses must be allowed on the deployment scrumbox. The SFTP port carries SSH/SFTP traffic, not HTTP.

## Appearance and saved preferences

The theme switch saves `"light"` or `"dark"` in `status.theme`. If that property is absent, the page follows the system theme. Output panels use a pale background in light mode and black in dark mode.

The app sets `status.deploy-start-ok` to `1` when deployment is accepted, so the setup sections remain collapsed when the page is reopened. This records that deployment started, not that it succeeded.

## Stopping and restarting

Use **Stop SuiteContainer** when no deployment or SQL operation is running. The app also stops after 15 minutes without user activity. Running deployment and SQL jobs, running local SFTP, and active target-side SFTP operations prevent automatic shutdown. A target-side SFTP container can remain running after the app stops.

Settings, credentials, certificates, and repository files persist on the host. The stopped app container remains until the next launch replaces it. Temporary helper containers are removed automatically, while the built image and build cache remain available.

To use application code changes, stop the app and run the launcher again so it rebuilds the image.

## Troubleshooting

| Message or problem           | Action                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| Deployment is unavailable    | Review the validation message and complete the missing settings or credentials.    |
| Relaunch required            | Save your changes, stop the app, and run the launcher again to refresh its mounts. |
| Connection lost              | Run the launcher again to reopen the app.                                          |
| Registry or npm login errors | Reconnect or sign in to the required network service, then retry.                  |
| Deployment failed            | Review the output, correct the reported issue, and retry.                          |
| SQL*Plus is unavailable      | Stop the app and relaunch it to rebuild the container.                             |
