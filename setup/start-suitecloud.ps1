$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $projectDir 'suiteapps-to-install.json'
$reposDir = Join-Path $projectDir 'repos'
$nemsDir = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex'

if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) {
    throw 'Missing suiteapps-to-install.json.'
}
if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    & (Join-Path $PSScriptRoot 'install-podman-windows.ps1')
}
& podman info --format '{{.Host.Arch}}' *> $null
if ($LASTEXITCODE -ne 0) {
    $machines = & podman machine list --format '{{.Name}}'
    if ($LASTEXITCODE -ne 0) { throw 'Could not check the Podman machine.' }
    if (-not $machines) {
        & podman machine init
        if ($LASTEXITCODE -ne 0) { throw 'Could not set up the Podman machine.' }
    }
    & podman machine start
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the Podman machine.' }
}

New-Item -ItemType Directory -Force -Path $reposDir | Out-Null

& podman image exists suitecloud-workspace
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Read the Oracle Free Use Terms and Conditions before building:'
    Write-Host 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_155929845760.html'
    $answer = Read-Host 'Do you accept these terms? Type yes to continue'
    if ($answer -ne 'yes') { throw 'Build cancelled.' }
    & podman build --build-arg SUITECLOUD_CLI_ACCEPT_LICENSE=true -t suitecloud-workspace $PSScriptRoot
    if ($LASTEXITCODE -ne 0) { throw 'The container build failed.' }
}

$mounts = @(
    '--mount', "type=bind,src=$configFile,dst=/config/suiteapps-to-install.json",
    '--mount', "type=bind,src=$reposDir,dst=/workspace"
)

foreach ($name in @('.nems.env', 'config.toml')) {
    $file = Join-Path $nemsDir $name
    if (Test-Path -LiteralPath $file -PathType Leaf) {
        $mounts += @('--mount', "type=bind,src=$file,dst=/config/$name,ro=true")
    }
}

& podman run --rm -it @mounts suitecloud-workspace
if ($LASTEXITCODE -ne 0) { throw 'The container stopped with an error.' }
