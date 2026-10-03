param([string]$ProjectDir, [string]$NemsDir)
$ErrorActionPreference = 'Stop'
$credentialsDir = Join-Path $ProjectDir 'credentials'
[IO.Directory]::CreateDirectory($credentialsDir) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $ProjectDir 'repos')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $ProjectDir 'sftp-files')) | Out-Null
$configFile = Join-Path $ProjectDir 'suitecontainer.config.json'
if (-not (Test-Path -LiteralPath $configFile)) { Copy-Item -LiteralPath (Join-Path $ProjectDir 'suitecontainer.config.example.json') -Destination $configFile }
$authFile = Join-Path $credentialsDir 'auth.json'
if (-not (Test-Path -LiteralPath $authFile)) { Copy-Item -LiteralPath (Join-Path $credentialsDir 'auth.example.json') -Destination $authFile }
try { $auth = Get-Content -LiteralPath $authFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return }
if ($auth -isnot [pscustomobject] -or ([string]$auth.'gitlab-token').Trim()) { return }
$sources = @((Join-Path $ProjectDir '.codex/config.toml'), (Join-Path $NemsDir 'config.toml'), (Join-Path $ProjectDir '.nems.env'), (Join-Path $NemsDir '.nems.env'))
if (-not $env:SUITECONTAINER_NEMS_DIR) { $sources += Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nems.env' }
foreach ($source in $sources) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { continue }
    $section = ''
    try { $contents = Get-Content -LiteralPath $source -Encoding UTF8 } catch { continue }
    foreach ($raw in $contents) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        if ($line -match '^\[([^\]]+)\]$') { $section = $Matches[1].ToLowerInvariant(); continue }
        if ($line -match '(?:^|[{,]\s*)["'']?((?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token|gitlab_pat|gitlab\.token)["'']?\s*=\s*("[^"]*"|''[^'']*'')' -or $line -match '^(?:export\s+)?["'']?([A-Za-z_][A-Za-z0-9_.-]*)["'']?\s*=\s*(.*?)\s*$') {
            $key = $Matches[1].ToLowerInvariant()
            $value = $Matches[2].Trim()
            if ($key -notmatch '^(?:nems_)?gitlab_(?:(?:personal_access|private_access|personal|private|access|api)_)?token$' -and $key -notin @('gitlab_pat','gitlab.token') -and -not ($section -eq 'gitlab' -and $key -in @('token','access_token','private_token','personal_access_token','pat'))) { continue }
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
            else { $value = $value -replace '\s+#.*$', '' }
            if ($value -and $value -notmatch '[\r\n\x00]') {
                $auth | Add-Member -NotePropertyName 'gitlab-token' -NotePropertyValue $value -Force
                [IO.File]::WriteAllText($authFile, ($auth | ConvertTo-Json -Depth 30) + "`n", [Text.UTF8Encoding]::new($false))
                return
            }
        }
    }
}
