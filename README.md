# SuiteCloud setup

1. Run the file for your computer:
   - **Windows:** Double-click `start-windows.cmd`.
   - **macOS:** Open Terminal in this folder and run `bash start-macos.sh`.
   - **Oracle/NetSuite codebox:** Run `bash start-codebox`.

The Windows and macOS scripts install Podman if needed. The codebox script uses the Podman already installed there. Follow any system prompts, then run the same file again if asked to restart. The setup reads the `suiteapps` list in `suiteapps-to-install.json`; edit that file to change the SuiteApps. If the list is empty, the setup says there are no SuiteApps to install. If an entry is invalid, it asks you to update the file and stops. The first build asks you to accept the Oracle terms. If your GitLab token is not in `~/.codex/.nems.env` or `~/.codex/config.toml`, it asks for the token. Your SuiteApps appear in the `repos` folder.
