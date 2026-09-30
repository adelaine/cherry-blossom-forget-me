$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectDir 'suiteapps-to-install.json'
$reposDir = Join-Path $projectDir 'repos'
$nemsDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    throw 'Missing suiteapps-to-install.json. Update the JSON file and run start-windows.cmd again.'
}

try {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw 'suiteapps-to-install.json is not valid JSON. Update the file and run start-windows.cmd again.'
}
if ($null -eq $config.suiteapps -or $config.suiteapps -isnot [array]) {
    throw 'suiteapps-to-install.json needs a "suiteapps" list. Update the file and run start-windows.cmd again.'
}
if ($config.suiteapps.Count -eq 0) {
    Write-Host 'There are no SuiteApps to install in suiteapps-to-install.json.'
    return
}

$seenDirectories = @{}
for ($index = 0; $index -lt $config.suiteapps.Count; $index++) {
    $suiteapp = $config.suiteapps[$index]
    $url = $suiteapp.url
    $directory = $suiteapp.directory
    $validUrl = $url -is [string] -and (
        $url -match '^git@gitlab\.eng\.netsuite\.com:[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$' -or
        $url -match '^https://gitlab\.eng\.netsuite\.com/[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+$'
    )
    $validDirectory = $directory -is [string] -and
        $directory -match '^[A-Za-z0-9][A-Za-z0-9._-]*$' -and
        $directory -notin @('.', '..') -and
        -not $seenDirectories.ContainsKey($directory.ToLowerInvariant())
    if (-not $validUrl -or -not $validDirectory) {
        throw "SuiteApp $($index + 1) has an invalid URL or directory. Update suiteapps-to-install.json and run start-windows.cmd again."
    }
    if ($null -ne $suiteapp.branch) {
        $branch = $suiteapp.branch
        $invalidPart = $branch -is [string] -and @($branch.Split('/') | Where-Object { $_.StartsWith('.') -or $_.EndsWith('.') -or $_.EndsWith('.lock') }).Count -gt 0
        if ($branch -isnot [string] -or $branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $branch.Contains('..') -or $branch.Contains('//') -or $invalidPart) {
            throw "SuiteApp $($index + 1) has an invalid branch. Update suiteapps-to-install.json and run start-windows.cmd again."
        }
    }
    $seenDirectories[$directory.ToLowerInvariant()] = $true
}

if ($config.runbox.account -isnot [string] -or $config.runbox.account -notmatch '^[A-Za-z0-9_-]+$' -or
    $config.runbox.url -isnot [string] -or $config.runbox.url -notmatch '^[A-Za-z0-9.-]+\.netsuite\.com$' -or
    $config.certificates.id -isnot [string] -or $config.certificates.id -notmatch '^[A-Za-z0-9_-]+$') {
    throw 'The runbox account, domain, or certificate ID is invalid. Update suiteapps-to-install.json and run start-windows.cmd again.'
}
$publicCertificate = $config.certificates.public
$privateCertificate = $config.certificates.private
if ($publicCertificate -isnot [string] -or $privateCertificate -isnot [string] -or
    -not (Test-Path -LiteralPath $publicCertificate -PathType Leaf) -or
    -not (Test-Path -LiteralPath $privateCertificate -PathType Leaf)) {
    throw 'The certificate files were not found. Update their paths in suiteapps-to-install.json and run start-windows.cmd again.'
}

& (Join-Path $PSScriptRoot 'install-podman-windows.ps1')

New-Item -ItemType Directory -Force -Path $reposDir | Out-Null

& podman image exists suitecloud-workspace
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Read the Oracle Free Use Terms and Conditions before building:'
    Write-Host 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_155929845760.html'
    $answer = Read-Host 'Do you accept these terms? Type yes to continue'
    if ($answer -ne 'yes') { throw 'Build cancelled.' }
}

Write-Host 'Preparing the SuiteCloud container...'
& podman build --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw 'The container build failed.' }

$mounts = @(
    '--mount', "type=bind,src=$configFile,dst=/config/suiteapps-to-install.json",
    '--mount', "type=bind,src=$reposDir,dst=/workspace",
    '--mount', "type=bind,src=$publicCertificate,dst=/config/certs/public.pem,ro=true",
    '--mount', "type=bind,src=$privateCertificate,dst=/config/certs/private.pem,ro=true"
)

foreach ($name in @('.nems.env', 'config.toml')) {
    $file = Join-Path $nemsDir $name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $mounts += @('--mount', "type=bind,src=$file,dst=/config/$name,ro=true")
    }
}

& podman run --rm -it --cgroups=disabled @mounts suitecloud-workspace --deploy
if ($LASTEXITCODE -ne 0) { throw 'The container stopped with an error.' }
