# Extension-host tests

The extension-host tests run the built aantje inside a real, downloaded desktop VS Code. They sit next to the unit and contract suites of [Testing](testing.md) and prove what those cannot: that the pieces are wired together the way VS Code needs.

## Why a second kind of test

The unit tests run in plain Node with plain objects as ports. A mistake in the part that touches VS Code stays invisible there: a command declared in `package.json` but not registered, a tree item without its `contextValue`, a setting written to the wrong target, a status bar item that is never shown, or a native DuckDB engine that the extension host cannot load. These adapters are small, but a user meets every such mistake at once. The extension-host tests run the real `dist/extension.js` with the real fixture catalogs.

## What is covered

- Activation, the registered commands against the manifest, the view container and the tree view.
- Connections: the wizard for SQLite, DuckDB and PostgreSQL with scripted prompts, edit, remove, test, refresh, disconnect, and warnings about invalid settings.
- The tree, the status bar item, the output channel and which commands and menu entries each node offers.
- The data preview and the grid, views and their trust confirmation, S3 credentials against a fake endpoint, and notebooks.
- Script as, Maintenance, Time Travel and Change commands, and the SQL editor with its results panel.
- The report panels (statistics, snapshot, storage, schema history, activity, growth, dependencies, advisor, health) and the messages their pages send.

There is no real PostgreSQL in this suite. The PostgreSQL wizard runs against a small fake server that asks for a password and refuses the session, which proves the prompt and that the password stays out of settings and messages. A real server is part of the [end-to-end tests](e2e-tests.md#postgresql-for-specs).

## Running

```bash
npm run test:integration
npx vscode-test --grep "DuckDB"
npx vscode-test --code-version stable
```

`npm run test:integration` builds the extension and starts `vscode-test`. The test code is compiled by `.vscode-test.mjs` on every start.

- The first run downloads VS Code into `.vscode-test/` (about 340 MB for Windows) and needs network access.
- The tests use the oldest VS Code that `engines.vscode` allows (currently 1.140.0). `--code-version` runs another version.
- The tests open a visible VS Code window and need a display. On Linux without one, use a virtual display: `xvfb-run -a npm run test:integration`, as CI does ([Testing](testing.md#continuous-integration)).
- A failure names the test and what it waited for or compared. Stack lines refer to the bundle `out/integration.js`.
- VS Code prints many startup warnings to the console. They are harmless.
- A killed run can leave its VS Code open. This stops only the downloaded copy:

```powershell
Get-Process Code | Where-Object { $_.Path -like '*\.vscode-test\*' } | Stop-Process
```

## How the host is isolated

`.vscode-test.mjs` gives VS Code a profile of its own in a temporary directory, which is removed when the run ends. No settings, extensions or state of the developer leak in, and `--disable-extensions` is set. The profile switches off telemetry, workspace trust, updates, experiments and chat features. `VSCODE_*` variables are removed from the environment, so a run started in another VS Code terminal does not inherit its state. VS Code opens `test/integration/workspace`.

Tests write only to the system temp directory and the settings of the run. They work on private copies of the fixtures, because DuckDB locks its file. The next run removes leftovers that are older than a day.

## How a test works

The test bundle is built with esbuild and started by `@vscode/test-cli` inside the extension host under mocha. Tests use the extension the way the UI does:

- Commands run through `vscode.commands.executeCommand`, with the tree node as the argument, like a context menu.
- `activate()` returns an API object (tree, view, editors, results, context keys) only when the extension host runs a test (`ExtensionMode.Test`).
- The setting `aantje.connections` is written through the configuration API, so the whole chain from setting to tree runs.

**The scripted user.** Tests cannot click, so a helper replaces the prompts, message functions, status bar messages and the clipboard of `vscode.window` and `vscode.env` for one test. It answers prompts from a script, validates input like VS Code does and records everything the extension shows, including error buttons. An unexpected prompt counts as a cancel and fails the test at the end. Nothing of aantje's own code is replaced.

**Watching views.** The extension host API cannot read what the workbench renders, so tests observe what the extension hands to VS Code and what the view asks for: tree calls, status bar items, reveal options, created webview panels and the messages posted to them, and the log file of the output channel. For report panels a test calls the receivers the extension registered for the page, and so pushes an action through the real message path while the real page has loaded.

**Waiting.** Tests use `waitFor` (default limit 15 seconds, 30 per test) on conditions, never fixed delays. Connections get unique ids so a tree view never meets a node an earlier test expanded.

**Clean-up.** After every test the host is reset: replaced functions are restored, settings removed, readers and panels closed, and only then temporary files deleted (Windows cannot delete a DuckDB file that is open).

**Order.** An extension activates once per window, and one test needs an invalid setting before activation. Nothing may activate the extension before it, so the suite order is fixed.

## Tests of the data preview

The data tests use the real engine, so they need the DuckDB extensions in `test/.cache/duckdb-extensions` like the unit tests of `src/data`. Without the cache and without network access they are skipped with a reason. They copy the data fixture to a private directory, point `aantje.duckdb.extensionDirectory` at the cache and read through the real grid page. S3 runs against a local server that answers "access denied" and records each request, so the tests prove where the engine sends requests and with which key id, not that objects can be read. Trust for views is checked with two connections, to prove that only the trusted one is read again.

## Break-it check

The procedure of [Testing](testing.md) applies, with two additions. The copy needs junctions to `.vscode-test` and `test/.cache`, or every mutation downloads again. Every mutation needs a build in the copy, because the extension is bundled from the mutated sources.

```powershell
$m = "$env:TEMP\aantje-mut-it"
robocopy . $m /E /XD node_modules dist .vscode-test out .cache /NFL /NDL /NJH /NJS | Out-Null
New-Item -ItemType Junction -Path "$m\node_modules" -Target (Resolve-Path node_modules) | Out-Null
New-Item -ItemType Junction -Path "$m\.vscode-test" -Target (Resolve-Path .vscode-test) | Out-Null
New-Item -ItemType Junction -Path "$m\test\.cache" -Target (Resolve-Path test\.cache) | Out-Null
# edit a file in $m, then: Set-Location $m; node esbuild.mjs; npx vscode-test
```

Remove the three junctions with `(Get-Item "<path>").Delete()` before you delete the copy.

## Known limits

- The suite runs on one platform at a time. It was developed on Windows x64; CI runs it on Linux after every merge into `main` and every week. macOS is not run. code-server is covered by the end-to-end tests.
- Quick picks, input boxes and dialogs are answered at the API of `vscode.window`. How VS Code draws them is not tested, and neither are pixels, icons or expansion state of the view.
- The extension host API cannot read a stored secret. S3 credentials are proven by their effect (the request is signed or not); the PostgreSQL password only by "does not fail and does not leak".
- `readOutputChannel` depends on where VS Code writes the log file. A future VS Code could move it.
- S3 is a fake: virtual-host style (`urlStyle: vhost`) is not tested.
- A very slow machine can hit the `waitFor` or test time limits.
