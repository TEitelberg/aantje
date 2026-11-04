#Requires -Version 7.0
<#
.SYNOPSIS
Runs the browser end-to-end specs of aantje against code-server in Docker (see docs/en/e2e-tests.md).

.DESCRIPTION
Starts code-server 4.144.0 with the linux-x64 VSIX installed (artifacts/aantje-linux-x64-<version>.vsix) and a
Playwright container that runs test/e2e/specs/<name>.mjs against it. Prints PASS or FAIL per spec; screenshots and one
JSON result per spec land in test/e2e/out/. Unless -Keep, -Reuse or -Up is given, everything it created is removed at
the end, also when it fails.

Docker resources (all named aantje-test-e2e-*; with -Instance <name> the name is aantje-test-e2e-<name>-*):
  aantje-test-e2e-net     network
  aantje-test-e2e-cs      code-server (port 8080 is published on a random 127.0.0.1 port)
  aantje-test-e2e-data    volume with the user data directory of code-server
  aantje-test-e2e-run     the Playwright container of the current run
  aantje-test-e2e-runner  image of the Playwright container (shared by all instances, see -RemoveImages)

The exit code is 0 when every spec passed.

.PARAMETER Spec
Names of specs (test/e2e/specs/<name>.mjs without the extension), separated by commas or spaces, or "all".

.PARAMETER Keep
Leave the code-server container, its volume and the network in place, for looking at the workbench in a browser.

.PARAMETER Reuse
Use the environment that an earlier run left with -Keep (create it when it does not exist) and leave it in place.
The quickest way to run a spec again while you write it.

.PARAMETER Up
Only start the environment (like -Keep without specs), print the address of the workbench and leave it running.

.PARAMETER Clean
Remove the environment of an earlier run (-Keep, -Reuse, -Up, or a run that was killed) and stop.

.PARAMETER Instance
A name for the Docker resources, so that several runs can be active at the same time (for example one per developer
or agent). Lower-case letters, digits and hyphens.

.PARAMETER Vsix
The package to install instead of artifacts/aantje-linux-x64-<version>.vsix. Its folder is mounted into the container.

.PARAMETER SpecTimeoutSeconds
How long one spec may take before the runner cuts it off and counts it as failed (default 600).

.PARAMETER Rebuild
Build the linux-x64 VSIX first (scripts/package.ps1, about two minutes).

.PARAMETER RemoveImages
Remove the runner image at the end. The Playwright base image (mcr.microsoft.com/playwright, about 3.5 GB) stays; remove
it with docker rmi when you pulled it only for this.

.EXAMPLE
.\test\e2e\run.ps1

.EXAMPLE
.\test\e2e\run.ps1 -Spec smoke -Keep
#>
[CmdletBinding()]
param(
    [string[]] $Spec = @('all'),
    [switch] $Keep,
    [switch] $Reuse,
    [switch] $Up,
    [switch] $Clean,
    [ValidatePattern('^([a-z0-9]+(-[a-z0-9]+)*)?$')]
    [string] $Instance = '',
    [string] $Vsix = '',
    [ValidateRange(10, 3600)]
    [int] $SpecTimeoutSeconds = 600,
    [switch] $Rebuild,
    [switch] $RemoveImages
)

$ErrorActionPreference = 'Stop'

$e2e = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent $e2e)
$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$extensionId = "$($manifest.publisher).$($manifest.name)"
$out = Join-Path $e2e 'out'

$prefix = if ($Instance) { "aantje-test-e2e-$Instance-" } else { 'aantje-test-e2e-' }
$network = "${prefix}net"
$volume = "${prefix}data"
$server = "${prefix}cs"
$runner = "${prefix}run"
# --- PostgreSQL for specs that need one (pg.ps1) ---
. (Join-Path $e2e 'pg.ps1')
$postgres = "${prefix}pg"
# A spec asks for the database by reading E2E_POSTGRES_*.
function Test-NeedsPostgres([string[]] $Names) {
    @($Names | Where-Object { Select-String -Path (Join-Path $e2e "specs/$_.mjs") -Pattern 'E2E_POSTGRES' -Quiet }).Count -gt 0
}
# --- end PostgreSQL ---
# --- S3 server for specs that need one (s3.ps1) ---
. (Join-Path $e2e 's3.ps1')
$s3 = "${prefix}s3"
# A spec asks for the server by reading E2E_S3_*.
function Test-NeedsS3([string[]] $Names) {
    @($Names | Where-Object { Select-String -Path (Join-Path $e2e "specs/$_.mjs") -Pattern 'E2E_S3' -Quiet }).Count -gt 0
}
# --- end S3 ---
# Same version as $serverImage in scripts/package.ps1.
$serverImage = 'codercom/code-server:4.144.0'
# The version of the base image mcr.microsoft.com/playwright:v<version>-noble and of the npm package inside it. The
# tag of the runner image also holds a hash of its Dockerfile, so that a change of the file builds a new image.
$playwrightVersion = '1.64.1'
$dockerfileHash = (Get-FileHash (Join-Path $e2e 'runner/Dockerfile') -Algorithm SHA256).Hash.Substring(0, 8).ToLower()
$runnerImage = "aantje-test-e2e-runner:$playwrightVersion-$dockerfileHash"
# Where the user data directory of code-server is in its image.
$userData = '/home/coder/.local/share/code-server'

# Runs a native command; a non-zero exit code throws.
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($args[0]) failed with exit code $LASTEXITCODE"
    }
}

function Test-Docker {
    docker @args 2>&1 | Out-Null
    $LASTEXITCODE -eq 0
}

# Only the exact names above are ever touched. Missing resources are the normal case.
function Remove-Environment {
    docker rm -f $runner $server $postgres $s3 2>&1 | Out-Null
    docker network rm $network 2>&1 | Out-Null
    docker volume rm $volume 2>&1 | Out-Null
    $global:LASTEXITCODE = 0
}

function Get-ServerAddress {
    # Not "| Select-Object -First 1": that stops the pipeline early and leaves $LASTEXITCODE at an older value.
    $lines = @(docker port $server 8080/tcp 2>&1)
    if ($LASTEXITCODE -ne 0 -or "$($lines[0])" -notmatch ':(\d+)$') {
        throw "Cannot read the published port of ${server}: $lines"
    }
    "http://127.0.0.1:$($Matches[1])"
}

function Show-ServerLog([int] $Lines) {
    docker logs --tail $Lines $server 2>&1 | ForEach-Object { Write-Host "  $_" }
}

function Wait-Server([string] $Address) {
    $deadline = (Get-Date).AddSeconds(240)
    while ((Get-Date) -lt $deadline) {
        if ((docker inspect --format '{{.State.Status}}' $server) -ne 'running') {
            Show-ServerLog 60
            throw "The container $server stopped before code-server was ready."
        }
        try {
            if ((Invoke-WebRequest "$Address/healthz" -TimeoutSec 3 -SkipHttpErrorCheck).StatusCode -eq 200) {
                return
            }
        }
        catch {
            # Not listening yet.
        }
        Start-Sleep -Milliseconds 500
    }
    Show-ServerLog 60
    throw "code-server did not become ready within 240 s."
}

function Start-Server {
    Invoke-Docker network create $network | Out-Null
    Invoke-Docker volume create $volume | Out-Null
    # A new volume belongs to root; code-server runs as the user coder (uid 1000).
    Invoke-Docker run --rm --user 0 --entrypoint chown -v "${volume}:/data" $serverImage 1000:1000 /data
    $mounts = @(
        '-v', "${volume}:$userData"
        '-v', "$(Join-Path $e2e 'server'):/e2e/server:ro"
        '-v', "$(Join-Path $root 'test/fixtures'):/e2e/fixtures:ro"
        '-v', "$(Split-Path -Parent $vsixPath):/e2e/vsix:ro"
    )
    Invoke-Docker run -d --name $server --network $network -p 127.0.0.1::8080 @mounts `
        -e "E2E_VSIX=/e2e/vsix/$(Split-Path -Leaf $vsixPath)" -e "E2E_EXTENSION_ID=$extensionId" `
        --entrypoint /usr/lib/code-server/lib/node $serverImage /e2e/server/supervisor.mjs | Out-Null
    Wait-Server (Get-ServerAddress)
}

function Initialize-Runner {
    if (Test-Docker image inspect $runnerImage) {
        return
    }
    Write-Host "==> building $runnerImage (pulls the Playwright base image on the first run)"
    Invoke-Docker build -t $runnerImage --build-arg "PLAYWRIGHT_VERSION=$playwrightVersion" (Join-Path $e2e 'runner')
}

function Get-SpecNames {
    $available = @(Get-ChildItem (Join-Path $e2e 'specs') -Filter '*.mjs' | ForEach-Object BaseName | Sort-Object)
    $names = @($Spec | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() -replace '\.mjs$', '' } | Where-Object { $_ })
    if ($names -contains 'all') {
        return $available
    }
    $unknown = @($names | Where-Object { $_ -notin $available })
    if ($unknown) {
        throw "Unknown spec: $($unknown -join ', '). Available: $($available -join ', ')."
    }
    $names
}

function Write-Summary([string[]] $Names) {
    $failed = 0
    Write-Host "`nResults"
    foreach ($name in $Names) {
        $file = Join-Path $out "$name.json"
        if (-not (Test-Path $file)) {
            Write-Host ('  FAIL  {0}  no result was written' -f $name)
            $failed++
            continue
        }
        $result = Get-Content $file -Raw | ConvertFrom-Json
        $seconds = ($result.durationMs / 1000).ToString('N1', [cultureinfo]::InvariantCulture)
        $label = if ($result.ok) { 'PASS' } else { 'FAIL' }
        Write-Host ('  {0}  {1}  {2} steps, {3} s' -f $label, $name, @($result.steps).Count, $seconds)
        foreach ($warning in @($result.warnings)) {
            Write-Host "        WARN: $warning"
        }
        if (-not $result.ok) {
            $failed++
            $step = @($result.steps | Where-Object { -not $_.ok }) | Select-Object -First 1
            if ($step) {
                Write-Host "        failed step: $($step.name)"
            }
            Write-Host "        $((($result.error -split "`n") | Select-Object -First 1))"
        }
    }
    Write-Host "Screenshots, results and traces: $out"
    $failed
}

if (-not (Test-Docker version)) {
    throw 'Docker does not answer. Start Docker Desktop (Linux containers).'
}
if ($Clean) {
    Remove-Environment
    if ($RemoveImages) {
        docker rmi $runnerImage 2>&1 | Out-Null
    }
    $global:LASTEXITCODE = 0
    Write-Host "Removed the containers, the network and the volume $prefix*."
    return
}

$defaultVsix = Join-Path $root "artifacts/$($manifest.name)-linux-x64-$($manifest.version).vsix"
if ($Rebuild) {
    Write-Host '==> building the linux-x64 package'
    & (Join-Path $root 'scripts/package.ps1') -Target linux-x64 -SkipVerify
}
$vsixPath = if ($Vsix) { $Vsix } else { $defaultVsix }
if (-not (Test-Path $vsixPath)) {
    throw "$vsixPath does not exist. Build it with: npm run package:linux (or add -Rebuild)."
}
$vsixPath = (Resolve-Path $vsixPath).Path
if (-not $Vsix) {
    $sources = @('src', 'media') | ForEach-Object { Join-Path $root $_ }
    $sources += 'package.json', 'esbuild.mjs', 'README.md' | ForEach-Object { Join-Path $root $_ }
    $newest = Get-ChildItem $sources -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest.LastWriteTime -gt (Get-Item $vsixPath).LastWriteTime) {
        Write-Warning "$(Split-Path -Leaf $vsixPath) is older than $($newest.FullName); the specs run against the old build. Add -Rebuild."
    }
}

$names = if ($Up) { @() } else { Get-SpecNames }
if (-not $Up -and -not $names) {
    throw 'There is no spec in test/e2e/specs.'
}

$exists = Test-Docker container inspect $server
if ($exists -and -not ($Reuse -or $Up)) {
    throw "The container $server exists (a run with -Keep, a killed run, or a run of somebody else). Add -Reuse to run against it, or use -Clean to remove it (-Instance <name> makes a second environment)."
}
$keep = $Keep -or $Reuse -or $Up
$failed = 1
try {
    Initialize-Runner
    if ($exists) {
        Write-Host '==> using the existing code-server container'
    }
    else {
        Remove-Environment
        Write-Host '==> starting code-server'
        Start-Server
    }
    $address = Get-ServerAddress
    Write-Host "==> workbench: $address/ (127.0.0.1 only, for as long as the container lives)"
    # --- PostgreSQL for specs that need one ---
    $postgresArguments = @()
    if (-not $Up -and (Test-NeedsPostgres $names)) {
        if (-not (Test-Docker container inspect $postgres)) {
            Write-Host '==> starting PostgreSQL'
            Start-E2EPostgres $postgres $network (Join-Path $root 'test/fixtures/postgres.sql')
        }
        $postgresArguments = Get-E2EPostgresArguments $postgres
    }
    # --- end PostgreSQL ---
    # --- S3 server for specs that need one ---
    $s3Arguments = @()
    if (-not $Up -and (Test-NeedsS3 $names)) {
        if (-not (Test-Docker container inspect $s3)) {
            Write-Host '==> starting the S3 server'
            Start-E2ES3 $s3 $network
        }
        $s3Arguments = Get-E2ES3Arguments $s3
    }
    # --- end S3 ---

    if ($Up) {
        $failed = 0
    }
    else {
        New-Item -ItemType Directory -Force $out | Out-Null
        # The helper programs of the specs run in the container and need the DuckDB API, which the extension bundles.
        node (Join-Path $e2e 'build-duckdb-api.mjs')
        if ($LASTEXITCODE -ne 0) { throw 'Bundling the DuckDB API for the specs failed.' }
        Write-Host "==> running: $($names -join ', ')"
        # The timeout inside the container ends the run when a spec hangs in a way that the runner cannot cut off.
        $limit = ($SpecTimeoutSeconds + 30) * $names.Count + 120
        $run = @(
            'run', '--rm', '--init', '--name', $runner, '--network', $network, '--shm-size=1g'
            '-v', "${e2e}:/runner/e2e:ro"
            '-v', "${out}:/out"
            '-e', "E2E_URL=http://${server}:8080", '-e', "E2E_CONTROL=http://${server}:8081", '-e', 'E2E_OUT=/out', '-e', "E2E_SPEC_TIMEOUT_SECONDS=$SpecTimeoutSeconds"
            @($postgresArguments)
            @($s3Arguments)
            $runnerImage, 'timeout', '--kill-after=15', $limit, 'node', '/runner/e2e/runner/run-specs.mjs'
        )
        & docker @run $names
        Remove-Item Env:E2E_POSTGRES_PASSWORD, Env:E2E_S3_ACCESS_KEY, Env:E2E_S3_SECRET_KEY -ErrorAction SilentlyContinue
        $failed = Write-Summary $names
        # The log of the server explains a failure that the browser cannot see, such as a crash of the extension host.
        docker logs $server 2>&1 | Set-Content -Path (Join-Path $out "$($Instance ? "$Instance." : '')code-server.log") -Encoding utf8
    }
}
finally {
    if ($keep) {
        Write-Host "`nThe environment stays: open $(try { Get-ServerAddress } catch { '(not running)' })/ in a browser. Remove it with:"
        Write-Host "  .\test\e2e\run.ps1 -Clean$($Instance ? " -Instance $Instance" : '')"
    }
    else {
        Remove-Environment
    }
    if ($RemoveImages) {
        docker rmi $runnerImage 2>&1 | Out-Null
        Write-Host "Removed $runnerImage. The base image mcr.microsoft.com/playwright:v$playwrightVersion-noble stays; remove it with docker rmi."
    }
    $global:LASTEXITCODE = 0
}
exit ([int] ($failed -gt 0))
