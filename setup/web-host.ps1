function Invoke-SuiteContainerQuiet {
    param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
    $ErrorActionPreference = 'Continue'
    & podman @Arguments 2>$null
}

function Confirm-SuiteContainerOwner {
    $owner = (& podman inspect --format '{{index .Config.Labels "suitecontainer.project"}}' $script:containerName) -join ''
    if ($LASTEXITCODE -ne 0 -or $owner -ne $projectDir) { throw 'Another container has this app name. It will not be reused or removed.' }
}

function Open-SuiteContainerPage {
    $address = @(& podman port $script:containerName 8080/tcp)[0]
    if ($LASTEXITCODE -ne 0 -or -not $address) { throw 'Could not find the deployment page port.' }
    $port = ($address -split ':')[-1]
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        $suffix = (Invoke-SuiteContainerQuiet exec $script:containerName cat /tmp/suitecontainer-web-url) -join ''
        if ($LASTEXITCODE -eq 0 -and $suffix) {
            $ready = $false
            try {
                Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
                $ready = $true
            } catch { }
            if ($ready) {
                $url = "http://127.0.0.1:$port$suffix"
                Write-Host "Deployment page: $url"
                try { Start-Process $url } catch { Write-Host 'Open the address above in your browser.' }
                Write-Host 'The app stays running. Use Stop app on the page when finished.'
                return
            }
        }
        $running = (Invoke-SuiteContainerQuiet inspect --format '{{.State.Running}}' $script:containerName) -join ''
        if ($running -ne 'true') {
            & podman logs $script:containerName
            throw 'The deployment page could not start.'
        }
        Start-Sleep -Seconds 1
    }
    throw 'The deployment page did not become ready. Check the container logs and relaunch.'
}

function Start-SuiteContainerWeb {
    $base = @('--mount', "type=bind,src=$projectDir,dst=/project,ro=true", '--env', "SUITECONTAINER_HOST_ROOT=$projectDir", '--env', 'SUITECONTAINER_HOST_PLATFORM=win32')
    $requests = @(& podman run --rm --cgroups=disabled @base suitecloud-workspace --web-paths)
    if ($LASTEXITCODE -ne 0) { throw 'Could not read container mount settings.' }
    $staged = @('--mount', "type=bind,src=$projectDir,dst=/project")
    foreach ($request in $requests) {
        if (-not $request) { continue }
        $kind, $name, $path = $request -split "`t", 3
        $pathType = if ($kind -eq 'local') { 'Container' } else { 'Leaf' }
        if (Test-Path -LiteralPath $path -PathType $pathType) {
            if ($kind -eq 'external') { $name += '.pem' }
            $staged += @('--mount', "type=bind,src=$path,dst=/$kind/$name,ro=true")
        }
    }
    $launchMounts = @(& podman run --rm --cgroups=disabled @staged --env "SUITECONTAINER_HOST_ROOT=$projectDir" --env 'SUITECONTAINER_HOST_PLATFORM=win32' suitecloud-workspace --web-mounts)
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare container mounts.' }
    $mounts = @()
    foreach ($mount in $launchMounts) { if ($mount) { $mounts += @('--mount', $mount) } }
    & podman container exists $script:containerName
    if ($LASTEXITCODE -eq 0) {
        Confirm-SuiteContainerOwner
        & podman rm $script:containerName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not remove the previous stopped app.' }
    }
    & podman run -d --name $script:containerName --label "suitecontainer.project=$projectDir" --cgroups=disabled --publish '127.0.0.1::8080' @mounts suitecloud-workspace --serve | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not start the deployment page.' }
    Open-SuiteContainerPage
}
