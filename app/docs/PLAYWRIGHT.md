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

## 1. Prepare once, then request the runner

From a source checkout, prepare the workspace and browser runner together:

```shell
bash start/start-codebox --json --prepare-playwright
```

This builds the workspace image from source, then a local runner image containing
pinned Playwright, agent-browser, Chromium, full FFmpeg/ffprobe, Kokoro with Isabella’s voice, browser runtime
libraries, fonts, and package managers. No manual container installations are required. Chromium is the prepared container browser; projects selecting
the branded `chrome` channel need a separately prepared Chrome installation or
the local Chrome mode described below. It reuses cached build layers and does
not download the Microsoft Playwright base image. Preparation can download tools
and browsers. It does not start, stop, or replace a running app or runner.
For an image-only distribution, this explicit step loads
`home/container-image/suitecontainer-playwright.tar` instead.

Ordinary runner startup uses only the prepared local image, with image pulling
disabled. If it is missing, startup explains how to prepare it and leaves existing
containers alone. Re-run preparation explicitly to update the runner image.
SuiteContainer's main application startup behavior is unchanged.

## Browser capture tools

The prepared runner includes agent-browser 0.39.4 from the internal npm registry
and checksum-verified FFmpeg/ffprobe 9.0.2 builds for Linux x64 and ARM64.
Preparation needs access to the configured npm registry, Oracle Linux package
repositories, Chromium downloads, and GitHub FFmpeg release downloads.
The same source workflow applies to codeboxes, Windows, and Apple Silicon Macs.
The pinned monthly FFmpeg release is retained upstream for two years; update the
release, version, and checksums together when maintaining the installer.

agent-browser automatically uses the runner's prepared Chromium and full FFmpeg.
Use a distinct session for each task. Read its installed usage guidance with
`agent-browser skills get core`. Use `record start <video.webm>` and `record stop`
for recordings, then verify the final page and decode the full video with
`ffmpeg -v error -xerror -i <video.webm> -f null -`.
The CLI tools run inside the browser runner; no host browser installation is needed
for container browser mode.

## Offline voiceover

The prepared runner includes Kokoro.js 1.2.1 with the Kokoro-82M v1.0 CPU model
and Isabella (`bf_isabella`, British English) as the default voice.
The quantized model, tokenizer, and Isabella voice are pinned to a model repository
revision and checksum-verified during preparation.
Preparation needs the configured npm registry and Hugging Face download access.
Speech synthesis then runs locally with remote model loading disabled.
Re-run explicit preparation to update an older image.

Inside the runner, `kokoro` is on PATH, `KOKORO_MODEL` identifies the bundled model
directory, and `KOKORO_VOICE` defaults to `bf_isabella`.
Write a UTF-8 narration file, then generate a 24 kHz WAV:

```shell
kokoro --output_file /tmp/narration.wav < /tmp/narration.txt
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 /tmp/narration.wav
```

Use `--speed 1` for normal speaking speed or supply another positive multiplier.
Use `--voice bf_isabella` to choose Isabella explicitly.
Narration is processed sentence by sentence; a sentence exceeding the model’s context
limit is rejected instead of silently truncating the script.

Match recording scenes to the measured narration durations before using the full
FFmpeg to combine the video and voiceover. Preserve the complete actions and narration
when padding or trimming. Verify the final file contains both video and audio and decode
it completely before sharing. Kokoro does not add audio to recordings automatically.
The existing run endpoint continues to execute project tests.
The runtime license and model download provenance are stored under
`/usr/local/share/licenses/suitecontainer-kokoro/` in the image.

## Request the prepared runner

Playwright no longer uses saved project settings. Start the runner explicitly:

```shell
bash start/start-codebox --json --playwright
```

For local Chrome, use the usual platform launcher with
`--playwright-browser=local-chrome` instead. This also requests the runner and
starts its SSH forwarding service. Container mode does not start SSH.
The same options work with the Windows and macOS launchers.
An ordinary relaunch preserves an already requested runner and its browser mode.
Use `--playwright-browser=container` to switch back to browsers inside the container.
These options do not deploy a SuiteApp or run tests.

The runner discovers dependency mounts across the registered checkouts at launch.
Choose the project in each run request. Changing between mounted projects does
not require saving settings or relaunching. A newly added checkout or package
may require a relaunch to refresh its dependency mounts.

The launcher prepares a dedicated SSH key and a pinned SSH host key under the
ignored `home/.cache/playwright` folder. The runner's SSH port is published on laptop localhost.
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
.\start\connect-local-chrome.ps1
```

The helper finds this repository's runner, generated keys, and published SSH port,
then starts standard SSH remote forwarding. Leave this terminal running too.
After the opening message, a successful SSH connection normally prints nothing.
It forwards port 9222 inside the runner to port 9222 on your laptop.
It should not ask for a password or an unverified host-key confirmation.

## 4. Submit a test run

Use the shared API with the verified connection descriptor and bearer token.
Submit `POST /api/playwright/run` with an idempotency key and per-run inputs:

```json
{
	"project": "absi-nsn/FileCabinet/SuiteApps/com.netsuite.autobankstmtimport/test/test-pw",
	"targetId": "<ID returned by /api/targets>",
	"testFile": "",
	"workers": 1
}
```

The project is relative to `home/repos`. It must contain the existing Playwright
configuration and lockfile. Omit `testFile` to run the project and `workers` to
use one worker. To select a target independently of saved deployment settings,
provide `host` and `account` instead of `targetId`. No saved configuration is
written by this request. Legacy `config.playwright` values are ignored; callers
must now provide `project` directly.

Follow the returned operation and incremental logs until completion. The app's
Playwright section shows status and output and can stop an active test run.
This endpoint continues to run project tests.

Laptop mode supplies:

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

To run browsers inside the container again, relaunch with
`--playwright-browser=container`.

## Troubleshooting

- **Version mismatch:** find the Playwright container name with `podman ps`, then run
  `podman exec --workdir /workspace/absi-nsn/FileCabinet/SuiteApps/com.netsuite.autobankstmtimport/test/test-pw <runner-name> pnpm exec playwright --version`.
  Restart terminal 1 using that exact version.
- **Connection refused / no Chrome window:** confirm the Playwright server and
  SSH terminal are still running, and the runner was requested with `--playwright-browser=local-chrome`.
- **Remote port forwarding failed:** close the previous SSH forward before
  opening another. The runner reserves its loopback port 9222 for this connection.
- **Laptop port 9222 is occupied:** use a different server port, such as
  `--port 9223`, and connect with `.\start\connect-local-chrome.ps1 -LocalPort 9223`.
- **SSH key rejected:** rerun the normal SuiteContainer launcher to prepare its
  key permissions, then repeat step 3. Do not disable strict host-key checking.
- **Browser connects but NetSuite login fails:** check the project's login
  mapping, account ID and target hostname. The remote browser connection does not
  supply NetSuite user credentials.

Completed output lines appear as the app polls the runner. Partial lines may stay
buffered until more output arrives so credentials split across writes remain redacted.
