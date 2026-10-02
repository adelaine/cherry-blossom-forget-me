BeforeAll {
    $launcherSource = Join-Path $PSScriptRoot '../../bootstrap/start-suitecloud.ps1'
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
        $setup = New-Item -ItemType Directory -Path (Join-Path $global:LauncherTest_root 'setup/bootstrap')
        $installers = New-Item -ItemType Directory -Path (Join-Path $global:LauncherTest_root 'setup/installers')
        $global:LauncherTest_launcherPath = Join-Path $setup.FullName 'start-suitecloud.ps1'
        Copy-Item -LiteralPath $launcherSource -Destination $global:LauncherTest_launcherPath
        foreach ($helper in @('bootstrap-host.ps1','web-host.ps1')) {
            Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $launcherSource) $helper) -Destination $setup.FullName
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../../../suitecontainer.config.example.json') -Destination $global:LauncherTest_root
        Set-Content -LiteralPath (Join-Path $installers.FullName 'install-podman-windows.ps1') -Value '$global:installerCalls++'
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
        $global:LauncherTest_machineJson = '[{"Name":"fixture-machine","Default":true,"Running":true}]'
        $global:LauncherTest_prepareExit = 0
        $global:LauncherTest_pathsExit = 0
        $global:LauncherTest_deployExit = 0
        $global:LauncherTest_paths = @('credentials/public.pem', 'credentials/private.pem')
        $global:LauncherTest_running = 'false'
        $global:LauncherTest_owner = $global:LauncherTest_root
        $global:LauncherTest_inspectExit = 0
        $global:LauncherTest_inspectJson = $null
        $global:LauncherTest_existsExit = 1
        Mock Write-Host {}
        Mock Read-Host { 'yes' }
        Mock Start-Process {}
        Mock Invoke-WebRequest {}
        Mock podman {
            param([Parameter(ValueFromRemainingArguments = $true)][object[]] $Arguments)
            $global:LauncherTest_calls.Add(@($Arguments))
            $global:LASTEXITCODE = 0
            if ($Arguments[0] -eq 'image') { $global:LASTEXITCODE = $global:LauncherTest_imageExit }
            elseif ($Arguments[0] -eq 'build') { $global:LASTEXITCODE = $global:LauncherTest_buildExit }
            elseif ($Arguments[0] -eq 'machine' -and $Arguments[1] -eq 'list') { $global:LauncherTest_machineJson }
            elseif ($Arguments[0] -eq 'machine' -and $Arguments[1] -eq 'ssh') { $global:LASTEXITCODE = $global:LauncherTest_buildExit }
            elseif ($Arguments[0] -eq 'inspect') {
                if ($Arguments[2] -eq 'json') {
                    $global:LASTEXITCODE = $global:LauncherTest_inspectExit
                    if ($null -ne $global:LauncherTest_inspectJson) { $global:LauncherTest_inspectJson }
                    else { ConvertTo-Json -InputObject @(@{ Config = @{ Labels = @{ 'suitecontainer.project' = $global:LauncherTest_owner } } }) -Depth 5 }
                } else { $global:LauncherTest_running }
            }
            elseif ($Arguments[0] -eq 'port') { '127.0.0.1:49123' }
            elseif ($Arguments[0] -eq 'exec') { '/#session=fixture-session' }
            elseif ($Arguments[0] -eq 'container') { $global:LASTEXITCODE = $global:LauncherTest_existsExit }
            elseif ($Arguments -contains '--web-paths') { $global:LASTEXITCODE = $global:LauncherTest_prepareExit }
            elseif ($Arguments -contains '--web-mounts') {
                $global:LASTEXITCODE = $global:LauncherTest_pathsExit
                "type=bind,src=$global:LauncherTest_root/repos,dst=/workspace"
            }
            elseif ($Arguments -contains '--serve') { $global:LASTEXITCODE = $global:LauncherTest_deployExit; $global:LauncherTest_running = 'true' }
        }
    }
    AfterEach { $env:SUITECONTAINER_NEMS_DIR = $global:LauncherTest_oldNemsDir }

    It 'builds and launches with mounts supplied by the application' {
        Invoke-TestLauncher
        $global:installerCalls | Should -Be 1
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--web-paths' }).Count | Should -Be 1
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--web-mounts' }).Count | Should -Be 1
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--serve' })[0]
        $deploy | Should -Contain "type=bind,src=$global:LauncherTest_root/repos,dst=/workspace"
        $deploy | Should -Contain '127.0.0.1::8080'
        Should -Invoke Start-Process -Times 1 -Exactly
    }
    It 'creates missing files before installation and continues with blank runbox settings' {
        Remove-Item -LiteralPath $global:LauncherTest_configPath
        Remove-Item -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json')
        Invoke-TestLauncher
        (Get-Content -LiteralPath $global:LauncherTest_configPath -Raw | ConvertFrom-Json).vms[0].url | Should -Be ''
        Test-Path -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json') | Should -BeTrue
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--serve' }).Count | Should -Be 1
    }
    It 'automatically accepts the license for a new image' {
        $global:LauncherTest_imageExit = 1
        Mock Read-Host { throw 'Unexpected acceptance prompt' }
        { Invoke-TestLauncher } | Should -Not -Throw
        $build = @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'build' })[0]
        $build | Should -Contain 'SUITECLOUD_CLI_ACCEPT_LICENSE=true'
        $build[-1] | Should -Be $global:LauncherTest_root
        $build[[array]::IndexOf($build, '-f') + 1] | Should -Be (Join-Path $global:LauncherTest_root 'setup/Containerfile')
        $build[[array]::IndexOf($build, '--ignorefile') + 1] | Should -Be (Join-Path $global:LauncherTest_root 'setup/.containerignore')
        Should -Invoke Read-Host -Times 0 -Exactly
    }
    It 'builds with secrets inside the WSL machine without exposing the token' {
        $previousNpmrc = $env:SUITECONTAINER_NPMRC
        $previousToken = $env:NSX_NPM_TOKEN
        $previousTemp = $env:TEMP
        try {
            $env:SUITECONTAINER_NPMRC = Join-Path $global:LauncherTest_root 'npm config/.npmrc'
            New-Item -ItemType Directory -Path (Split-Path -Parent $env:SUITECONTAINER_NPMRC) | Out-Null
            Set-Content -LiteralPath $env:SUITECONTAINER_NPMRC -Value 'registry=https://registry.example.test/'
            $env:NSX_NPM_TOKEN = 'test-token'
            $env:TEMP = $global:LauncherTest_root
            $global:LauncherTest_machineJson = '[{"Name":"fixture-machine","Default":true,"Running":true,"VMType":"wsl"}]'
            Invoke-TestLauncher
            $ssh = @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'machine' -and $_[1] -eq 'ssh' })[0]
            $ssh | Should -Contain 'fixture-machine'
            $ssh[-1] | Should -Match 'id=npmrc,src=/mnt/[a-z]/'
            $ssh[-1] | Should -Match 'id=npm-token,src=/mnt/[a-z]/'
            $ssh[-1] | Should -Not -Match 'test-token|\\'
            $remoteRoot = '/mnt/' + $global:LauncherTest_root.Substring(0, 1).ToLowerInvariant() + '/' + $global:LauncherTest_root.Substring(3).Replace('\', '/')
            $ssh[-1] | Should -Match ([regex]::Escape("'-f' '$remoteRoot/setup/Containerfile'"))
            $ssh[-1] | Should -Match ([regex]::Escape("'--ignorefile' '$remoteRoot/setup/.containerignore'"))
            $ssh[-1] | Should -Match ([regex]::Escape("'$remoteRoot'") + '$')
            @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'build' }).Count | Should -Be 0
            @(Get-ChildItem -LiteralPath $global:LauncherTest_root -Filter 'suitecontainer-npm-token-*').Count | Should -Be 0
        } finally {
            $env:SUITECONTAINER_NPMRC = $previousNpmrc
            $env:NSX_NPM_TOKEN = $previousToken
            $env:TEMP = $previousTemp
        }
    }
    It 'reports a failed build' {
        $global:LauncherTest_buildExit = 1
        { Invoke-TestLauncher } | Should -Throw '*container build failed*'
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--web-paths' }).Count | Should -Be 0
    }
    It 'propagates application preparation failures' {
        $global:LauncherTest_prepareExit = 2
        { Invoke-TestLauncher } | Should -Throw '*Could not read container mount settings*'
    }
    It 'propagates application mount failures' {
        $global:LauncherTest_pathsExit = 1
        { Invoke-TestLauncher } | Should -Throw '*Could not prepare container mounts*'
    }
    It 'reports a failed page start' {
        $global:LauncherTest_deployExit = 1
        { Invoke-TestLauncher } | Should -Throw '*Could not start the deployment page*'
    }
    It 'imports the token without mounting Codex configuration into the app' {
        New-Item -ItemType Directory -Path $env:SUITECONTAINER_NEMS_DIR | Out-Null
        foreach ($name in @('.nems.env', 'config.toml')) {
            Set-Content -LiteralPath (Join-Path $env:SUITECONTAINER_NEMS_DIR $name) -Value 'GITLAB_TOKEN="fixture-token"'
        }
        Invoke-TestLauncher
        $auth = Get-Content -LiteralPath (Join-Path $global:LauncherTest_root 'credentials/auth.json') -Raw | ConvertFrom-Json
        $auth.'gitlab-token' | Should -Be 'fixture-token'
        $deploy = @($global:LauncherTest_calls | Where-Object { $_ -contains '--serve' })[0]
        foreach ($name in @('.nems.env', 'config.toml')) {
            $file = Join-Path $env:SUITECONTAINER_NEMS_DIR $name
            $deploy | Should -Not -Contain "type=bind,src=$file,dst=/config/$name,ro=true"
        }
    }
    It 'opens an existing app without rebuilding' {
        $global:LauncherTest_running = 'true'
        Invoke-TestLauncher
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'build' }).Count | Should -Be 0
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--serve' }).Count | Should -Be 0
        Should -Invoke Start-Process -Times 1 -Exactly
    }
    It 'replaces a stopped app only after verifying its JSON ownership label' {
        $global:LauncherTest_existsExit = 0
        Invoke-TestLauncher
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'inspect' -and $_[2] -eq 'json' }).Count | Should -Be 1
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'rm' }).Count | Should -Be 1
        @($global:LauncherTest_calls | Where-Object { $_ -contains '--serve' }).Count | Should -Be 1
    }
    It 'does not reuse a running app owned by another checkout' {
        $global:LauncherTest_running = 'true'
        $global:LauncherTest_owner = 'C:\another checkout'
        { Invoke-TestLauncher } | Should -Throw '*Another container has this app name*'
        Should -Invoke Start-Process -Times 0 -Exactly
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'rm' -or $_ -contains '--serve' }).Count | Should -Be 0
    }
    It 'does not remove a stopped app without an ownership label' {
        $global:LauncherTest_existsExit = 0
        $global:LauncherTest_inspectJson = '[{"Config":{"Labels":{}}}]'
        { Invoke-TestLauncher } | Should -Throw '*Another container has this app name*'
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'rm' -or $_ -contains '--serve' }).Count | Should -Be 0
    }
    It 'reports inspection failures separately and leaves the existing app untouched' {
        $global:LauncherTest_running = 'true'
        $global:LauncherTest_inspectExit = 125
        { Invoke-TestLauncher } | Should -Throw '*Could not inspect the existing app*'
        Should -Invoke Start-Process -Times 0 -Exactly
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'rm' -or $_ -contains '--serve' }).Count | Should -Be 0
    }
    It 'rejects malformed inspection output without removing the stopped app' {
        $global:LauncherTest_existsExit = 0
        $global:LauncherTest_inspectJson = 'invalid JSON'
        { Invoke-TestLauncher } | Should -Throw '*Could not read ownership information*'
        @($global:LauncherTest_calls | Where-Object { $_[0] -eq 'rm' -or $_ -contains '--serve' }).Count | Should -Be 0
    }
    AfterAll {
        Remove-Variable installerCalls -Scope Global -ErrorAction SilentlyContinue
        Get-Variable -Scope Global -Name 'LauncherTest_*' | Remove-Variable -Scope Global
    }
}
