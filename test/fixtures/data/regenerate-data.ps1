#Requires -Version 7.3
<#
.SYNOPSIS
Regenerates the DuckLake data fixtures (catalogs with Parquet files) of the aantje data tests.

.DESCRIPTION
Writes data-catalog.sqlite, data-catalog.duckdb, sqlite-files/ and duckdb-files/. Needs Docker and network access
(pip, DuckDB extensions). Python and DuckDB run only in a throw-away container named "aantje-test-datagen", which is
removed at the end, also when the script fails. See README.md in this directory.

.PARAMETER OutDir
Where the files are written. Defaults to this directory, which replaces the checked-in fixtures.
#>
[CmdletBinding()]
param([string] $OutDir = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
$OutDir = (New-Item -ItemType Directory -Force $OutDir).FullName
$generator = 'aantje-test-datagen'
$fixtures = Split-Path -Parent $PSScriptRoot

function Invoke-Docker {
    docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args[0]) failed with exit code $LASTEXITCODE" }
}

try {
    docker rm -f $generator 2>&1 | Out-Null
    # The files stay inside the container until they are complete; SQLite does not like bind mounts.
    Invoke-Docker run --name $generator -v "${fixtures}:/fixtures:ro" python:3.12-slim sh -c `
        'pip install --quiet --no-cache-dir --root-user-action=ignore duckdb==2.0.0 && mkdir /out && python /fixtures/data/generate-data.py --out /out'
    foreach ($name in 'data-catalog.sqlite', 'data-catalog.duckdb', 'sqlite-files', 'duckdb-files') {
        $target = Join-Path $OutDir $name
        if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        Invoke-Docker cp "${generator}:/out/$name" $target
    }
}
finally {
    docker rm -f $generator 2>&1 | Out-Null
}
