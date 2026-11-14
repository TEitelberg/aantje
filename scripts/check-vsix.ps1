#Requires -Version 7.0
<#
.SYNOPSIS
Checks the contents of a platform VSIX of aantje: only the files of the allow-list, one DuckDB binding for the platform.

.DESCRIPTION
Used by scripts/package.ps1 for local builds and by .github/workflows/release.yml before a package is uploaded, so the
packages that users receive are the checked ones. Dot-source it for Assert-VsixContents, or run it with -Vsix and
-Platform.
#>
param(
    [string] $Vsix,
    [string] $Platform
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-VsixContents([string] $Vsix, [string] $Platform) {
    $binding = "@duckdb/node-bindings-$Platform"
    # vsce renames README.md, CHANGELOG.md and LICENSE inside the package.
    $allowed = @(
        '^\[Content_Types\]\.xml$'
        '^extension\.vsixmanifest$'
        '^extension/(package\.json|readme\.md|changelog\.md|LICENSE\.txt|THIRD-PARTY-NOTICES\.md)$'
        '^extension/dist/(extension\.js|sql-wasm\.wasm|grid-client\.js|report-client\.js|plan-client\.js)$'
        '^extension/media/(icon\.png|logo\.png|aantje-activity\.svg|aantje-icons\.woff)$'
        '^extension/docs/en/[^/]+\.md$'
        '^extension/node_modules/@duckdb/node-bindings/'
        "^extension/node_modules/$([regex]::Escape($binding))/"
    ) -join '|'
    $required = @(
        'extension/package.json', 'extension/readme.md', 'extension/changelog.md'
        'extension/LICENSE.txt', 'extension/THIRD-PARTY-NOTICES.md'
        'extension/dist/extension.js', 'extension/dist/sql-wasm.wasm', 'extension/dist/grid-client.js'
        'extension/dist/report-client.js', 'extension/dist/plan-client.js'
        'extension/node_modules/@duckdb/node-bindings/duckdb.js'
        "extension/node_modules/$binding/duckdb.node"
    )

    $zip = [IO.Compression.ZipFile]::OpenRead($Vsix)
    try {
        # Directories have an empty Name.
        $names = @($zip.Entries | Where-Object Name | ForEach-Object FullName)
        $reader = [IO.StreamReader]::new($zip.GetEntry('extension.vsixmanifest').Open())
        try { $vsixManifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    finally {
        $zip.Dispose()
    }

    $problems = @()
    $unexpected = @($names -cnotmatch $allowed)
    if ($unexpected) {
        $problems += "unexpected files ($($unexpected.Count)): $(($unexpected | Select-Object -First 8) -join ', ')"
    }
    $missing = @($required | Where-Object { $names -cnotcontains $_ })
    if ($missing) {
        $problems += "missing files: $($missing -join ', ')"
    }
    if ($vsixManifest -notmatch "TargetPlatform=`"$Platform`"") {
        $problems += "the manifest does not declare TargetPlatform=$Platform"
    }
    if ($problems) {
        throw "$Vsix is not as expected:`n  $($problems -join "`n  ")"
    }
    Write-Host "  contents ok: $($names.Count) files, one DuckDB binding ($binding)"
}

if ($Vsix) {
    Assert-VsixContents $Vsix $Platform
}
