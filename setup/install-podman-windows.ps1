$ErrorActionPreference = 'Stop'

function Find-Podman {
    $command = Get-Command podman -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }

    $locations = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Podman\podman.exe'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\podman.exe'),
        (Join-Path $env:ProgramFiles 'Podman\podman.exe')
    )
    foreach ($location in $locations) {
        if (Test-Path -LiteralPath $location -PathType Leaf) {
            $env:Path = "$(Split-Path -Parent $location);$env:Path"
            return $location
        }
    }
    return $null
}

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = @($env:Path, $machinePath, $userPath) -join ';'

$podman = Find-Podman
if (-not $podman) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw 'Windows Package Manager is missing. Install App Installer from Microsoft Store, then run start-windows.cmd again.'
    }

    Write-Host 'Installing Podman. Windows may ask for permission.'
    & winget install --id Podman.CLI --exact --source winget --accept-package-agreements --accept-source-agreements
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($env:Path, $machinePath, $userPath) -join ';'
    $podman = Find-Podman
    if (-not $podman) { throw 'Podman was not found after installation. Close this window and run start-windows.cmd again.' }
}

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

& podman info --format '{{.Host.Arch}}' *> $null
if ($LASTEXITCODE -ne 0) { throw 'The Podman machine is not ready.' }
