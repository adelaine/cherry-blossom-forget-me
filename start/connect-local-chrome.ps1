param([ValidateRange(1, 65535)][int]$LocalPort = 9222)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runners = @(podman ps --filter "label=suitecontainer.project=$projectRoot" --filter 'name=-playwright$' --format '{{.Names}}')
if ($LASTEXITCODE -ne 0) { throw 'Could not list containers. Check the Podman connection.' }
if ($runners.Count -ne 1) { throw 'Expected one running Playwright container for this repository. Relaunch SuiteContainer with --playwright-browser=local-chrome.' }
$runner = $runners[0]
$runnerJson = podman inspect $runner
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the Playwright container.' }
$runnerInfo = @($runnerJson | ConvertFrom-Json)[0]
$fingerprint = $runnerInfo.Config.Labels.'suitecontainer.playwright.config'
$sshDir = (Join-Path $projectRoot "home/.cache/playwright/$fingerprint/ssh").Replace('\', '/')
$sshAddress = podman port $runner 2222/tcp
if ($LASTEXITCODE -ne 0 -or "$sshAddress".Trim() -notmatch '^127\.0\.0\.1:(\d+)$') {
    throw 'The runner SSH port is unavailable. Select Local Chrome and relaunch SuiteContainer.'
}
$sshPort = $Matches[1]

Write-Host "Opening the SSH connection to $runner. Leave this terminal open; press Ctrl+C to disconnect."
ssh -F none -N -T -p $sshPort -i "$sshDir/id_ed25519" `
    -o BatchMode=yes -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes `
    -o StrictHostKeyChecking=yes -o HostKeyAlias=suitecontainer-playwright `
    -o "UserKnownHostsFile=$sshDir/known_hosts" `
    -o GlobalKnownHostsFile=none `
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
    -R "127.0.0.1:9222:127.0.0.1:$LocalPort" root@127.0.0.1
exit $LASTEXITCODE
