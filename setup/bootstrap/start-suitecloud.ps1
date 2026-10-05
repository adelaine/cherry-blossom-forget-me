$ErrorActionPreference = 'Stop'

$setupDir = Split-Path -Parent $PSScriptRoot
$projectDir = Split-Path -Parent $setupDir
$nemsDir = if ($env:SUITECONTAINER_NEMS_DIR) { $env:SUITECONTAINER_NEMS_DIR } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }
& (Join-Path $PSScriptRoot 'bootstrap-host.ps1') -ProjectDir $projectDir -NemsDir $nemsDir
. (Join-Path $PSScriptRoot 'web-host.ps1')
$projectHash = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($projectHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 16).ToLowerInvariant() }
finally { $projectHash.Dispose() }
$script:containerName = "suitecontainer-$hash"

function ConvertTo-PodmanMachinePath([string]$path) {
    $fullPath = [IO.Path]::GetFullPath($path)
    if ($fullPath -notmatch '^([A-Za-z]):[\\/](.*)$') {
        throw "Podman's WSL machine cannot access this Windows path: $fullPath"
    }
    return "/mnt/$($Matches[1].ToLowerInvariant())/$($Matches[2].Replace('\', '/'))"
}

function Quote-PosixArgument([string]$value) {
    $quote = [string][char]39
    return $quote + $value.Replace($quote, $quote + '"' + $quote + '"' + $quote) + $quote
}

function Export-WindowsRootCertificates([string]$destination) {
    $certificates = Get-ChildItem Cert:\CurrentUser\Root, Cert:\LocalMachine\Root |
        Sort-Object -Property Thumbprint -Unique
    $pem = foreach ($certificate in $certificates) {
        '-----BEGIN CERTIFICATE-----'
        [Convert]::ToBase64String($certificate.RawData, [Base64FormattingOptions]::InsertLineBreaks)
        '-----END CERTIFICATE-----'
    }
    [IO.File]::WriteAllText($destination, ($pem -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
}

& (Join-Path $setupDir 'installers/install-podman-windows.ps1')

$machineJson = (& podman machine list --format json) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Could not check the Podman machine.' }

if ($machineJson.Trim() -eq '[]') {
    Write-Host 'Setting up and starting the Podman machine...'
    & podman machine init --now
    if ($LASTEXITCODE -ne 0) { throw 'Could not set up the Podman machine. A Windows restart may be needed.' }
} else {
    $machines = ConvertFrom-Json -InputObject $machineJson
    if (-not ($machines | Where-Object Running | Select-Object -First 1)) {
        $machine = $machines | Where-Object Default | Select-Object -First 1
        if (-not $machine) { $machine = $machines | Select-Object -First 1 }
        Write-Host 'Starting the Podman machine...'
        & podman machine start $machine.Name
        if ($LASTEXITCODE -ne 0) { throw 'Could not start the Podman machine.' }
    }
}

$runningApp = (Invoke-SuiteContainerQuiet inspect --format '{{.State.Running}}' $script:containerName) -join ''
if ($runningApp -eq 'true') { Confirm-SuiteContainerOwner; Open-SuiteContainerPage; return }

& podman image exists suitecloud-workspace
if ($LASTEXITCODE -eq 0) {
    Start-SuiteContainerWeb
    return
}

$pmMode = $true
try {
    $settings = Get-Content -LiteralPath (Join-Path $projectDir 'suitecontainer.config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $auth = Get-Content -LiteralPath (Join-Path $projectDir 'credentials/auth.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $pmMode = $settings.PM_MODE -eq $true -or -not ([string]$auth.'gitlab-token').Trim()
} catch { # The page reports malformed settings and credentials.
}
if ($pmMode) {
    throw 'Load the shared suitecloud-workspace image with podman load -i <archive-path>, then run the launcher again.'
}

# Make the host npm credentials available only during dependency installation.
$npmrcFile = if ($env:SUITECONTAINER_NPMRC) { $env:SUITECONTAINER_NPMRC }
    elseif ($env:NPM_CONFIG_USERCONFIG) { $env:NPM_CONFIG_USERCONFIG }
    else { Join-Path $HOME '.npmrc' }
$buildSecrets = @()
if (Test-Path -LiteralPath $npmrcFile -PathType Leaf) {
    $buildSecrets = @('--secret', "id=npmrc,src=$npmrcFile")
    if ($env:NSX_NPM_TOKEN) {
        $buildSecrets += @('--secret', 'id=npm-token,env=NSX_NPM_TOKEN,type=env')
    }
}

Write-Host 'Preparing the SuiteCloud container...'
$caFile = Join-Path $env:TEMP ("suitecontainer-npm-ca-$([guid]::NewGuid().ToString('N')).pem")
try {
Export-WindowsRootCertificates $caFile
$buildSecrets += @('--secret', "id=npm-ca,src=$caFile")
$wslMachine = $null
if ($buildSecrets.Count -gt 0) {
    $machineJson = (& podman machine list --format json) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the Podman machine.' }
    $machines = if ($machineJson.Trim()) { @(ConvertFrom-Json -InputObject $machineJson) } else { @() }
    $wslMachine = $machines | Where-Object { $_.Default -and $_.Running -and $_.VMType -eq 'wsl' } | Select-Object -First 1
}
if ($wslMachine) {
    # The Windows remote client currently builds secret temp-file paths with mixed separators.
    # Build inside the WSL machine, where the same host files are mounted under /mnt/<drive>.
    $remoteSecrets = @('--secret', "id=npm-ca,src=$(ConvertTo-PodmanMachinePath $caFile)")
    if (Test-Path -LiteralPath $npmrcFile -PathType Leaf) {
        $remoteSecrets += @('--secret', "id=npmrc,src=$(ConvertTo-PodmanMachinePath $npmrcFile)")
    }
    $tokenFile = $null
    try {
        if ($env:NSX_NPM_TOKEN) {
            $tokenFile = Join-Path $env:TEMP ("suitecontainer-npm-token-$([guid]::NewGuid().ToString('N'))")
            [IO.File]::WriteAllText($tokenFile, $env:NSX_NPM_TOKEN, [Text.UTF8Encoding]::new($false))
            $remoteSecrets += @('--secret', "id=npm-token,src=$(ConvertTo-PodmanMachinePath $tokenFile)")
        }
        $remoteArgs = @('podman', 'build') + $remoteSecrets + @(
            '-f', (ConvertTo-PodmanMachinePath (Join-Path $setupDir 'Containerfile')),
            '--ignorefile', (ConvertTo-PodmanMachinePath (Join-Path $setupDir '.containerignore')),
            '--build-arg', 'SUITECLOUD_CLI_ACCEPT_LICENSE=true', '-t', 'suitecloud-workspace',
            (ConvertTo-PodmanMachinePath $projectDir)
        )
        $remoteCommand = ($remoteArgs | ForEach-Object { Quote-PosixArgument $_ }) -join ' '
        & podman machine ssh $wslMachine.Name -- $remoteCommand
    } finally {
        if ($tokenFile -and (Test-Path -LiteralPath $tokenFile)) {
            Remove-Item -LiteralPath $tokenFile -Force
        }
    }
} else {
    & podman build @buildSecrets -f (Join-Path $setupDir 'Containerfile') --ignorefile (Join-Path $setupDir '.containerignore') --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace $projectDir
}
if ($LASTEXITCODE -ne 0) { throw 'The container build failed.' }
} finally {
    if (Test-Path -LiteralPath $caFile) {
        Remove-Item -LiteralPath $caFile -Force
    }
}

Start-SuiteContainerWeb
