# Installation

The extension id is `teitelberg.aantje`. It is published on the [Open VSX Registry](https://open-vsx.org/extension/teitelberg/aantje), so editors that use Open VSX (VSCodium, code-server) install it by id. Desktop VS Code installs from the Visual Studio Marketplace, where aantje is not published; there you install a VSIX package. There is one VSIX per platform, because it contains the native DuckDB engine of that platform. Download it from the [releases page](https://github.com/TEitelberg/aantje/releases).

## Platforms

| Package                           | Runs on                                                               |
| --------------------------------- | --------------------------------------------------------------------- |
| `aantje-win32-x64-<version>.vsix` | Desktop VS Code on Windows x64                                        |
| `aantje-linux-x64-<version>.vsix` | Desktop VS Code on Linux x64 with glibc, and code-server on Linux x64 |

macOS, arm64 and Alpine (musl) are not supported. The extension needs VS Code 1.140 or newer. The other requirements (DuckDB extensions, Jupyter) are in the [README](../../README.md#requirements).

Install the package of the platform that runs the **extension host**. In code-server or a remote window that is the server, not the computer with the browser.

## Install

Editors that use Open VSX, by id:

```bash
codium --install-extension teitelberg.aantje
code-server --install-extension teitelberg.aantje
```

Desktop VS Code, from the VSIX of your platform:

```bash
code --install-extension aantje-win32-x64-0.1.0.vsix
```

Or open the Extensions view, choose `...` (Views and More Actions), then **Install from VSIX...**, and select the file. Reload the window afterwards. Installing a newer VSIX over an older one updates it; `code --uninstall-extension teitelberg.aantje` removes it.

code-server:

```bash
code-server --install-extension aantje-linux-x64-0.1.0.vsix
```

Add `--extensions-dir <dir>` for a non-default extensions directory. Run the command as the user that runs code-server. Reload the browser tab afterwards. In a container the extension is gone when the container is re-created, so install it while you build the image.

VS Code does not compare the platform of a VSIX with the platform of the host. A package of the wrong platform installs without a message; the first DuckDB connection then reports "The native DuckDB engine could not be loaded on this platform". Remove the extension and install the right package.

## Settings are machine scope

Every setting of aantje has machine scope: a workspace or a folder cannot change it, so a repository you open cannot add a connection or redirect the S3 endpoint ([Security](security.md)). The settings are stored where the extension host runs:

- In desktop VS Code in the user settings (`settings.json`).
- In code-server in the machine settings `Machine/settings.json` inside the user data directory (`--user-data-dir`, by default `~/.local/share/code-server`).

The Add Connection wizard writes `aantje.connections` there. The password or Quack token is never part of it; it goes to the secret storage ([Connections](connections.md), [Security](security.md)).

## Preconfigure connections

An administrator can provide connections without a password by putting `aantje.connections` into the machine settings before the first start, for example while building an image:

```json
{
  "aantje.connections": [
    {
      "name": "Example Lakehouse",
      "kind": "postgres",
      "host": "postgres",
      "database": "ducklake",
      "user": "ducklake"
    }
  ],
  "aantje.s3.endpoint": "http://minio:9000"
}
```

The entry is valid without `id`, `port` and `ssl` (see [Connections](connections.md#settings-format) for the defaults). The first connect asks the user for the password and stores it in the secret storage. If you write the file from a start script, merge into it: keep an `aantje.connections` array that users already have, and keep the file on a volume if the container is re-created. The format of each entry is in the [README](../../README.md#connection-profiles).

## Offline use

DuckDB downloads the extensions `ducklake`, `postgres`, `sqlite` or `quack`, `httpfs` and, for an Azure lake, `azure` on first use. On a machine without internet access, copy them into a directory and set `aantje.duckdb.extensionDirectory` to it ([Data access](data-access.md#extension-directory-and-offline-use)). Browsing the tree needs no download, except for a Quack catalog, whose explorer needs the `quack` extension.
