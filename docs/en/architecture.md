# Architecture

aantje (`teitelberg.aantje`) is a VS Code extension that explores DuckLake catalogs and runs SQL against them. This page maps the code: the runtime, the modules, the main data flows and the decisions behind them.

## Scope

A DuckLake catalog keeps its metadata (schemas, tables, views, columns, snapshots, data files) in a SQL database, in tables named `ducklake_*`. That database is PostgreSQL, a SQLite file, a DuckDB file or a DuckDB database that a DuckDB server serves over Quack. aantje reads those tables with plain SQL and shows them as a tree in its own Activity Bar container:

```text
connection
  schema
    table
      column
        nested field   (struct field, list element, map key and value)
    view
```

There are three separate paths:

- **The explorer** reads the metadata database only, read-only. It never touches the data files and never changes a catalog.
- **The data features** (Select Top 1000 Rows, Create Notebook, the columns of a view) read the data files read-only through a private, short-lived in-memory DuckDB that attaches the lake with the DuckLake extension ([Data access](data-access.md)).
- **The SQL editor** has writable sessions of its own and runs any SQL ([SQL editor](sql-editor.md)). It never shares a connection with the explorer.

## Runtime

aantje is a Node.js extension. `main` in `package.json` points to `dist/extension.js`, which esbuild bundles from `src/extension.ts`. `extensionKind` is `["workspace"]`: the extension runs in the extension host next to the workspace, locally in desktop VS Code (Windows x64, Linux x64) and on the server in code-server. A SQLite or DuckDB path and a PostgreSQL or Quack host name are resolved there. In code-server the secret storage belongs to the browser unless the server runs with `--enable-remote-storage` ([Connections](connections.md)).

There is no web build and virtual workspaces are unsupported: the extension needs Node file access, TCP sockets and a native DuckDB binary. The VSIX is built per platform (win32-x64, linux-x64) because of that binary. VS Code derives the activation events from `contributes`.

## Repository layout

| Path                                                                     | Content                                                                                                              |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/`                                                                   | The extension (module map below).                                                                                    |
| `test/unit`, `test/contract`                                             | vitest suites, run by `npm test`.                                                                                    |
| `test/integration`                                                       | Tests in a real desktop VS Code ([Extension-host tests](integration-tests.md)).                                      |
| `test/e2e`                                                               | Browser specs against code-server in Docker ([End-to-end tests](e2e-tests.md)).                                      |
| `test/fixtures`, `test/support`                                          | The checked-in catalogs and their generators; shared helpers ([Test fixtures](test-fixtures.md)).                    |
| `scripts/`                                                               | `notices.mjs`, `package.ps1`, `test-full.mjs`, `check-docs.mjs`, `ducklake-vocabulary.mjs`, `duckdb-vocabulary.mjs`. |
| `docs/en`                                                                | These pages.                                                                                                         |
| `media/`                                                                 | Icons.                                                                                                               |
| `esbuild.mjs`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts` | Build, type check, lint and unit test configuration.                                                                 |
| `dist/`, `out/`, `artifacts/`, `.vscode-test/`                           | Generated: the bundles, the compiled host tests, the VSIX packages, the downloaded VS Code.                          |

## Module map

Every file under `src/` is listed. Only `src/extension.ts` and files named `*.vscode.ts` may import `vscode` (see the next section). Everything else is plain Node and testable without an editor.

### Top level

| File                                                               | Job                                                                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `extension.ts`                                                     | Composition root: creates the adapters, wires and registers everything.                                |
| `actions.ts`                                                       | What the explorer commands compute (shown snapshot, qualified name, DDL).                              |
| `commands.vscode.ts`, `command.vscode.ts`                          | The explorer commands; `commandRegistrar` and `guarded` (log and show failures).                       |
| `active-connection.vscode.ts`, `status.ts`                         | The connection that node-less commands act on, and the status bar item.                                |
| `profile-watch.vscode.ts`, `profile-changes.ts`                    | Follow `aantje.connections`; decide which connections reopen.                                          |
| `pick.vscode.ts`, `progress.vscode.ts`, `cancel.ts`                | Pickers, notifications with Cancel, cancellation signals.                                              |
| `shutdown.ts`                                                      | `disposeAll`: close resources at once with a deadline.                                                 |
| `messages.ts`, `errors.ts`                                         | Texts for a missing connection; `AantjeError` and the error codes.                                     |
| `log.ts`, `log.vscode.ts`, `log-once.ts`, `secrets.ts`             | The `Logger` port, redaction, the output channel, one log line per failure kind.                       |
| `guards.ts`, `html-escape.ts`, `markdown.ts`, `order.ts`           | Message-guard helpers, escaping, Markdown building blocks, name ordering.                              |
| `snapshot.ts`, `time-travel.ts`, `compare.ts`, `compare.vscode.ts` | Snapshot texts, the time-travel and comparison questions, the diff documents.                          |
| `search.ts`                                                        | Rows and node ids of the catalog search.                                                               |
| `script.ts`, `script.vscode.ts`, `script-target.ts`                | SQL text builders and the untitled SQL document they open in.                                          |
| `script-templates.ts`, `script-templates/*`                        | The Script as matrix: `common`, `table`, `columns`, `layout`, `macros`, `new-objects`, `lake-queries`. |
| `maintenance.ts`                                                   | The texts of the Maintenance submenu.                                                                  |
| `maintenance-labels.ts`                                            | The names of the entries of the Maintenance menu, for the pages and documents of the reports.          |
| `maintenance-document.ts`                                          | `scriptDocument`: one script from blocks, shared by the Health check and the Advisor.                  |
| `properties.ts`                                                    | Markdown of the Properties report.                                                                     |

### `catalog/`: the metadata reader

| File                                                                                                       | Job                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model.ts`                                                                                                 | Driver-independent types and the `CatalogReader` interface.                                                                                              |
| `open.ts`                                                                                                  | `openCatalog(profile, options)`: opens the driver, creates the reader, checks the version.                                                               |
| `reader.ts`, `reader/*`                                                                                    | `createCatalogReader(driver)` merges the reads: `core`, `columns`, `details`, `growth`, `history`, `lookups`, `maintenance`, `table-statistics`, `rows`. |
| `queries/*`                                                                                                | The SQL statements: `shared` (snapshot visibility), `objects`, `statistics`, `growth`, `history`, `maintenance`.                                         |
| `changes.ts`, `schema-diff.ts`, `statistics.ts`, `thresholds.ts`, `timestamp.ts`, `locations.ts`, `ddl.ts` | Pure helpers: parse `changes_made`, diff schemas, statistics math, thresholds, ISO time, file locations, DDL text.                                       |
| `scheduled.ts`                                                                                             | The age of `delete_older_than`, the split of the scheduled files into ready and waiting, and the guard of that shape.                                    |
| `expirable.ts`                                                                                             | The age of `expire_older_than`, the split of the snapshots into expirable and younger, and the guard of that shape.                                      |
| `drivers/driver.ts`                                                                                        | The `Driver` contract.                                                                                                                                   |
| `drivers/sqlite.ts`, `duckdb.ts`, `postgres.ts`, `quack.ts`                                                | The four drivers; `quack.ts` reads a catalog served over Quack ([Quack driver](driver-quack.md)).                                                        |
| `drivers/limits.ts`                                                                                        | What the drivers share: the texts of a cancelled, timed-out or closed query, the signal that ends a query, the tracking of running work.                 |

### `connections/`

`profile.ts` (profile types, parsing, validation), `ports.ts` and `ports.vscode.ts` (settings, secrets and wizard ports and their VS Code versions), `store.ts` (profiles in the setting, passwords and Quack tokens in the secret storage), `connect.ts` (open with the stored password or token, ask only after `AUTH_FAILED`; an Entra lake gets a token instead), `wizard.ts` (add, edit, remove), `fingerprint.ts` (the SHA-256 fingerprint of the certificate a TLS server presents, for the wizard to pin).

### `azure/`: an Azure DuckLake

`arm.ts` and `arm-errors.ts` (Resource Manager client with an injectable `fetch` and token, error mapping), `operations.ts` (deployment operations, the addresses of accepted deletes, durations for the log), `create-lake.ts` (checks and deployment of the template that `deploy/azure/azuredeploy.json` embeds), `allow-ip.ts` and `blocked-ip.ts` (Allow My IP, and the test that offers it after a refused connect), `config-export.ts` (the text of Copy Azure Config), `delete-lake.ts` and `registry.ts` (delete rules, record of created lakes), `pending.ts` (names and password of a started deployment until it is a connection), `attach-lake.ts` (first attach with retry), `wizard.ts` (create, finish, import, delete dialogs), `lake-outputs.ts`, `jwt.ts`, `names.ts`, `password.ts`, `public-ip.ts`, `retry.ts`, `sizes.ts`, and the adapters `auth.vscode.ts` (Microsoft sign-in) and `commands.vscode.ts`. See [Azure DuckLake](azure-lake.md).

### `tree/`

`model.ts` (`CatalogTree`: lazy levels, states, snapshot per connection), `nodes.ts` (node factories and ids), `refs.ts` (node types), `format.ts` (descriptions and tooltips), `provider.vscode.ts` (maps nodes to VS Code tree items).

### `data/`: the data engine

| File                                                      | Job                                                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`, `open-lake.ts`, `instance.ts`                | `previewTable`, `readChanges`, `describeRelation` on a private in-memory DuckDB; the guarded open; engine options.   |
| `renewal.ts`                                              | The timer that replaces the tokens of a long session.                                                                |
| `attach.ts`, `changes.ts`, `types.ts`                     | Setup and preview SQL; row kinds of `table_changes`; shared types.                                                   |
| `guard.ts`, `guard/*`                                     | The view guard: `view-closure` (views and macros a view reaches), `file-origins` (servers of file paths), `queries`. |
| `trust.ts`, `trust.vscode.ts`, `confirm.ts`, `resolve.ts` | View trust per connection, the confirmation, resolving view columns.                                                 |
| `credentials.ts`, `settings.ts`, `access.vscode.ts`       | S3 keys, data settings, assembling the `DataAccess`.                                                                 |
| `relation.ts`, `errors.ts`, `aborted.ts`                  | Node to table mapping, secret-free errors, declined actions.                                                         |
| `commands.vscode.ts`                                      | Select Top 1000 Rows, Create Notebook, S3 credentials, Revoke Trust in Views.                                        |

### `sql/`: the SQL editor and its language service

`session.ts` (the long-lived DuckDB session), `editor.ts` and `editor.vscode.ts` (documents, connections, runs, commands), `results.ts` (port to the results panel), `script.ts` (statement splitting), `errors.ts` (error advice), and the language service: `language.ts`, `language.vscode.ts`, `vocabulary.ts`, `duckdb.ts`, `duckdb-vocabulary.ts` (generated), `ducklake.ts`, `ducklake-vocabulary.ts` (generated), `tokens.ts`, `context.ts`, `context-clauses.ts`, `context-columns.ts`, `context-frames.ts`, `context-words.ts`, `position.ts`, `catalog.ts`, `lookup.ts`, `completion.ts`, `completion-columns.ts`, `completion-keywords.ts`, `completion-duckdb.ts`, `completion-lake.ts`, `help.ts`, `token-window.ts` (tokens read again only from the statement that changed), `parse.ts` (the parse of the check while typing), `tree-scope.ts` (relations and column references of the parse tree), `unknown-names.ts` (warnings for unknown names), `problems.ts` (marks, nearest names, quick fixes).

### `grid/`: the data grid and the SQL results

`client.ts` (browser entry), `render.ts`, `model.ts` (sort, filter, text, CSV), `protocol.ts`, `html.ts`, `style.ts`, `grid.vscode.ts` (`GridPanels`); for the SQL editor `results-model.ts`, `results.ts`, `results-place.ts`, `results-binding.ts` (when the results follow, close with or come forward with their editor), `results.vscode.ts`.

### `shell/`: what all report pages share

| File                                                                 | Job                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `client.ts`, `kinds.ts`, `page.ts`                                   | Browser entry; the list of page kinds; page types and `createApp`.                   |
| `panels.ts`, `protocol.ts`, `host.vscode.ts`                         | One panel per key, the requests every page may send, panel creation with the CSP.    |
| `report-port.ts`, `report-port.vscode.ts`, `table-actions.vscode.ts` | What report actions do in VS Code.                                                   |
| `blocks.ts`, `dom.ts`, `model.ts`, `numbers.ts`, `scheduled-text.ts` | Page building blocks, number formatting, the words for the scheduled files.          |
| `scope.ts`                                                           | `ReportScope` (the lake or one schema): guard, panel key, title and lake-wide label. |
| `schema-scope.ts`, `range-state.ts`                                  | The snapshots and tables of one schema; the snapshot range a page keeps.             |
| `style.ts`, `palette.ts`, `theme.ts`                                 | Stylesheet, theme colours and contrast.                                              |
| `chart-option.ts`, `charts.ts`                                       | Chart helpers; the only module that imports ECharts.                                 |

### Report folders

Ten folders hold one report each. They share a layout:

| File                                                   | Job                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| `model.ts`                                             | Data type, figures and pure logic.                             |
| `read.ts`                                              | Reads the data through the `CatalogReader` (no `vscode`).      |
| `actions.ts`, `execute.ts`                             | Check an action the page sent against the data; carry it out.  |
| `protocol.ts`                                          | Message guards between page and extension.                     |
| `state.ts`                                             | Choices the page keeps across a hidden panel or a refresh.     |
| `kind.ts`, `markdown.ts`                               | Report registration; the Markdown export.                      |
| `page.ts`, `render.ts`, `style.ts`, `chart-options.ts` | The browser side: state and events, DOM builders, CSS, charts. |
| `commands.vscode.ts`                                   | Registers the command, with progress and Cancel.               |

The files that each folder has:

```text
activity/            actions chart-options commands.vscode execute kind markdown model page protocol read render state style
advisor/             actions commands.vscode kind markdown measure model page protocol read recommend script style
dependencies/        actions commands.vscode execute graph kind markdown model page parser protocol read references render state style
growth/              actions chart-options commands.vscode kind markdown model page protocol read render state style
health-report/       actions batcher commands.vscode controller error-action.vscode kind markdown model offer page perform.vscode protocol render style
properties-report/   commands.vscode kind model page protocol
schema-history/      actions commands.vscode execute kind markdown model page protocol read render state style
snapshot-report/     actions chart-options commands.vscode execute kind markdown model page protocol read render state style
stats/               chart-options commands.vscode kind markdown model page protocol render style target
storage-report/      actions chart-options commands.vscode kind markdown model page protocol read render style
```

Extra files: `advisor/measure.ts` and `recommend.ts` (dry runs, ranked advice), `dependencies/parser.ts`, `references.ts` and `graph.ts` (parse view SQL with `json_serialize_sql`, build the graph), `health-report/controller.ts`, `batcher.ts`, `offer.ts`, `perform.vscode.ts`, `error-action.vscode.ts` (panels and runs, event batching, the button next to an error, follow-up actions), `stats/target.ts` (which node Show Statistics acts on).

### `health/`: the health check engine

`run.ts` runs four groups in order with one engine session: `catalog-run.ts` + `catalog-checks.ts` (+ `auto-compact.ts`), `connection-run.ts` + `connection-checks.ts`, `storage-run.ts` + `storage-checks.ts`, `deep-run.ts` + `deep-checks.ts`. Support: `model.ts`, `finding.ts`, `fix.ts` (the maintenance script of a finding), `maintenance-script.ts` (one script for all findings), `request.ts`, `run-context.ts`, `run-state.ts`.

### `notebook/`

`build.ts` (the cells, a pure function), `python.ts` (Python string literals), `open.vscode.ts` (opens the Jupyter notebook).

## Port and adapter boundary

Logic never calls the editor directly. It receives small interfaces, the ports: `Logger`, `SettingsPort`, `SecretsPort`, `WizardUi`, `MementoPort`. A `*.vscode.ts` file is the adapter for its module's ports and holds no catalog or connection logic. `extension.ts` creates the adapters and hands them to the logic.

This keeps all logic testable in plain Node with plain objects as ports, keeps the VS Code-dependent code small, and makes a bug in an adapter a mapping bug.

ESLint enforces it: `no-restricted-imports` forbids `vscode` everywhere except `src/extension.ts`, `src/**/*.vscode.ts` and `test/integration/**`. `console` is forbidden in `src/` because it would bypass the redacting logger. `src/` also fails lint on `eqeqeq`, non-null assertions and non-exhaustive `switch`.

## Activation

`activate(context)` in `src/extension.ts` wires the extension once. Each step pushes what it creates to `context.subscriptions`. The order:

1. A `SecretRegistry` and the output channel logger that redacts with it.
2. `createCore`: the `ConnectionStore`, the open and password functions, the data-feature stores (S3 keys, view trust, `DataAccessFactory`) and the `CatalogTree`.
3. What all steps share: one command registrar and the grid dependencies (clipboard, save dialog).
4. `createSqlEditors`: the results panel, the `QueryEditors`, the language service.
5. `createExplorer`: the tree provider and view `aantje.catalogs`, the active connection and status bar item, the profile watch.
6. `createCommandEnv`: the environment the report commands share.
7. `registerSqlEditing`, then `registerExplorerCommands` (explorer, data and report commands).

`deactivate` closes the SQL editors, the language service and the tree with `disposeAll`. It waits at most three seconds and logs what hung.

`activate` returns an object only when the extension host runs a test (`ExtensionMode.Test`). `ExtensionApi` gives the tests the `tree`, the `view`, the `editors`, the `results` view and the `contextKeys`. It is not a public API.

## Data flows

### Expanding a connection

Nothing opens at startup. A connection opens when its node is first expanded:

```text
CatalogTree.children(connection)   a disconnected connection is opened first
  openWithPassword                 stored password; on AUTH_FAILED ask once, store only after the retry works
  openCatalog                      driver by profile kind (imported on demand), createCatalogReader,
                                   version check -> reader and info (OpenedCatalog)
  reader.schemas(snapshot), reader.snapshotCount()
user expands a schema: reader.tables, views, macros -> the folders Tables, Views, Macros
user expands a table:  columns, partitioning, sort order, tags -> leaves and folders
user expands Snapshots: reader.snapshots() (newest 50), snapshotChanges(id)
```

`CatalogTree` reads one level per call and caches it until the next refresh, snapshot selection or disconnect. `CatalogTreeProvider` only maps nodes to tree items. A tree is always read at one snapshot, so snapshots are never mixed.

A failure never reaches VS Code as an exception. A connection that cannot open shows the `userMessage` of the `AantjeError`, a level that cannot be read becomes one message node, and the detail goes to the redacted log. `openCatalog` closes the driver when a step fails.

Password retry: SQLite and DuckDB never ask. PostgreSQL tries the stored password, or none, and Quack the stored token. Only `AUTH_FAILED` asks, once; a typed password or token is stored only after it worked. There is no third attempt ([Connections](connections.md)).

Refresh reopens a connected or failed connection so that "latest" points to the newest snapshot. A change of `aantje.connections` reopens only connections whose profile changed in anything but the name.

### Select Top 1000 Rows

The data engine opens its own DuckDB per call and does not touch the tree's connection:

```text
command on a table or view   relationOf(node) -> TableRef; a view: confirm trust first
  withProgress               notification with Cancel (aborts an AbortController)
  dataAccess                 aantje.s3.*, extension directory, stored password, S3 keys, query timeout
  previewTable               in-memory DuckDB; setupStatements (INSTALL/LOAD, secrets, ATTACH READ_ONLY,
                             lock_configuration); SELECT * ... LIMIT 1001; the 1001st row only sets "truncated"
  GridPanels.show            one panel per connection, name and snapshot; the page posts 'ready', gets the data
```

The rows are those of the snapshot the tree shows (`SNAPSHOT_VERSION` of the `ATTACH`). Errors are free of the password and S3 keys. See [Data access](data-access.md) and [Data grid](grid.md).

### Create Notebook

`buildNotebook(spec)` builds the cells as text. aantje reads no data for it. `openNotebook` needs the Jupyter extension. The cells contain no password and no S3 key ([Notebooks](notebooks.md)).

### The columns of a view

DuckLake stores only the SQL of a view. Its columns come from DuckDB binding the view, which runs SQL written by the catalog's author with external access enabled. So the folder `Columns` of a view exists only with the view guard and trust: expanding it asks once per connection ("Trust and Resolve Views"), then `describeRelation` runs `DESCRIBE` in a private DuckDB. A refusal or failure shows one message node. The SQL of the view itself is in the tooltip and needs no question.

The trust belongs to the connection target, lives in the extension's global state, and **Revoke Trust in Views** removes it. A newly trusted connection makes the tree read again. Tables never need trust. See [Data access](data-access.md#views-and-trust) and [Security](security.md).

## The three bundles

`esbuild.mjs` builds:

| Output                  | Entry                 | Platform  | Contains                                                                     |
| ----------------------- | --------------------- | --------- | ---------------------------------------------------------------------------- |
| `dist/extension.js`     | `src/extension.ts`    | node, cjs | The extension and every npm package except `vscode`, DuckDB and `pg-native`. |
| `dist/grid-client.js`   | `src/grid/client.ts`  | browser   | The grid page, with `grid/model.ts`, `protocol.ts` and `results-model.ts`.   |
| `dist/report-client.js` | `src/shell/client.ts` | browser   | All report pages (`shell/kinds.ts`), ECharts and zrender.                    |

`sql-wasm.wasm` is copied to `dist/` and loaded from disk by the SQLite driver. The JavaScript API `@duckdb/node-api` is bundled; only the native `@duckdb/node-bindings*` stay external, shipped in the platform VSIX. Drivers are imported on demand, so a missing DuckDB binary breaks DuckDB connections only.

Webviews have no Node and no VS Code API, so they are separate scripts. Rows are posted to the webview with `postMessage` and written with `textContent`, never inlined into HTML: catalog text comes from somebody else, the content security policy allows one nonce script and no inline handler, and the size of a result is not limited by a HTML string. The extension accepts a webview message only when its guard accepts it. One script serves every report, so ECharts ships once; only `shell/charts.ts` imports it. The report shell is described in [Reports](reports.md).

## Driver contract

A driver gives read-only access to the metadata database (`src/catalog/drivers/driver.ts`): `query(sql, params?, options?)` and `close()`. All drivers use positional `?` placeholders, open the database read-only (a write fails with `QUERY_FAILED`; the Quack driver cannot, see below), lower-case column names, return integers as `number` and dates as ISO 8601 strings, throw `AantjeError`, and honour the `signal` option where the engine allows.

| Driver     | Engine                                                        | Read-only through                                                                                                                                                                      |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite     | sql.js (WebAssembly)                                          | An in-memory copy of the file plus `PRAGMA query_only = ON`.                                                                                                                           |
| DuckDB     | `@duckdb/node-api` (bundled), native `@duckdb/node-bindings*` | Read-only access mode.                                                                                                                                                                 |
| PostgreSQL | `pg`                                                          | A session that defaults to read-only transactions.                                                                                                                                     |
| Quack      | `@duckdb/node-api` with the `quack` extension                 | Nothing on the client: the attach has no `READ_ONLY`, which DuckDB 2.0.0 does not enforce for Quack and newer quack builds refuse. The reader sends `SELECT` only, the server decides. |

See [Security](security.md) for what the guarantee means.

## Error model

`AantjeError(code, userMessage, { cause, table, connectionId })` is the error type that crosses module boundaries. `userMessage` never contains a password or connection string. The original error stays in `cause` and goes only to the redacted log. `userMessageOf` turns any thrown value into a UI message.

Codes: `INVALID_PROFILE`, `FILE_NOT_FOUND`, `CONNECTION_FAILED`, `AUTH_FAILED`, `LOCKED`, `TIMEOUT` (over `aantje.queryTimeoutSeconds`), `ABORTED`, `QUERY_FAILED`, `VIEW_UNTRUSTED`, `NOT_A_DUCKLAKE`, `UNSUPPORTED_VERSION`.

## Why metadata is read with plain SQL

The explorer never loads the DuckLake extension and never runs a DuckLake `ATTACH`. It `SELECT`s the `ducklake_*` tables through the engine's driver. The one `ATTACH` is that of the Quack driver, a plain `quack:` attach of the served database.

- Read-only by construction: an `ATTACH` on an empty database could initialise a new lake; a `SELECT` can only report `NOT_A_DUCKLAKE`.
- No extension download at runtime, so it works offline; only a Quack catalog needs the `quack` extension.
- One code path for four kinds of catalog; PostgreSQL and SQLite need no DuckDB.
- A handful of queries, no object-store credentials, no data file access.

The cost:

- aantje depends on the table layout. The reader accepts specification version 1.x and rejects others with `UNSUPPORTED_VERSION`.
- It reimplements the rules. A row is visible at snapshot `S` if `S >= begin_snapshot AND (S < end_snapshot OR end_snapshot IS NULL)`. A live row count is the sum of `record_count` over visible data files minus the `delete_count` of visible delete files. Contract tests against real catalogs guard this ([Catalog reader](catalog-reader.md)).
- Numbers describe data files only; rows still inlined in the catalog are not counted.
- Type names are DuckLake names; the DDL module maps them to DuckDB syntax.

## Key decisions

- **The explorer is read-only.** The SQL editor is the deliberate exception, with separate sessions.
- **Lazy connect.** Opening can need the network, a password or a file lock; start-up and settings changes do not wait for it.
- **The snapshot is a parameter everywhere.** Reader methods take a snapshot id and there is no hidden current state, so time travel uses the same code as the normal view.
- **Metadata and data never share a connection.** The data engine creates a DuckDB per call, attaches `READ_ONLY`, runs only SQL it builds from quoted names and locks the configuration.
- **Tests run against real catalogs** ([Testing](testing.md)).
- **English only**, no localisation, no telemetry.

## Not supported

- Explorer commands that change a lake: commits, expiry, merging, clean-up and schema changes are SQL that the user runs in the SQL editor.
- A web extension and virtual workspaces.
- macOS and arm64 builds (a build per platform, no code change).
- A translated interface.

## Further reading

[Development](development.md), [Security](security.md), [Testing](testing.md), [Catalog reader](catalog-reader.md), [DDL](ddl.md), the driver pages ([SQLite](driver-sqlite.md), [DuckDB](driver-duckdb.md), [PostgreSQL](driver-postgres.md), [Quack](driver-quack.md)), [Connections](connections.md), [Tree](tree.md), [Snapshot selection, catalog search and status bar](snapshot-search-status.md), [Data access](data-access.md), [Notebooks](notebooks.md), [Data grid](grid.md), [SQL editor](sql-editor.md), [SQL session](sql-session.md). The full list is in the [index](index.md).
