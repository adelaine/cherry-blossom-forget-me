BeforeAll {
    $installerSource = Join-Path $PSScriptRoot '../../install-podman-windows.ps1'
    function podman { param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments) }
    function winget { param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments) }
}

Describe 'Windows Podman installer' {
    BeforeEach {
        $global:InstallerTest_savedPath = $env:Path
        $global:InstallerTest_podmanAvailable = $true
        $global:InstallerTest_wingetAvailable = $true
        $global:InstallerTest_installSucceeds = $true
        Mock Write-Host {}
        Mock Test-Path { $false }
        Mock Get-Command {
            if ($global:InstallerTest_podmanAvailable) { [pscustomobject]@{ Source = 'fixture-podman.exe' } }
        } -ParameterFilter { $Name -eq 'podman' }
        Mock Get-Command {
            if ($global:InstallerTest_wingetAvailable) { [pscustomobject]@{ Source = 'fixture-winget.exe' } }
        } -ParameterFilter { $Name -eq 'winget' }
        Mock winget {
            $global:InstallerTest_podmanAvailable = $global:InstallerTest_installSucceeds
            $global:LASTEXITCODE = 0
        }
    }
    AfterEach { $env:Path = $global:InstallerTest_savedPath }

    It 'reuses existing Podman without installing packages' {
        & $installerSource
        Should -Invoke winget -Times 0
    }
    It 'installs Podman through winget when missing' {
        $global:InstallerTest_podmanAvailable = $false
        & $installerSource
        Should -Invoke winget -Times 1 -Exactly
        $global:InstallerTest_podmanAvailable | Should -BeTrue
    }
    It 'reports a missing Windows Package Manager' {
        $global:InstallerTest_podmanAvailable = $false
        $global:InstallerTest_wingetAvailable = $false
        { & $installerSource } | Should -Throw '*Windows Package Manager is missing*'
        Should -Invoke winget -Times 0
    }
    It 'finds an installed Podman executable outside PATH' {
        $global:InstallerTest_podmanAvailable = $false
        $expected = Join-Path $env:LOCALAPPDATA 'Programs\Podman\podman.exe'
        Mock Test-Path { $true } -ParameterFilter { $LiteralPath -eq (Join-Path $env:LOCALAPPDATA 'Programs\Podman\podman.exe') }
        & $installerSource
        Should -Invoke winget -Times 0
        $env:Path | Should -Match ([regex]::Escape((Split-Path -Parent $expected)))
    }
    AfterAll { Get-Variable -Scope Global -Name 'InstallerTest_*' | Remove-Variable -Scope Global }
}
