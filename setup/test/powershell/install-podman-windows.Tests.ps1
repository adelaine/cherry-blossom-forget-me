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
        $global:InstallerTest_machineJson = '[{"Name":"default-machine","Default":true,"Running":true}]'
        $global:InstallerTest_listExit = 0
        $global:InstallerTest_initExit = 0
        $global:InstallerTest_startExit = 0
        $global:InstallerTest_infoExit = 0
        $global:InstallerTest_calls = [Collections.Generic.List[object]]::new()
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
        Mock podman {
            param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments)
            $global:InstallerTest_calls.Add(@($Arguments))
            $global:LASTEXITCODE = 0
            if ($Arguments[0] -eq 'machine' -and $Arguments[1] -eq 'list') {
                $global:LASTEXITCODE = $global:InstallerTest_listExit
                $global:InstallerTest_machineJson
            }
            elseif ($Arguments[1] -eq 'init') { $global:LASTEXITCODE = $global:InstallerTest_initExit }
            elseif ($Arguments[1] -eq 'start') { $global:LASTEXITCODE = $global:InstallerTest_startExit }
            elseif ($Arguments[0] -eq 'info') { $global:LASTEXITCODE = $global:InstallerTest_infoExit }
        }
    }
    AfterEach { $env:Path = $global:InstallerTest_savedPath }

    It 'reuses an already running machine' {
        & $installerSource
        Should -Invoke winget -Times 0
        @($global:InstallerTest_calls | Where-Object { $_[1] -eq 'init' -or $_[1] -eq 'start' }).Count | Should -Be 0
        @($global:InstallerTest_calls | Where-Object { $_[0] -eq 'info' }).Count | Should -Be 1
    }
    It 'initializes a machine when none exist' {
        $global:InstallerTest_machineJson = '[]'
        & $installerSource
        $init = @($global:InstallerTest_calls | Where-Object { $_[1] -eq 'init' })[0]
        $init | Should -Contain '--now'
    }
    It 'starts the default machine when machines are stopped' {
        $global:InstallerTest_machineJson = '[{"Name":"other","Default":false,"Running":false},{"Name":"preferred","Default":true,"Running":false}]'
        & $installerSource
        $start = @($global:InstallerTest_calls | Where-Object { $_[1] -eq 'start' })[0]
        $start | Should -Contain 'preferred'
    }
    It 'starts the first machine when there is no default' {
        $global:InstallerTest_machineJson = '[{"Name":"first","Default":false,"Running":false},{"Name":"second","Default":false,"Running":false}]'
        & $installerSource
        $start = @($global:InstallerTest_calls | Where-Object { $_[1] -eq 'start' })[0]
        $start | Should -Contain 'first'
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
    It 'reports Podman still missing after installation' {
        $global:InstallerTest_podmanAvailable = $false
        $global:InstallerTest_installSucceeds = $false
        { & $installerSource } | Should -Throw '*Podman was not found after installation*'
    }
    It 'reports a failed machine listing' {
        $global:InstallerTest_listExit = 1
        { & $installerSource } | Should -Throw '*Could not check the Podman machine*'
    }
    It 'reports failed machine initialization' {
        $global:InstallerTest_machineJson = '[]'
        $global:InstallerTest_initExit = 1
        { & $installerSource } | Should -Throw '*Could not set up the Podman machine*'
    }
    It 'reports a failed machine start' {
        $global:InstallerTest_machineJson = '[{"Name":"default-machine","Default":true,"Running":false}]'
        $global:InstallerTest_startExit = 1
        { & $installerSource } | Should -Throw '*Could not start the Podman machine*'
    }
    It 'reports a machine that is not ready' {
        $global:InstallerTest_infoExit = 1
        { & $installerSource } | Should -Throw '*Podman machine is not ready*'
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
