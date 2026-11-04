# Packaging

aantje ships as one VSIX per platform. `scripts/package.ps1` builds both packages into `artifacts/` and verifies them:

- `aantje-win32-x64-<version>.vsix` for desktop VS Code on Windows x64 (about 21 MB).
- `aantje-linux-x64-<version>.vsix` for code-server and VS Code on Linux x64 with glibc (about 29 MB).

This page covers why there are two packages, how they are built, what is inside, how they are verified and how to add a platform. Installing is described in [Installation](installation.md).

## Targets

| Target      | Runs on                                                     | DuckDB engine in the package      | Built                               |
| ----------- | ----------------------------------------------------------- | --------------------------------- | ----------------------------------- |
| `win32-x64` | Desktop VS Code on Windows x64                              | `@duckdb/node-bindings-win32-x64` | On the machine that runs the script |
| `linux-x64` | code-server 4.144.0 (Debian 13), VS Code on glibc Linux x64 | `@duckdb/node-bindings-linux-x64` | In a Linux container                |

Why not one package: the DuckDB engine is a native library. `@duckdb/node-bindings` declares one optional dependency per platform, and `npm ci` installs only the one that matches the machine. The JavaScript is identical in both packages; only `node_modules/@duckdb/node-bindings-<platform>` differs. SQLite and PostgreSQL need no native code and work with any package. The DuckDB driver loads the engine on the first DuckDB connection ([DuckDB driver](driver-duckdb.md#the-native-binding)).

`vsce package --target <platform>` writes `TargetPlatform` into the manifest and the file name. A marketplace uses it to hand out the right package; VS Code does not check it when you install from a file.

aantje declares `extensionKind: workspace`, so it runs where the workspace runs: in code-server, or on the remote host of an SSH, Dev Containers or WSL window. Install the package for the platform of that host.

## Build the packages

Prerequisites:

- PowerShell 7 (`pwsh`). The `npm run package:*` scripts call it.
- Node.js 24 (22 is the minimum) and `npm ci`. The `win32-x64` build reuses `node_modules`, which must come from a Windows install. The script never installs or removes dependencies on the host.
- For `linux-x64`: Docker with Linux containers and network access (images `node:24-bookworm-slim` and, for verification, `codercom/code-server:4.144.0`).
- For the install check of `win32-x64`: the `code` command in `PATH`. Without it the script warns and skips that check.

```powershell
.\scripts\package.ps1
.\scripts\package.ps1 -Target win32-x64
.\scripts\package.ps1 -Target linux-x64 -SkipVerify
npm run package:win32
npm run package:linux
```

`-Target` is `all` (default), `win32-x64` or `linux-x64`. `-SkipVerify` only builds. A run takes a minute or two. The script stops at the first problem and removes its temporary directory and its containers (`aantje-test-pack`, `aantje-test-check`) at the end, also on failure. The version in the file name comes from `package.json`; add a `CHANGELOG.md` entry before a release build.

`win32-x64` runs `vsce package --target win32-x64 --out artifacts/` on the host; vsce runs the build first (`vscode:prepublish`), so the build runs once.

`linux-x64` runs in a throw-away container: the project is copied to `/work` without `node_modules`, `dist`, `.vscode-test`, `artifacts`, the git history, the DuckDB extension cache and the test output, `npm ci` installs the Linux binding, then the same build and `vsce package --target linux-x64` run, writing to `artifacts/`. The build image is Debian 12 (glibc 2.36), older than the glibc 2.41 of code-server 4.144.0's Debian 13, so anything compiled in the container also runs there. When you change the code-server version, update `$serverImage` in the script, and `$buildImage` if the Debian release changed.

### The vsce flags

- `--target <platform>` sets `TargetPlatform` and names the file.
- `--out artifacts/` names an existing directory (the script creates it); vsce then picks the file name.
- `--readme-path out/marketplace-readme.md` packs a README that the script derives from `README.md` right before the build. It leaves out the logo block and the `# aantje` heading (the detail page shows icon, name and publisher in its header) and the sections Security and Documentation. GitHub shows the full `README.md`. The script throws when the README no longer has the shape it expects.
- No `--allow-missing-repository`, `--baseContentUrl` or `--baseImagesUrl`: `package.json` has `repository` (`https://github.com/TEitelberg/aantje.git`), so vsce finds the GitHub project itself.
- Not used: `--no-dependencies` (it would drop DuckDB) and the flags that switch off the secret scan.

vsce rewrites every relative link and image of `README.md` and `CHANGELOG.md` in the package only: images to `https://github.com/TEitelberg/aantje/raw/HEAD/<path>`, links to `.../blob/HEAD/<path>`. The packaged README therefore needs the files on GitHub, and the screenshots stay out of the VSIX. Other pages under `docs/en/` are not rewritten; their links work between the pages inside the package. `npx vsce ls` lists what would be packed.

The JavaScript API `@duckdb/node-api` is bundled into `dist/extension.js`; only the native `@duckdb/node-bindings*` are packaged as files, so `vsce` has nothing to warn about.

## What is inside the VSIX

`.vscodeignore` is an allow-list: `**` excludes everything and `!` lines add the runtime files back. A `!` rule wins over every exclusion, so to keep a file out, do not allow it. `scripts/check-vsix.ps1` checks the same list on the finished package, for `scripts/package.ps1` and for the release workflow before it uploads a package, so a change to `.vscodeignore` needs a change there. A package has about 440 files, and the engine library is by far the largest part.

| Path in the VSIX                                          | Why                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `extension/dist/extension.js`                             | The bundled extension. The source map is not shipped: it embeds the TypeScript sources.                                      |
| `extension/dist/sql-wasm.wasm`                            | The SQLite driver reads the WebAssembly binary from disk.                                                                    |
| `extension/dist/grid-client.js`                           | The script of the data grid webview ([Data grid](grid.md)).                                                                  |
| `extension/dist/report-client.js`                         | The script of the report webviews, with ECharts ([Statistics report](statistics.md), [Snapshot report](snapshot-report.md)). |
| `extension/package.json`                                  | The manifest.                                                                                                                |
| `extension/readme.md`, `changelog.md`, `LICENSE.txt`      | From `README.md` (the derived one), `CHANGELOG.md` and `LICENSE`; vsce renames them.                                         |
| `extension/THIRD-PARTY-NOTICES.md`                        | Licence notices of the bundled npm packages, generated by `scripts/notices.mjs` during the build.                            |
| `extension/media/`                                        | `icon.png`, `logo.png` and `aantje-activity.svg`.                                                                            |
| `extension/docs/en/*`                                     | The documentation travels with the extension.                                                                                |
| `extension/node_modules/@duckdb/node-bindings`            | The loader of the native binding, loaded lazily.                                                                             |
| `extension/node_modules/@duckdb/node-bindings-<platform>` | The native engine: exactly one, the one of the target.                                                                       |

Webview scripts are the files that the extension serves itself. A webview may read only `dist` (`localResourceRoots`), so a missing script opens an empty panel. A file that has to travel therefore needs three matching entries: a `!` line in `.vscodeignore`, the allowed pattern in `Assert-VsixContents` and its list of required files in `scripts/package.ps1`.

Not inside: the source map, `src`, `test` and its fixtures, `scripts`, `.vscode`, configuration files, `package-lock.json`, `artifacts`, the bindings of other platforms and every other npm package (`pg`, `sql.js` and the rest are bundled into `dist/extension.js`). `detect-libc` is left out too: without it the loader falls back to the glibc binding, the only Linux binding in the package. An Alpine package would be a separate target.

## Release

`.github/workflows/release.yml` builds a release for every change that is merged into `main` (`main` is protected, so changes arrive through pull requests only). A release has two steps, and only the second one publishes:

1. **Pre-release on GitHub, for every merge.** `scripts/next-version.mjs` takes the newest of the `vX.Y.Z` tags and of the version on Open VSX and counts the patch part up; a `release:minor` or `release:major` label on the merged pull request, or the input of a manual run, counts that part instead. Without a tag the version of `package.json` is the first release. The version is never committed: `vsce package <version> --no-update-package-json` sets it in the package only. Both packages are built on their own platform (`ubuntu-latest` for linux-x64, `windows-latest` for win32-x64) with the README of the detail page from `scripts/marketplace-readme.mjs`. Then the tag `vX.Y.Z` and a GitHub **pre-release** with both packages and generated notes are created. Open VSX is not touched. A change that touches only `docker/` or `.github/` is no release; start one with the manual run if needed.
2. **Open VSX, when the owner releases it.** On GitHub open the release (Releases, edit) and remove the tick of "Set as a pre-release". That event (`released`) starts the last job of the workflow, which downloads the two packages of that release and publishes them with `ovsx publish` and the secret `OVSX_PAT`. A release without exactly the two packages, or without the secret, fails with a message. The workflow cannot do this step by itself: a release that its own token created starts no workflow.

So Open VSX has only the versions that were released on purpose, and a version number can be skipped there (the tags go on counting). The publisher namespace `teitelberg` must exist on open-vsx.org (`npx ovsx create-namespace teitelberg -p <token>`) before the first publish. Releases to the Visual Studio Marketplace are not part of the workflow.

## Verification

After each build `package.ps1` runs three checks and fails on the first problem:

1. **Contents.** The VSIX is read as a zip. Every entry must match the allow-list, the required entries must exist, exactly one DuckDB binding is inside and the manifest declares the right `TargetPlatform`.
2. **Binding.** The VSIX is unpacked into a clean directory. A small script resolves `@duckdb/node-bindings` from `extension/dist/` the way the bundle does and asks it for the engine version; the queries are proven by the integration and E2E tests. `win32-x64` uses the Node of the machine; `linux-x64` uses the Node of code-server in a container without network.
3. **Installation.** `code --install-extension` (`win32-x64`) or `code-server --install-extension` (`linux-x64`, in the container) installs the VSIX into a temporary extensions directory. `--list-extensions --show-versions` must print `teitelberg.aantje@<version>`, and check 2 runs again on the installed copy.

To repeat the install check by hand, install the VSIX with `--extensions-dir` and `--user-data-dir` pointing to a temporary directory, then list the extensions with the same options.

## Install a VSIX

Install the package for the platform of the host that runs the extension.

```powershell
code --install-extension artifacts\aantje-win32-x64-0.1.0.vsix
```

```bash
code-server --install-extension aantje-linux-x64-0.1.0.vsix
```

In desktop VS Code you can also use **Install from VSIX...** in the Extensions view menu. Reload the window afterwards. Installing a newer VSIX over an older one updates it; `code --uninstall-extension teitelberg.aantje` removes it. Add `--extensions-dir <dir>` for a non-default code-server directory. [Installation](installation.md) covers machine settings and preconfigured connections.

### A package for the wrong platform

VS Code does not compare the target platform of a VSIX with the platform of the host, and both CLIs install the wrong package without a message. The mistake shows at the first DuckDB connection: aantje reports that the native DuckDB engine could not be loaded on this platform. SQLite and PostgreSQL connections keep working. Uninstall the extension (`teitelberg.aantje`) and install the right package.

## Add a platform

1. Find the binding in the table of [DuckDB driver](driver-duckdb.md#the-native-binding). It is an optional dependency of `@duckdb/node-bindings`.
2. Build where `npm ci` installs that binding, on a machine or in a container of that platform. The package must contain exactly that one binding, and verification needs a runtime of the platform too.
3. In `scripts/package.ps1`, add the target to the `ValidateSet` of `-Target`, a build function like `Build-Linux` and a check function like `Test-LinuxVsix`. The content check derives the binding from the target name (`@duckdb/node-bindings-<target>`); the Alpine targets need an explicit mapping because their packages end in `-musl`.
4. Leave `.vscodeignore` as it is: it allows all of `node_modules/@duckdb/**`, and the content check rejects a second binding.
5. Run the script and update the platform lists in `README.md` and [Installation](installation.md).

## Known limits

- Only `win32-x64` and `linux-x64` (glibc) are built. macOS, arm64 and Alpine are not supported.
- No source map in the package. `npm run build` still writes it for local debugging; to debug a packaged build, allow `dist/extension.js.map` in `.vscodeignore` and in the allow-list of `scripts/check-vsix.ps1`.
- The bundle contains MIT and ISC packages whose licences require their notice to travel with every copy, so `THIRD-PARTY-NOTICES.md` is part of the package and the content check requires it.
- The DuckDB extensions that the data features use (`ducklake`, `sqlite` or `postgres`, `httpfs`, `quack` for a Quack catalog, `azure` for an Azure lake) are not in the package. DuckDB downloads them on first use, so Select Top 1000 Rows needs network access once per machine, or `aantje.duckdb.extensionDirectory` must point to a directory that holds them ([Data access](data-access.md#extension-directory-and-offline-use)). The explorer itself needs no download. The `SELECT 42` check proves that the engine loads, not that these extensions can be installed.
- Publishing to a marketplace is not covered.
