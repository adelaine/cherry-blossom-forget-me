$ErrorActionPreference = 'Stop'

if (Get-Command podman -ErrorAction SilentlyContinue) { return }
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'Windows Package Manager is missing. Install App Installer from Microsoft Store, then run start-windows.cmd again.'
}

Write-Host 'Installing Podman. Windows may ask for permission.'
& winget install --id Podman.CLI --exact --source winget --accept-package-agreements --accept-source-agreements
if ($LASTEXITCODE -ne 0) { throw 'Podman installation failed.' }

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = @($env:Path, $machinePath, $userPath) -join ';'

if (-not (Get-Command podman -ErrorAction SilentlyContinue)) {
    throw 'Podman was installed, but Windows has not updated this window yet. Close it and run start-windows.cmd again.'
}
