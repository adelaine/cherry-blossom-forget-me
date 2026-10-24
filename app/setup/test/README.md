# Launcher tests

Run commands from the repository root. The suites use temporary projects and mock
Podman, installers, prompts, and credentials. They do not build containers, install
Podman, or deploy SuiteApps.

## Windows

Install [Pester 5](https://pester.dev/docs/v5/quick-start) once:

```powershell
Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser
```

Run under Windows PowerShell 5.1, matching the Windows launcher:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File app/setup/test/run-powershell.ps1
```

The suite covers the PowerShell launcher, Podman machine setup, and batch wrappers.
Batch wrapper checks execute controlled fixture scripts through `cmd.exe`.

## Bash

Install [bats-core](https://bats-core.readthedocs.io/en/stable/installation.html).
On macOS, use `brew install bats-core`. Run the suite on macOS and Linux:

```sh
bash app/setup/test/run-bash.sh
```

The suite covers macOS and codebox launchers, the macOS Podman installer, and the
POSIX askpass helper. Fake executables on `PATH` capture commands and simulate
failures. `SUITECONTAINER_NEMS_DIR` points credential discovery at the fixtures.

Both runners can also use local framework copies under `app/.cache/test-tools`:
Pester 5.7.1 and bats-core 1.12.0. This cache is ignored by Git.

## TypeScript

The application source is under `app/engine/`. Run its checks in an isolated
Linux/Node test container with the engine mounted at `/app`:

```sh
cd /app
npm test
```

These tests use Node's existing test runner. The certificate integration test needs
OpenSSL on `PATH`; it is skipped when OpenSSL is unavailable.
