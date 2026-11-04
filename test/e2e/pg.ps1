#Requires -Version 7.0
<#
.SYNOPSIS
Functions that start and remove the throw-away PostgreSQL of the end-to-end specs; dot-sourced by run.ps1.

.DESCRIPTION
A spec that needs a database says so by reading the variables E2E_POSTGRES_* (see Get-E2EPostgresArguments). run.ps1
then starts postgres:17-alpine on the network of the run, as test/support/global-setup.ts does for the unit tests: the
user aantje with a random password, the database ducklake, filled from test/fixtures/postgres.sql. The container
has no published port; the code-server container and the runner reach it by name on the Docker network.
#>

$script:PostgresImage = 'postgres:17-alpine'
$script:PostgresUser = 'aantje'
$script:PostgresDatabase = 'ducklake'

function Start-E2EPostgres([string] $Name, [string] $Network, [string] $FixtureSql) {
    $env:POSTGRES_PASSWORD = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(16)).ToLower()
    try {
        # The password is passed by name (`-e POSTGRES_PASSWORD` takes the value from this process), so that it does
        # not show up in the process list. The data directory is in memory: nothing is left behind after docker rm.
        Invoke-Docker run -d --name $Name --network $Network --tmpfs /var/lib/postgresql/data `
            -e POSTGRES_PASSWORD `
            -e "POSTGRES_USER=$script:PostgresUser" -e "POSTGRES_DB=$script:PostgresDatabase" $script:PostgresImage | Out-Null
    }
    finally {
        Remove-Item Env:POSTGRES_PASSWORD
    }
    # The image first runs a temporary server that only listens on a socket: a query over TCP means the real one is up.
    $deadline = (Get-Date).AddSeconds(90)
    while ($true) {
        docker exec $Name psql -h 127.0.0.1 -U $script:PostgresUser -d $script:PostgresDatabase -tAc 'select 1' 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ((Get-Date) -gt $deadline) {
            docker logs --tail 40 $Name 2>&1 | ForEach-Object { Write-Host "  $_" }
            throw "PostgreSQL in $Name did not become ready within 90 s."
        }
        Start-Sleep -Milliseconds 500
    }
    Invoke-Docker cp $FixtureSql "${Name}:/tmp/postgres.sql"
    Invoke-Docker exec $Name psql -h 127.0.0.1 -U $script:PostgresUser -d $script:PostgresDatabase -v ON_ERROR_STOP=1 -q -f /tmp/postgres.sql | Out-Null
}

function Remove-E2EPostgres([string] $Name) {
    docker rm -f $Name 2>&1 | Out-Null
    $global:LASTEXITCODE = 0
}

# The arguments that hand the connection data of a running container to the runner (docker run ... <image>).
function Get-E2EPostgresArguments([string] $Name) {
    $password = docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' $Name |
        Where-Object { $_ -like 'POSTGRES_PASSWORD=*' } | ForEach-Object { $_.Substring('POSTGRES_PASSWORD='.Length) }
    if (-not $password) {
        throw "Cannot read the password of $Name."
    }
    $env:E2E_POSTGRES_PASSWORD = $password
    # Host, port, database and user are not secret; the password goes by name.
    '-e', "E2E_POSTGRES_HOST=$Name", '-e', 'E2E_POSTGRES_PORT=5432', '-e', "E2E_POSTGRES_DATABASE=$script:PostgresDatabase",
    '-e', "E2E_POSTGRES_USER=$script:PostgresUser", '-e', 'E2E_POSTGRES_PASSWORD'
}
