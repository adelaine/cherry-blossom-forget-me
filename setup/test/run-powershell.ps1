#Requires -Version 5.1
param([string]$PesterModulePath)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$python = & (Join-Path $projectDir 'setup/bootstrap/start-suitecloud.ps1') -RuntimeOnly
& $python -I -B (Join-Path $PSScriptRoot 'bootstrap_test.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($PesterModulePath) {
    Import-Module $PesterModulePath -Force
} else {
    $cachedModule = Join-Path $projectDir '.cache/test-tools/Pester/5.7.1/Pester.psd1'
    if (Test-Path -LiteralPath $cachedModule -PathType Leaf) {
        Import-Module $cachedModule -Force
    } else {
        $installedModule = Get-Module -ListAvailable Pester | Where-Object { $_.Version.Major -eq 5 } | Sort-Object Version -Descending | Select-Object -First 1
        if (-not $installedModule) {
            throw 'Pester 5 is required. Install it with: Install-Module Pester -RequiredVersion 5.7.1 -Scope CurrentUser'
        }
        Import-Module $installedModule.Path -Force
    }
}
if ((Get-Module Pester).Version.Major -ne 5) { throw 'These tests require Pester 5.' }
$configuration = New-PesterConfiguration
$configuration.Run.Path = Join-Path $PSScriptRoot 'powershell'
$configuration.Run.PassThru = $true
$configuration.Output.Verbosity = 'Detailed'
$configuration.TestRegistry.Enabled = $false
$result = Invoke-Pester -Configuration $configuration
if ($result.Result -ne 'Passed') { exit 1 }
exit 0
