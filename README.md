# SuiteCloud setup

1. Run the file for your computer:
   - **Windows:** Double-click `start-windows.cmd`.
   - **macOS:** Open Terminal in this folder and run `bash start-macos.sh`.
   - **Oracle/NetSuite runbox:** Run `bash start-runbox`.

The Windows and macOS scripts install Podman if needed. The runbox script uses the Podman already installed there. Follow any system prompts, then run the same file again if asked to restart. The first run asks for your three GitLab links and saves them in `suiteapps-to-install.json`. It also asks you to accept the Oracle terms before building. If your GitLab token is not in `~/.codex/.nems.env` or `~/.codex/config.toml`, it asks for the token. Your repositories appear in the `repos` folder.
