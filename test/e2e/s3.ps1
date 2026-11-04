#Requires -Version 7.0
<#
.SYNOPSIS
Functions that start and remove the throw-away S3 server of the end-to-end specs; dot-sourced by run.ps1.

.DESCRIPTION
A spec that needs an S3 server says so by reading the variables E2E_S3_* (see Get-E2ES3Arguments). run.ps1 then starts
rustfs/rustfs:1.0.4 (an S3-compatible server) on the network of the run, with random root keys. The
container has no published port; the code-server container and the runner reach it by name on port 9000. Its data
directory is in memory, so nothing is left behind after docker rm. The spec creates its bucket itself.
#>

$script:S3Image = 'rustfs/rustfs:1.0.4'

function Start-E2ES3([string] $Name, [string] $Network) {
    $env:RUSTFS_ACCESS_KEY = 'e2e' + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(6)).ToLower()
    $env:RUSTFS_SECRET_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(20)).ToLower()
    try {
        # RustFS runs as UID 10001: a tmpfs owned by that user is writable for it. The keys are passed by name, so that
        # they do not show up in the process list.
        Invoke-Docker run -d --name $Name --network $Network --tmpfs '/data:rw,uid=10001,gid=10001,mode=0755' `
            -e RUSTFS_ACCESS_KEY -e RUSTFS_SECRET_KEY `
            -e RUSTFS_VOLUMES=/data -e RUSTFS_ADDRESS=0.0.0.0:9000 -e RUSTFS_CONSOLE_ENABLE=false -e RUSTFS_OBS_LOG_DIRECTORY= `
            $script:S3Image | Out-Null
    }
    finally {
        Remove-Item Env:RUSTFS_ACCESS_KEY, Env:RUSTFS_SECRET_KEY
    }
    $deadline = (Get-Date).AddSeconds(60)
    while ($true) {
        docker exec $Name curl -fsS -o /dev/null http://127.0.0.1:9000/health 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ((Get-Date) -gt $deadline) {
            docker logs --tail 40 $Name 2>&1 | ForEach-Object { Write-Host "  $_" }
            throw "The S3 server in $Name did not become ready within 60 s."
        }
        Start-Sleep -Milliseconds 500
    }
}

function Remove-E2ES3([string] $Name) {
    docker rm -f $Name 2>&1 | Out-Null
    $global:LASTEXITCODE = 0
}

# The arguments that hand the address and the keys of a running container to the runner (docker run ... <image>).
function Get-E2ES3Arguments([string] $Name) {
    $keys = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Name
    $access = $keys | Where-Object { $_ -like 'RUSTFS_ACCESS_KEY=*' } | ForEach-Object { $_.Substring('RUSTFS_ACCESS_KEY='.Length) }
    $secret = $keys | Where-Object { $_ -like 'RUSTFS_SECRET_KEY=*' } | ForEach-Object { $_.Substring('RUSTFS_SECRET_KEY='.Length) }
    if (-not $access -or -not $secret) {
        throw "Cannot read the keys of $Name."
    }
    $env:E2E_S3_ACCESS_KEY = $access
    $env:E2E_S3_SECRET_KEY = $secret
    '-e', "E2E_S3_HOST=$Name", '-e', 'E2E_S3_PORT=9000', '-e', 'E2E_S3_ACCESS_KEY', '-e', 'E2E_S3_SECRET_KEY'
}
