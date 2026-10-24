BeforeAll {
    $repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
    function Invoke-BatchFixture {
        param([string] $Path)
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $env:ComSpec
        $startInfo.Arguments = '/d /s /c ""' + $Path + '""'
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($startInfo)
        # EOF releases pause in error paths without waiting for a person.
        $process.StandardInput.Close()
        $outputTask = $process.StandardOutput.ReadToEndAsync()
        $errorTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Batch fixture timed out.' }
        [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $outputTask.Result; ErrorOutput = $errorTask.Result }
        $process.Dispose()
    }
}

Describe 'Windows batch wrappers' -Skip:([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    BeforeEach {
        $script:fixtureRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString() + ' path with spaces')
        New-Item -ItemType Directory -Path (Join-Path $script:fixtureRoot 'app/setup/bootstrap') | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $script:fixtureRoot 'start') | Out-Null
    }
    It 'routes the start wrapper to its setup wrapper and preserves success' {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'start/start-windows.cmd') -Destination (Join-Path $script:fixtureRoot 'start')
        Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.cmd') -Value "@echo off`r`necho routed-to-setup`r`nexit /b 0"
        $result = Invoke-BatchFixture (Join-Path $script:fixtureRoot 'start/start-windows.cmd')
        $result.ExitCode | Should -Be 0
        $result.Output | Should -Match 'routed-to-setup'
    }
    It 'preserves a failing child exit code through the start wrapper' {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'start/start-windows.cmd') -Destination (Join-Path $script:fixtureRoot 'start')
        Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.cmd') -Value "@echo off`r`nexit /b 7"
        $result = Invoke-BatchFixture (Join-Path $script:fixtureRoot 'start/start-windows.cmd')
        $result.ExitCode | Should -Be 7
    }
    It 'runs the setup PowerShell script from a directory containing spaces' {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'app/setup/bootstrap/start-suitecloud.cmd') -Destination (Join-Path $script:fixtureRoot 'app/setup/bootstrap')
        Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.ps1') -Value "Write-Output 'routed-to-powershell'; exit 0"
        $result = Invoke-BatchFixture (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.cmd')
        $result.ExitCode | Should -Be 0
        $result.Output | Should -Match 'routed-to-powershell'
    }
    It 'preserves PowerShell failure after the pause prompt' {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot 'app/setup/bootstrap/start-suitecloud.cmd') -Destination (Join-Path $script:fixtureRoot 'app/setup/bootstrap')
        Set-Content -LiteralPath (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.ps1') -Value 'exit 9'
        $result = Invoke-BatchFixture (Join-Path $script:fixtureRoot 'app/setup/bootstrap/start-suitecloud.cmd')
        $result.ExitCode | Should -Be 9
    }
}
