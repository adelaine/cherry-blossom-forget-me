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
    if ($LASTEXITCODE -ne 0) { throw 'Podman installation failed.' }
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = @($env:Path, $machinePath, $userPath) -join ';'
    $podman = Find-Podman
}
