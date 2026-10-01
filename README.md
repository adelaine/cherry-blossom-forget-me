# SuiteCloud setup

Run the file for your computer:

### Windows

- Double-click `start-windows.cmd`.

### macOS

- Open Terminal in this folder and run `bash start-macos.sh`.

### Codebox

- Run `bash start-codebox`.

<br>
<br>

-----

### Overview

This script automatically validates for requirements of suiteapp deployment via suitecloud cli and will guide the user on manual steps if needed.

#### Settings:
- `suitecontainer.config.json` contains the list of suiteapps to be installed and the list of credentials required for suiteapp deployment.

#### Gitlab token
- Read from `.codex/config.toml` or `.nems.env` if the user already has them set.
- Asks the user to input the token if not found.

#### Certificates
- Reads from `suitecontainer.config.json` if the user already has them.
- Generates new certificates if none are found. These new certificates will need to be set up on the target runbox.

#### Podman:
- For Windows and macOS, Podman will be installed if needed.
- For codebox, Podman is already installed by default.

### Installer steps

Explanation TBD

### Container Cleanup

No routine container cleanup is needed. The launchers use --rm, which removes each container after it exits.
The credentials have different lifetimes:
- Certificates in root .ssh/: Persist on the host and are reused. They aren’t deleted each run.
- Temporary GitLab token file: Deleted in the install flow’s finally block.
- SuiteCloud authentication data stored inside the container: Disappears with the container.
- SuiteCloud encryption passkey: Generated fresh for each deployment run.
The built image and build cache remain on disk, but generated certificates are excluded from the image.