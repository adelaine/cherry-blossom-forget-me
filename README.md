# SuiteContainer quickstart

Deploy NetSuite SuiteApps through a browser interface backed by Podman and the SuiteCloud CLI.

1. Run the launcher for your platform from this folder:

   | Platform | Launcher |
   |---|---|
   | Windows | Double-click `start-windows.cmd` |
   | macOS | Open `start-macos.command` |
   | Codebox | Run `bash start-codebox` |

2. Open the deployment page. For a remote codebox, follow the port-forwarding instructions printed by the launcher.
3. Set **Current VM**, complete **Credentials**, and review the SuiteApps and targets in **Settings**.
4. Save your credentials, then click **Deploy** and review the output.

The launcher installs Podman when needed and prepares the app. Starting it does not deploy anything. Use **Stop app** when finished; run the launcher again to reopen it.

See the [detailed instructions](docs/USERMANUAL.md) for certificate registration, configuration examples, local checkouts, tools, and troubleshooting.
