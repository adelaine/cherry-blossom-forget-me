BeforeAll {
    $launcherSource = Join-Path $PSScriptRoot '../../start-suitecloud.ps1'
    function podman { param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments) }
    function Save-TestConfig {
        $settings = $global:LauncherTest_config.Clone()
        $settings.Remove('certificates')
        $settings | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $global:LauncherTest_configPath
        $auth = @{ 'gitlab-token' = ''; 'suitecloud-certificates' = $global:LauncherTest_config.certificates }
        $auth | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json')
    }
    function Invoke-TestLauncher { & $global:LauncherTest_launcherPath }
}

Describe 'Windows SuiteCloud launcher' {
    BeforeEach {
        $global:LauncherTest_root = Join-Path $TestDrive ([guid]::NewGuid().ToString() + ' workspace with spaces')
        $setup = New-Item -ItemType Directory -Path (Join-Path $global:LauncherTest_root 'setup')
        $global:LauncherTest_launcherPath = Join-Path $setup.FullName 'start-suitecloud.ps1'
        Copy-Item -LiteralPath $launcherSource -Destination $global:LauncherTest_launcherPath
        Set-Content -LiteralPath (Join-Path $setup.FullName 'install-podman-windows.ps1') -Value '$global:installerCalls++'
        $global:installerCalls = 0
        $global:LauncherTest_oldNemsDir = $env:SUITECONTAINER_NEMS_DIR
        $env:SUITECONTAINER_NEMS_DIR = Join-Path $global:LauncherTest_root 'fixture credentials'
        $global:LauncherTest_configPath = Join-Path $global:LauncherTest_root 'suitecontainer.config.json'
        $global:LauncherTest_config = @{
            suiteapps = @(@{ url = 'https://gitlab.eng.netsuite.com/team/example.git'; directory = 'example' })
            vms = @(@{ account = '123456_SB1'; url = 'example.netsuite.com' })
            certificates = @{ public = 'credentials/public.pem'; private = 'credentials/private.pem'; id = 'certificate-id' }
        }
        $certDir = New-Item -ItemType Directory -Path (Join-Path $global:LauncherTest_root 'credentials')
        Save-TestConfig
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../../credentials/auth.example.json') -Destination (Join-Path $certDir.FullName 'auth.example.json')
        Set-Content -LiteralPath (Join-Path $certDir.FullName 'public.pem') -Value 'test public fixture'
        Set-Content -LiteralPath (Join-Path $certDir.FullName 'private.pem') -Value 'test private fixture'
        # Pester mocks run in the invoked script scope; explicit global fixture state keeps them isolated from production locals.
        $global:LauncherTest_calls = [Collections.Generic.List[object]]::new()
        $global:LauncherTest_imageExit = 0
        $global:LauncherTest_buildExit = 0
        $global:LauncherTest_prepareExit = 0
        $global:LauncherTest_pathsExit = 0
        $global:LauncherTest_deployExit = 0
        $global:LauncherTest_paths = @('credentials/public.pem', 'credentials/private.pem')
        Mock Write-Host {}
        Mock Read-Host { 'yes' }
        Mock podman {
            param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments)
            $global:LauncherTest_calls.Add(@($Arguments))
            $global:LASTEXITCODE = 0
            if ($Arguments[0] -eq 'image') { $global:LASTEXITCODE = $global:LauncherTest_imageExit }
            elseif ($Arguments[0] -eq 'build') { $global:LASTEXITCODE = $global:LauncherTest_buildExit }
            elseif ($Arguments -contains '--prepare-certificates') { $global:LASTEXITCODE = $global:LauncherTest_prepareExit }
            elseif ($Arguments -contains '--certificate-paths') {
                $global:LASTEXITCODE = $global:LauncherTest_pathsExit
                $global:LauncherTest_paths
            }
            elseif ($Arguments -contains '--deploy') { $global:LASTEXITCODE = $global:LauncherTest_deployExit }
        }
    }
    AfterEach { $env:SUITECONTAINER_NEMS_DIR = $global:LauncherTest_oldNemsDir }

    It 'copies the template and stops before installing Podman on first use' {
        Remove-Item -LiteralPath $global:LauncherTest_configPath
        $template = '{"suiteapps":[],"vms":[{"account":"","url":""}],"certificates":{"public":"","private":"","id":""}}'
        Set-Content -LiteralPath (Join-Path $global:LauncherTest_root 'suitecontainer.config.example.json') -Value $template
        Invoke-TestLauncher
        (Get-Content -LiteralPath $global:LauncherTest_configPath -Raw).Trim() | Should -Be $template
        $global:installerCalls | Should -Be 0
        $global:LauncherTest_calls.Count | Should -Be 0
        Should -Invoke Write-Host -ParameterFilter { "$Object" -match 'suitecontainer.config.json' }
    }
    It 'copies the auth template when missing' {
        Remove-Item -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json')
        $global:LauncherTest_prepareExit = 10
        Invoke-TestLauncher
        Get-Content -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json') -Raw | Should -Be (Get-Content -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.example.json') -Raw)
    }
    It 'preserves existing auth and mounts it read only' {
        $authFile = Join-Path $global:LauncherTest_root 'credentials/auth.json'
        $before = Get-Content -LiteralPath $authFile -Raw
        Invoke-TestLauncher
        Get-Content -LiteralPath $authFile -Raw | Should -Be $before
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--deploy' })[0]
        $deploy | Should -Contain "type=bind,src=$authFile,dst=/config/credentials/auth.json,ro=true"
    }
    It 'mounts an existing local checkout' {
        $checkout = New-Item -ItemType Directory -Path (Join-Path $global:LauncherTest_root 'local app')
        New-Item -ItemType Directory -Path (Join-Path $checkout.FullName '.git') | Out-Null
        $global:LauncherTest_config.suiteapps[0].localPath = 'local app'
        Save-TestConfig
        Invoke-TestLauncher
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--deploy' })[0]
        $deploy | Should -Contain "type=bind,src=$($checkout.FullName),dst=/workspace/example"
    }
    It 'stops successfully for an empty SuiteApp list' {
        $global:LauncherTest_config.suiteapps = @()
        Save-TestConfig
        Invoke-TestLauncher
        $global:installerCalls | Should -Be 0
        $global:LauncherTest_calls.Count | Should -Be 0
    }
    It 'rejects malformed JSON before installing anything' {
        Set-Content -LiteralPath $global:LauncherTest_configPath -Value '{'
        { Invoke-TestLauncher } | Should -Throw '*not valid JSON*'
        $global:installerCalls | Should -Be 0
    }
    It 'rejects a missing SuiteApp list' {
        $global:LauncherTest_config.Remove('suiteapps')
        Save-TestConfig
        { Invoke-TestLauncher } | Should -Throw '*suiteapps*list*'
    }
    It 'rejects malformed auth before installing anything' {
        Set-Content -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json') -Value '{'
        { Invoke-TestLauncher } | Should -Throw '*auth.json is not valid JSON*'
        $global:installerCalls | Should -Be 0
    }
    It 'reports a missing auth template before installing anything' {
        Remove-Item -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json'), (Join-Path $global:LauncherTest_root 'credentials/auth.example.json')
        { Invoke-TestLauncher } | Should -Throw '*Missing credentials/auth.example.json*'
        $global:installerCalls | Should -Be 0
    }
    It 'rejects duplicate repository directories' {
        $global:LauncherTest_config.suiteapps += @{ url = 'https://gitlab.eng.netsuite.com/team/other.git'; directory = 'EXAMPLE' }
        Save-TestConfig
        { Invoke-TestLauncher } | Should -Throw '*invalid URL or directory*'
    }
    It 'rejects an invalid account' {
        $global:LauncherTest_config.vms[0].account = 'invalid account'
        Save-TestConfig
        { Invoke-TestLauncher } | Should -Throw '*VM*invalid*'
    }
    It 'rejects partial certificate configuration' {
        $global:LauncherTest_config.certificates.private = ''
        Save-TestConfig
        { Invoke-TestLauncher } | Should -Throw '*both public and private*'
        $global:installerCalls | Should -Be 0
    }
    It 'stops immediately after generating certificates' {
        $global:LauncherTest_config.certificates = @{ public = ''; private = ''; id = '' }
        Save-TestConfig
        $global:LauncherTest_prepareExit = 10
        { Invoke-TestLauncher } | Should -Not -Throw
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--prepare-certificates' }).Count | Should -Be 1
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--certificate-paths' -or $_ -contains '--deploy' }).Count | Should -Be 0
    }
    It 'validates and deploys existing certificates with paths containing spaces' {
        Invoke-TestLauncher
        $build = @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'build' })[0]
        $build[-1] | Should -Be (Join-Path $global:LauncherTest_root 'setup')
        $build | Should -Contain (Join-Path $global:LauncherTest_root 'setup/Containerfile')
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--deploy' })[0]
        $publicPath = Join-Path $global:LauncherTest_root 'credentials/public.pem'
        $deploy | Should -Contain "type=bind,src=$publicPath,dst=/config/certs/public.pem,ro=true"
        $deploy | Should -Contain '--rm'
        $deploy | Should -Contain "type=bind,src=$($global:LauncherTest_configPath),dst=/config/suitecontainer.config.json"
    }
    It 'automatically accepts the license for a new image' {
        $global:LauncherTest_imageExit = 1
        Mock Read-Host { throw 'Unexpected acceptance prompt' }
        { Invoke-TestLauncher } | Should -Not -Throw
        $build = @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'build' })[0]
        $build | Should -Contain 'SUITECLOUD_CLI_ACCEPT_LICENSE=true'
        Should -Invoke Read-Host -Times 0 -Exactly
    }
    It 'reports a failed build' {
        $global:LauncherTest_buildExit = 1
        { Invoke-TestLauncher } | Should -Throw '*container build failed*'
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--prepare-certificates' }).Count | Should -Be 0
    }
    It 'reports failed certificate preparation' {
        $global:LauncherTest_prepareExit = 2
        { Invoke-TestLauncher } | Should -Throw '*Certificate preparation failed*'
    }
    It 'reports an invalid certificate ID returned by the application' {
        $global:LauncherTest_pathsExit = 1
        $global:LauncherTest_paths = @()
        { Invoke-TestLauncher } | Should -Throw '*certificate configuration is invalid*'
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--deploy' }).Count | Should -Be 0
    }
    It 'reports a missing private certificate file' {
        Remove-Item -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/private.pem')
        { Invoke-TestLauncher } | Should -Throw '*certificate files were not found*'
    }
    It 'reports a failed deployment' {
        $global:LauncherTest_deployExit = 1
        { Invoke-TestLauncher } | Should -Throw '*container stopped with an error*'
    }
    It 'mounts optional credentials from the isolated configured directory' {
        New-Item -ItemType Directory -Path $env:SUITECONTAINER_NEMS_DIR | Out-Null
        foreach ($name in @('.nems.env', 'config.toml')) {
            Set-Content -LiteralPath (Join-Path $env:SUITECONTAINER_NEMS_DIR $name) -Value 'fixture only'
        }
        Invoke-TestLauncher
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--deploy' })[0]
        foreach ($name in @('.nems.env', 'config.toml')) {
            $file = Join-Path $env:SUITECONTAINER_NEMS_DIR $name
            $deploy | Should -Contain "type=bind,src=$file,dst=/config/$name,ro=true"
        }
    }
    It 'rejects an invalid repository branch' {
        $global:LauncherTest_config.suiteapps[0].branch = '../invalid'
        Save-TestConfig
        { Invoke-TestLauncher } | Should -Throw '*invalid branch*'
    }
    AfterAll {
        Remove-Variable installerCalls -Scope Global -ErrorAction SilentlyContinue
        Get-Variable -Scope Global -Name 'LauncherTest_*' | Remove-Variable -Scope Global
    }
}
