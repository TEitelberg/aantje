#Requires -Version 7.0
<#
.SYNOPSIS
Builds the platform-specific VSIX packages of aantje into artifacts/ and verifies them.

.DESCRIPTION
The DuckDB engine is a native binding, so every platform gets its own VSIX (see docs/en/packaging.md).

win32-x64 is built on the machine that runs the script: vsce package, which runs the build. The dependencies must be installed (npm ci).
linux-x64 is built in a throw-away container: the project is copied in without node_modules, dist and artifacts,
npm ci installs the Linux binding, then the same build and vsce package run. Needs Docker with Linux containers.

Unless -SkipVerify is given, each VSIX is then verified:
1. Only the expected files are inside (the allow-list of .vscodeignore, one DuckDB binding for the target).
2. Unpacked, its DuckDB binding loads and reports the engine version, with the Node of the target platform: this machine's
   Node for win32-x64, the Node of the code-server image for linux-x64.
3. It installs with the CLI (code, code-server) into a temporary extensions directory, is listed there, and the
   installed copy loads the binding too.

Docker resources are named "aantje-test-*" and removed at the end, also when the script fails.

.PARAMETER Target
The platform to build. "all" builds win32-x64 and linux-x64.

.PARAMETER SkipVerify
Only build; skip the three checks above.

.EXAMPLE
.\scripts\package.ps1

.EXAMPLE
.\scripts\package.ps1 -Target linux-x64 -SkipVerify
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'win32-x64', 'linux-x64')]
    [string] $Target = 'all',
    [switch] $SkipVerify
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
$manifest = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$extensionId = "$($manifest.publisher).$($manifest.name)"

$prefix = 'aantje-test-'
$packContainer = "${prefix}pack"
$checkContainer = "${prefix}check"
# Debian 12 has glibc 2.36, older than the 2.41 of the Debian 13 that code-server 4.144.0 runs on.
$buildImage = 'node:24-bookworm-slim'
$serverImage = 'codercom/code-server:4.144.0'
$serverNode = '/usr/lib/code-server/lib/node'

# Loads the native binding the way the bundle does (resolved from dist/) and asks it for the engine version. The
# JavaScript API of DuckDB is part of dist/extension.js; the queries are proven by the integration and E2E tests.
$checkScript = @'
const { createRequire } = require('node:module');
const { join } = require('node:path');

const extension = process.argv[2];
const bindings = createRequire(join(extension, 'dist', 'extension.js'))('@duckdb/node-bindings');
const version = bindings.library_version();
console.log(`${process.platform}-${process.arch} node ${process.version}: DuckDB ${version}`);
if (!/^v\d+\.\d+/.test(version)) process.exitCode = 1;
'@

# Runs a native command. Its output is echoed as it arrives and returned as lines; a non-zero exit code throws.
function Invoke-Native {
    $command = $args[0]
    $arguments = @($args | Select-Object -Skip 1)
    & $command @arguments 2>&1 | ForEach-Object { "$_" } | Tee-Object -Variable lines | Write-Host
    if ($LASTEXITCODE -ne 0) {
        throw "$command $($arguments[0]) failed with exit code $LASTEXITCODE"
    }
    $lines
}

function Remove-Container([string] $Name) {
    docker rm -f $Name 2>&1 | Out-Null
    # A missing container is the normal case; do not leave its exit code behind as the exit code of the script.
    $global:LASTEXITCODE = 0
}

function Get-VsixPath([string] $Platform) {
    Join-Path $artifacts "$($manifest.name)-$Platform-$($manifest.version).vsix"
}

# The README of the detail page is derived from README.md by scripts/marketplace-readme.mjs.
$marketplaceReadme = 'out/marketplace-readme.md'

# The content check of a package; the release workflow runs the same script.
. (Join-Path $PSScriptRoot 'check-vsix.ps1')

function Build-Win32 {
    if (-not (Test-Path (Join-Path $root 'node_modules/@duckdb/node-bindings-win32-x64'))) {
        throw 'The win32-x64 DuckDB binding is not installed. Run "npm ci" in the project directory first.'
    }
    Push-Location $root
    try {
        # vsce runs the build itself (vscode:prepublish).
        $null = Invoke-Native npx --no-install vsce package --target win32-x64 --out "$artifacts/" --readme-path $marketplaceReadme
    }
    finally {
        Pop-Location
    }
}

function Build-Linux {
    $steps = @(
        'set -euo pipefail'
        'mkdir /work'
        # The host's node_modules hold the Windows binding and dist is rebuilt; the git history, the caches and the test
        # output are not needed for a package. out/ stays: it holds the derived README.
        'tar -C /src --anchored --exclude=./node_modules --exclude=./dist --exclude=./.vscode-test --exclude=./artifacts --exclude=./.git --exclude=./test/.cache --exclude=./test/e2e/out --exclude=./test/.tmp -cf - . | tar -C /work -xf -'
        'cd /work'
        'npm ci --no-audit --no-fund'
        "npx --no-install vsce package --target linux-x64 --out /out/ --readme-path $marketplaceReadme"
    )
    Remove-Container $packContainer
    try {
        $null = Invoke-Native docker run --rm --name $packContainer -v "${root}:/src:ro" -v "${artifacts}:/out" $buildImage bash -c ($steps -join '; ')
    }
    finally {
        Remove-Container $packContainer
    }
}

function Expand-Vsix([string] $Vsix, [string] $Destination) {
    [IO.Compression.ZipFile]::ExtractToDirectory($Vsix, $Destination)
    Join-Path $Destination 'extension'
}

function Assert-Listed([string[]] $Listed) {
    $expected = "$extensionId@$($manifest.version)"
    if ($Listed -notcontains $expected) {
        throw "--list-extensions printed [$($Listed -join ', ')] but not $expected."
    }
}

function Test-Win32Vsix([string] $Vsix, [string] $Work) {
    $check = Join-Path $Work 'check-duckdb.cjs'
    $unpacked = Expand-Vsix $Vsix (Join-Path $Work 'win32-unpacked')
    $null = Invoke-Native node $check $unpacked

    if (-not (Get-Command code -ErrorAction SilentlyContinue)) {
        Write-Warning 'The VS Code CLI (code) is not in PATH; the installation check is skipped.'
        return
    }
    $extensions = Join-Path $Work 'code-extensions'
    $options = '--extensions-dir', $extensions, '--user-data-dir', (Join-Path $Work 'code-user-data')
    # The CLI of VS Code 1.143 prints a deprecation warning of its own (url.parse).
    $env:NODE_NO_WARNINGS = '1'
    try {
        $null = Invoke-Native code --install-extension $Vsix @options
        $listed = Invoke-Native code --list-extensions --show-versions @options
    }
    finally {
        Remove-Item Env:NODE_NO_WARNINGS
    }
    Assert-Listed $listed
    $installed = Get-ChildItem $extensions -Directory -Filter "$extensionId-*" | Select-Object -First 1
    $null = Invoke-Native node $check $installed.FullName
}

function Test-LinuxVsix([string] $Vsix, [string] $Work) {
    $null = Expand-Vsix $Vsix (Join-Path $Work 'linux-unpacked')
    # Offline on purpose: nothing of the package may need the network.
    $run = 'run', '--rm', '--network', 'none', '--name', $checkContainer, '-v', "${Work}:/work:ro"
    $server = 'code-server --config /tmp/cs/config.yaml --user-data-dir /tmp/cs/data --extensions-dir /tmp/cs/ext'
    $steps = @(
        'set -eu'
        'export NODE_NO_WARNINGS=1'
        'mkdir -p /tmp/cs'
        "$server --install-extension /artifacts/$(Split-Path -Leaf $Vsix)"
        "$server --list-extensions --show-versions"
        "$serverNode /work/check-duckdb.cjs /tmp/cs/ext/$extensionId-*"
    )
    Remove-Container $checkContainer
    try {
        $null = Invoke-Native docker @run --entrypoint $serverNode $serverImage /work/check-duckdb.cjs /work/linux-unpacked/extension
        $listed = Invoke-Native docker @run -v "$(Split-Path -Parent $Vsix):/artifacts:ro" --entrypoint bash $serverImage -c ($steps -join '; ')
    }
    finally {
        Remove-Container $checkContainer
    }
    Assert-Listed $listed
}

$platforms = if ($Target -eq 'all') { 'win32-x64', 'linux-x64' } else { @($Target) }
$work = Join-Path ([IO.Path]::GetTempPath()) "aantje-package-$PID"
# vsce and esbuild print UTF-8, which PowerShell would otherwise decode with the OEM code page.
$consoleEncoding = [Console]::OutputEncoding
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    $null = New-Item -ItemType Directory -Force $artifacts, $work
    Set-Content (Join-Path $work 'check-duckdb.cjs') $checkScript -Encoding utf8NoBOM
    $null = Invoke-Native node (Join-Path $PSScriptRoot 'marketplace-readme.mjs')

    foreach ($platform in $platforms) {
        $vsix = Get-VsixPath $platform
        Remove-Item $vsix -ErrorAction SilentlyContinue
        Write-Host "==> ${platform}: build"
        if ($platform -eq 'win32-x64') { Build-Win32 } else { Build-Linux }
        if (-not (Test-Path $vsix)) {
            throw "The build did not create $vsix."
        }
        if (-not $SkipVerify) {
            Write-Host "==> ${platform}: verify"
            Assert-VsixContents $vsix $platform
            if ($platform -eq 'win32-x64') { Test-Win32Vsix $vsix $work } else { Test-LinuxVsix $vsix $work }
        }
    }

    Write-Host "`nPackages in $artifacts"
    foreach ($platform in $platforms) {
        $file = Get-Item (Get-VsixPath $platform)
        Write-Host ('  {0}  {1} MB' -f $file.Name, ($file.Length / 1MB).ToString('N2', [cultureinfo]::InvariantCulture))
    }
}
finally {
    [Console]::OutputEncoding = $consoleEncoding
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
