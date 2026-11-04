#Requires -Version 7.3
<#
.SYNOPSIS
Regenerates the DuckLake fixture catalogs of the aantje tests with the real DuckDB + ducklake extension.

.DESCRIPTION
Writes ducklake.sqlite, ducklake.duckdb and postgres.sql. Needs Docker and network access (pip, DuckDB extensions).
Python and DuckDB run only in throw-away containers. Every Docker resource is named "aantje-test-*" and removed
at the end, also when the script fails. See README.md in this directory.

.PARAMETER Only
Regenerate a single fixture instead of all three.

.PARAMETER OutDir
Where the files are written. Defaults to this directory, which replaces the checked-in fixtures.
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'sqlite', 'duckdb', 'postgres')]
    [string] $Only = 'all',
    [string] $OutDir = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$OutDir = (New-Item -ItemType Directory -Force $OutDir).FullName

$prefix = 'aantje-test-'
$network = "${prefix}net"
$pgServer = "${prefix}pgfx"
$generator = "${prefix}gen"
$pythonImage = 'python:3.12-slim'
$postgresImage = 'postgres:17-alpine'
$pgUser = 'aantje'
$pgDatabase = 'ducklake'
$expectedSnapshots = (0..13) -join ','
$install = 'pip install --quiet --no-cache-dir --root-user-action=ignore duckdb==2.0.0'

function Invoke-Docker {
    docker @args
    if ($LASTEXITCODE -ne 0) {
        # Only the sub command: arguments may carry a password.
        throw "docker $($args[0]) failed with exit code $LASTEXITCODE"
    }
}

function Remove-Resources {
    foreach ($container in @($generator, $pgServer)) {
        docker rm -f $container 2>&1 | Out-Null
    }
    docker network rm $network 2>&1 | Out-Null
}

function New-FileFixtures([string[]] $backends) {
    $commands = ($backends | ForEach-Object { "python /fixtures/generate.py $_ --out /out" }) -join ' && '
    # The files stay inside the container until they are complete; SQLite does not like bind mounts.
    Invoke-Docker run --name $generator -v "${PSScriptRoot}:/fixtures:ro" $pythonImage `
        sh -c "$install && mkdir /out && $commands && ls -l /out && ! ls /out/*.wal 2>/dev/null"
    foreach ($backend in $backends) {
        Invoke-Docker cp "${generator}:/out/ducklake.$backend" (Join-Path $OutDir "ducklake.$backend")
    }
    docker rm -f $generator | Out-Null
}

function New-PostgresFixture {
    $password = -join (1..24 | ForEach-Object { 'abcdefghijkmnpqrstuvwxyz23456789'[(Get-Random -Maximum 32)] })
    Invoke-Docker network create $network | Out-Null

    # Passed by name, so that the password does not show up in the process list.
    $env:POSTGRES_PASSWORD = $password
    try {
        # The data directory lives in memory: the image declares it as a volume, which `docker rm` may leave behind.
        Invoke-Docker run -d --name $pgServer --network $network --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD `
            -e "POSTGRES_USER=$pgUser" -e "POSTGRES_DB=$pgDatabase" $postgresImage | Out-Null
    }
    finally {
        Remove-Item Env:POSTGRES_PASSWORD
    }
    # The image first starts a temporary server that only listens on a socket; wait for the real one.
    $ready = $false
    for ($attempt = 0; $attempt -lt 60 -and -not $ready; $attempt++) {
        docker exec $pgServer pg_isready -h 127.0.0.1 -U $pgUser -d $pgDatabase 2>&1 | Out-Null
        $ready = $LASTEXITCODE -eq 0
        if (-not $ready) { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw "$pgServer did not become ready" }

    $env:AANTJE_DSN = "host=$pgServer port=5432 dbname=$pgDatabase user=$pgUser password=$password"
    try {
        Invoke-Docker run --rm --name $generator --network $network -v "${PSScriptRoot}:/fixtures:ro" -e AANTJE_DSN `
            $pythonImage sh -c "$install && python /fixtures/generate.py postgres --dsn `"`$AANTJE_DSN`""
    }
    finally {
        Remove-Item Env:AANTJE_DSN
    }

    $snapshots = docker exec $pgServer psql -U $pgUser -d $pgDatabase -Atc `
        'SELECT string_agg(snapshot_id::text, '','' ORDER BY snapshot_id) FROM ducklake_snapshot'
    if ($snapshots -ne $expectedSnapshots) {
        throw "Unexpected snapshot ids '$snapshots' (test/support/expected.ts says $expectedSnapshots)"
    }

    # Only the metadata tables, as plain INSERT statements: loads into an empty database with any client.
    Invoke-Docker exec $pgServer pg_dump -U $pgUser -d $pgDatabase --no-owner --no-privileges --column-inserts `
        '--table=public.ducklake_*' -f /tmp/postgres.sql
    $dump = New-TemporaryFile
    try {
        Invoke-Docker cp "${pgServer}:/tmp/postgres.sql" $dump.FullName
        # pg_dump 17.6+ adds psql-only \restrict lines with a random key: not loadable by other clients, never reproducible.
        $lines = [IO.File]::ReadAllLines($dump.FullName) | Where-Object { $_ -notmatch '^\\(un)?restrict ' }
        $utf8 = [Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $OutDir 'postgres.sql'), ($lines -join "`n") + "`n", $utf8)
    }
    finally {
        Remove-Item $dump.FullName -ErrorAction SilentlyContinue
    }
}

try {
    Remove-Resources
    if ($Only -in 'all', 'sqlite', 'duckdb') {
        New-FileFixtures $(if ($Only -eq 'all') { @('sqlite', 'duckdb') } else { @($Only) })
    }
    if ($Only -in 'all', 'postgres') {
        New-PostgresFixture
    }
}
finally {
    Remove-Resources
}
