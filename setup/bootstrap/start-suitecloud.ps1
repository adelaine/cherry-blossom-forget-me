param([switch]$RuntimeOnly)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
    throw 'This package supports Windows computers with an Intel or AMD 64-bit processor.'
}
$metadata = @(Import-Csv -LiteralPath (Join-Path $projectDir 'setup/python/runtimes.tsv') -Delimiter "`t" | Where-Object target -eq 'windows-x64')
if ($metadata.Count -ne 1 -or $metadata[0].sha256 -notmatch '^[a-f0-9]{64}$' -or $metadata[0].url -notlike 'https://*') { throw 'The Windows Python download metadata is missing or invalid.' }
$metadata = $metadata[0]
$runtimeDir = Join-Path $projectDir ".cache/python/$($metadata.sha256)"
$python = Join-Path $runtimeDir 'python/python.exe'
$ready = Join-Path $runtimeDir '.ready'
if (-not (Test-Path -LiteralPath $ready) -or -not (Test-Path -LiteralPath $python)) {
    [IO.Directory]::CreateDirectory($runtimeDir) | Out-Null
    $archive = Join-Path $runtimeDir ("download-$([guid]::NewGuid().ToString('N')).tar.gz")
    try {
        Write-Host "Downloading Python $($metadata.version) for Windows..."
        & curl.exe --fail --location --show-error --silent --output $archive $metadata.url
        if ($LASTEXITCODE -ne 0) { throw 'Could not download Python. Check network access, proxy settings, and VPN/Banyan sign-in, then retry.' }
        $digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($digest -ne $metadata.sha256) { throw 'The Python download checksum did not match. A proxy or VPN/Banyan sign-in page may have replaced the archive. Reconnect/sign in and retry.' }
        & tar.exe -xzf $archive -C $runtimeDir
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the downloaded Python runtime.' }
        if (-not (Test-Path -LiteralPath $python)) { throw 'The downloaded Python archive does not contain its interpreter.' }
        [IO.File]::WriteAllText($ready, '')
    } finally {
        if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    }
}
if ($RuntimeOnly) { return $python }
& $python -I -B (Join-Path $PSScriptRoot 'bootstrap.py')
exit $LASTEXITCODE
