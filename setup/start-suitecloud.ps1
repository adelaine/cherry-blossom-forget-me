$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectDir 'suitecontainer.config.json'
$credentialsDir = Join-Path $projectDir 'credentials'
$authFile = Join-Path $credentialsDir 'auth.json'
$reposDir = Join-Path $projectDir 'repos'
$nemsDir = if ($env:SUITECONTAINER_NEMS_DIR) { $env:SUITECONTAINER_NEMS_DIR } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }

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

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    $templateFile = Join-Path $projectDir 'suitecontainer.config.example.json'
    if (-not (Test-Path -LiteralPath $templateFile -PathType Leaf)) {
        throw 'Missing suitecontainer.config.example.json. Restore the template and run start-windows.cmd again.'
    }
    Copy-Item -LiteralPath $templateFile -Destination $configFile
    Write-Host 'Created suitecontainer.config.json from the template.'
    Write-Host 'Add your SuiteApps and VMs, then run start-windows.cmd again. Credentials belong in credentials/auth.json.'
    return
}

try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'suitecontainer.config.json is not valid JSON. Update the file and run start-windows.cmd again.'
}
if ($null -eq $config.suiteapps -or $config.suiteapps -isnot [array]) {
    throw 'suitecontainer.config.json needs a "suiteapps" list. Update the file and run start-windows.cmd again.'
}
if ($config.suiteapps.Count -eq 0) {
    Write-Host 'There are no SuiteApps to install in suitecontainer.config.json.'
    return
}

$seenDirectories = @{}
for ($index = 0; $index -lt $config.suiteapps.Count; $index++) {
    $suiteapp = $config.suiteapps[$index]
    $url = $suiteapp.url
    $directory = $suiteapp.directory
    $localPath = $suiteapp.localPath
    $validUrl = $url -is [string] -and (
        $url -match '^git@gitlab\.eng\.netsuite\.com:[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$' -or
        $url -match '^https://gitlab\.eng\.netsuite\.com/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$'
    )
    $validDirectory = $directory -is [string] -and
        $directory -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and
        $directory -notin @('.', '..') -and
        -not $seenDirectories.ContainsKey($directory.ToLowerInvariant())
    if ((-not $validUrl -and [string]::IsNullOrWhiteSpace($localPath)) -or -not $validDirectory) {
        throw "SuiteApp $($index + 1) has an invalid URL or directory. Update suitecontainer.config.json and run start-windows.cmd again."
    }
    if ($null -ne $localPath -and ($localPath -isnot [string] -or $localPath -match '[,\r\n\t]')) {
        throw "SuiteApp $($index + 1) has an invalid localPath. Update suitecontainer.config.json and run start-windows.cmd again."
    }
    if ($null -ne $url -and -not $validUrl) {
        throw "SuiteApp $($index + 1) has an invalid URL. Update suitecontainer.config.json and run start-windows.cmd again."
    }
    if (-not [string]::IsNullOrWhiteSpace($localPath) -and $null -ne $suiteapp.branch) {
        throw "SuiteApp $($index + 1) cannot set both localPath and branch."
    }
    if ($null -ne $suiteapp.branch) {
        $branch = $suiteapp.branch
        $invalidPart = $branch -is [string] -and @($branch.Split('/') | Where-Object { $_.StartsWith('.') -or $_.EndsWith('.') -or $_.EndsWith('.lock') }).Count -gt 0
        if ($branch -isnot [string] -or $branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $branch.Contains('..') -or $branch.Contains('//') -or $invalidPart) {
            throw "SuiteApp $($index + 1) has an invalid branch. Update suitecontainer.config.json and run start-windows.cmd again."
        }
    }
    $seenDirectories[$directory.ToLowerInvariant()] = $true
}

if ($null -eq $config.vms -or $config.vms -isnot [array] -or $config.vms.Count -eq 0) {
    throw 'suitecontainer.config.json needs a nonempty vms list.'
}
foreach ($vm in $config.vms) {
    if ($vm.account -isnot [string] -or $vm.account -notmatch '^[A-Za-z0-9_-]+$' -or
        $vm.url -isnot [string] -or $vm.url -notmatch '^(?:[A-Za-z0-9-]+\.)+netsuite\.com$') {
        throw 'The VM account or domain is invalid. Update suitecontainer.config.json and run start-windows.cmd again.'
    }
}
New-Item -ItemType Directory -Force -Path $credentialsDir | Out-Null
if (-not (Test-Path -LiteralPath $authFile -PathType Leaf)) {
    $authTemplate = Join-Path $credentialsDir 'auth.example.json'
    if (-not (Test-Path -LiteralPath $authTemplate -PathType Leaf)) { throw 'Missing credentials/auth.example.json. Restore the template and run the start script again.' }
    Copy-Item -LiteralPath $authTemplate -Destination $authFile
    Write-Host 'Created credentials/auth.json. Set gitlab-token there; supply certificate paths or leave both empty to generate them.'
}
try {
    $auth = Get-Content -LiteralPath $authFile -Raw | ConvertFrom-Json -ErrorAction Stop
} catch { throw 'credentials/auth.json is not valid JSON. Update the file and run the start script again.' }
$publicCertificate = $auth.'suitecloud-certificates'.public
$privateCertificate = $auth.'suitecloud-certificates'.private
$generateCertificates = [string]::IsNullOrWhiteSpace($publicCertificate) -and [string]::IsNullOrWhiteSpace($privateCertificate)
if (-not $generateCertificates) {
    if ($publicCertificate -isnot [string] -or $privateCertificate -isnot [string] -or
        [string]::IsNullOrWhiteSpace($publicCertificate) -or [string]::IsNullOrWhiteSpace($privateCertificate)) {
        throw 'Specify both public and private certificate paths, or leave both empty to generate certificates.'
    }
}

& (Join-Path $PSScriptRoot 'install-podman-windows.ps1')

New-Item -ItemType Directory -Force -Path $reposDir | Out-Null


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
    $remoteSecrets = @('--secret', "id=npmrc,src=$(ConvertTo-PodmanMachinePath $npmrcFile)")
    $tokenFile = $null
    try {
        if ($env:NSX_NPM_TOKEN) {
            $tokenFile = Join-Path $env:TEMP ("suitecontainer-npm-token-$([guid]::NewGuid().ToString('N'))")
            [IO.File]::WriteAllText($tokenFile, $env:NSX_NPM_TOKEN, [Text.UTF8Encoding]::new($false))
            $remoteSecrets += @('--secret', "id=npm-token,src=$(ConvertTo-PodmanMachinePath $tokenFile)")
        }
        $remoteArgs = @('podman', 'build') + $remoteSecrets + @(
            '-f', (ConvertTo-PodmanMachinePath (Join-Path $PSScriptRoot 'Containerfile')),
            '--build-arg', 'SUITECLOUD_CLI_ACCEPT_LICENSE=true', '-t', 'suitecloud-workspace',
            (ConvertTo-PodmanMachinePath $PSScriptRoot)
        )
        $remoteCommand = ($remoteArgs | ForEach-Object { Quote-PosixArgument $_ }) -join ' '
        & podman machine ssh $wslMachine.Name -- $remoteCommand
    } finally {
        if ($tokenFile -and (Test-Path -LiteralPath $tokenFile)) {
            Remove-Item -LiteralPath $tokenFile -Force
        }
    }
} else {
    & podman build @buildSecrets -f (Join-Path $PSScriptRoot 'Containerfile') --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace $PSScriptRoot
}
if ($LASTEXITCODE -ne 0) { throw 'The container build failed.' }

& podman run --rm --cgroups=disabled `
    --mount "type=bind,src=$configFile,dst=/config/suitecontainer.config.json" `
    --mount "type=bind,src=$credentialsDir,dst=/config/credentials" `
    suitecloud-workspace --prepare-certificates
if ($LASTEXITCODE -eq 10) { return }
if ($LASTEXITCODE -ne 0) { throw 'Certificate preparation failed.' }

$certificatePaths = @(& podman run --rm --cgroups=disabled `
    --mount "type=bind,src=$credentialsDir,dst=/config/credentials,ro=true" `
    --mount "type=bind,src=$configFile,dst=/config/suitecontainer.config.json,ro=true" `
    suitecloud-workspace --certificate-paths)
if ($LASTEXITCODE -ne 0 -or $certificatePaths.Count -ne 2) { throw 'The certificate configuration is invalid.' }
$publicCertificate = $certificatePaths[0]
$privateCertificate = $certificatePaths[1]
if (-not [IO.Path]::IsPathRooted($publicCertificate)) { $publicCertificate = Join-Path $projectDir $publicCertificate }
if (-not [IO.Path]::IsPathRooted($privateCertificate)) { $privateCertificate = Join-Path $projectDir $privateCertificate }
if (-not (Test-Path -LiteralPath $publicCertificate -PathType Leaf) -or
    -not (Test-Path -LiteralPath $privateCertificate -PathType Leaf)) {
    throw 'The certificate files were not found. Update their paths in credentials/auth.json and run start-windows.cmd again.'
}

$mounts = @(
    '--mount', "type=bind,src=$authFile,dst=/config/credentials/auth.json,ro=true",
    '--mount', "type=bind,src=$configFile,dst=/config/suitecontainer.config.json",
    '--mount', "type=bind,src=$reposDir,dst=/workspace",
    '--mount', "type=bind,src=$publicCertificate,dst=/config/certs/public.pem,ro=true",
    '--mount', "type=bind,src=$privateCertificate,dst=/config/certs/private.pem,ro=true"
)

foreach ($suiteapp in $config.suiteapps) {
    if ([string]::IsNullOrWhiteSpace($suiteapp.localPath)) { continue }
    $localPath = $suiteapp.localPath
    if (-not [IO.Path]::IsPathRooted($localPath)) { $localPath = Join-Path $projectDir $localPath }
    $localPath = [IO.Path]::GetFullPath($localPath)
    if (-not (Test-Path -LiteralPath $localPath -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $localPath '.git'))) {
        throw "SuiteApp $($suiteapp.directory) localPath is not a Git checkout: $localPath"
    }
    $mounts += @('--mount', "type=bind,src=$localPath,dst=/workspace/$($suiteapp.directory)")
}

foreach ($name in @('.nems.env', 'config.toml')) {
    $file = Join-Path $nemsDir $name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $mounts += @('--mount', "type=bind,src=$file,dst=/config/$name,ro=true")
    }
}

& podman run --rm -it --cgroups=disabled @mounts suitecloud-workspace --deploy
if ($LASTEXITCODE -ne 0) { throw 'The container stopped with an error.' }
