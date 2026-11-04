# Development

How to set up, build and run aantje, the rules the code follows, short recipes for typical changes, and debugging tips. What the modules do is in [Architecture](architecture.md); how the tests work is in [Testing](testing.md).

## Prerequisites

| Tool                | Version                    | Needed for                                                                                         |
| ------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| Node.js             | 24 (`engines.node`: >= 22) | Everything. `.nvmrc` pins 24.                                                                      |
| npm                 | 11 (with Node 24)          | Dependencies and scripts.                                                                          |
| PowerShell 7 (pwsh) | 7.3                        | `test:e2e`, `package:win32`, `package:linux`, fixture regeneration. `package:win32` needs Windows. |
| Docker              | Linux containers           | `test:full`, `test:e2e`, `package:linux`, fixture regeneration. Not for `npm test`.                |
| VS Code             | 1.140 or newer             | F5 and `test:integration` (which downloads its own copy).                                          |

Python is never installed on the host. It runs only in containers.

The type packages follow the oldest supported runtime: `@types/vscode` matches `engines.vscode` and `@types/node` the Node version of the extension host (24), so Dependabot does not raise them. TypeScript is on 6.0 until `typescript-eslint` supports 7. `package.json` overrides `mocha` to 12 so that the test runner uses the current `glob`; drop the override when `@vscode/test-cli` depends on mocha 12 itself. `allowScripts` lists the two packages whose install scripts npm may run (`esbuild`, `@vscode/vsce-sign`).

## Set up

```bash
git clone https://github.com/TEitelberg/aantje.git
cd aantje
npm ci
npm test
```

Use `npm ci`, not `npm install`, so the lock file stays as it is. It fetches the native DuckDB binding of your platform (about 60 MB). `npm test` runs the unit and contract suites in seconds and needs no Docker. The first run downloads the DuckDB extensions of the data tests (about 200 MB into `test/.cache/duckdb-extensions`); without network those tests skip and say so. `AANTJE_REQUIRE_ENGINE=1` makes them fail instead (CI and `test:full` set it).

## The daily loop

| Command              | What it does                                                                          |
| -------------------- | ------------------------------------------------------------------------------------- |
| `npm run watch`      | esbuild watch for the three bundles, unminified. No type check, no notices.           |
| `npm run build`      | One packaged build: minified bundles, `dist/sql-wasm.wasm`, `THIRD-PARTY-NOTICES.md`. |
| `npm test`           | Unit and contract suites. `npx vitest run test/unit/<file>.test.ts` runs one file.    |
| `npm run typecheck`  | `tsc --noEmit` over `src/` and `test/`.                                               |
| `npm run lint`       | ESLint, including the rule that keeps `vscode` out of the logic.                      |
| `npm run format`     | Prettier check. `npx prettier --write <file>` fixes a file.                           |
| `npm run check:docs` | Checks the documentation pages and links.                                             |

To run the extension, open the project folder and press F5. The launch configuration `Run Extension` builds first and starts an Extension Development Host with your normal profile, so your own `aantje.connections` is there. With `npm run watch`, restart the debug session or run `Developer: Reload Window` to see a change. The catalogs in `test/fixtures` make good first connections.

A change is done when lint, typecheck, format and `npm test` are green. Changes to a driver, the reader, the data engine, the notebook or the fixtures also need `npm run test:full`; changes to the wiring with VS Code need `npm run test:integration` ([Testing](testing.md)).

## Coding rules

- **English only.** Code, comments, UI texts, log and error messages. Comments explain a non-obvious why.
- **Minimal code.** No speculative options, no abstraction for one caller, no unused exports. Plain functions, small modules, kebab-case file names.
- **TypeScript strict.** `import type` for types, no `any`, no non-null assertions unless justified.
- **The `vscode` boundary.** Only `src/extension.ts` and `*.vscode.ts` import `vscode`; ESLint fails otherwise. Logic receives the editor through ports. An adapter only maps and decides nothing. `console` is forbidden in `src/`; use the `Logger`.
- **No secrets anywhere.** A password, S3 key or connection string never goes into a log, an error message, a tooltip, a setting, a notebook cell, a webview message or a test snapshot. Engine text goes through `maskSecrets` (`src/secrets.ts`, with `secretsOf` from `src/data/errors.ts`). `AantjeError.userMessage` must be free of secrets by construction.
- **Tests with real data.** Prove behaviour with the fixture catalogs, a real in-memory DuckDB or a real temporary file. Mock only at system boundaries. Every test must be able to fail.

## Recipe: add a command

1. **Manifest.** In `package.json` add a command `aantje.<name>` with `title` and `"category": "aantje"`, and a menu entry (`view/item/context` with a `viewItem` condition, or `view/title`). A command that needs a node is hidden from the Command Palette with `"when": "false"`. `test/unit/manifest.test.ts` checks the manifest.
2. **Logic.** Put what it computes into a plain module (as `src/actions.ts` does) and unit-test it.
3. **Registration.** In `src/commands.vscode.ts` call `register('aantje.<name>', async (node) => ...)`. The wrapper logs a thrown error and shows its `userMessage`, so the handler throws. A handler asks the user, calls the logic and writes the result.
4. **Host test.** Add a case in `test/integration` that runs the command ([Extension-host tests](integration-tests.md)). `activation.test.ts` already fails when a declared command is not registered.
5. **Docs.** The page of the area and the README command list.

## Recipe: add a data command

Follow the recipe above, with these differences.

1. **Manifest.** Use `viewItem =~ /^(table|view)$/` for both. Views need the trust confirmation ([Data access](data-access.md#views-and-trust)), so decide on purpose.
2. **The read.** Add a function next to `previewTable` in `src/data/engine.ts`, built on `withLake`: it gives you the private in-memory DuckDB, setup, timeout, abort, error mapping and secret scrubbing. Do not open a second path to DuckDB. Build SQL from quoted identifiers, never from user text. A new setup statement belongs in `setupStatements` (`src/data/attach.ts`) and in the notebook's Python ([Notebooks](notebooks.md)).
3. **Registration.** In `src/data/commands.vscode.ts` use `register`. `target(node)` returns the relation, profile and connection state, and has already asked the view confirmation. `env.dataAccess(profile, snapshot)` assembles the `DataAccess`. Show a long read with `withProgress` and pass its token on as an `AbortSignal`.
4. **Tests.** The read in `test/unit/data-engine.test.ts` against the data fixtures; the command in `test/integration/data-preview.test.ts` or next to it.
5. **Docs.** [Data access](data-access.md), the output page, the README.

## Where the settings are read

| What                                                                             | Where                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `aantje.connections`                                                             | `ConnectionStore` through `SettingsPort` ([Connections](connections.md)).                         |
| `aantje.queryTimeoutSeconds`                                                     | `queryTimeoutMs()` in `src/extension.ts`.                                                         |
| `aantje.s3.endpoint`, `.region`, `.urlStyle`, `aantje.duckdb.extensionDirectory` | `readDataSettings()` in `src/data/access.vscode.ts`. An empty text counts as not set.             |
| `aantje.sql.maxRows`                                                             | The SQL editor ([SQL editor](sql-editor.md)).                                                     |
| S3 key id and secret                                                             | `S3CredentialStore` in `src/data/credentials.ts` (secret storage, else `AWS_*`). Never a setting. |
| The PostgreSQL password                                                          | `ConnectionStore.password(id)`.                                                                   |

Data settings are read when a command runs, so a change applies to the next preview or notebook without a reload. To add a setting, declare it in `package.json` with scope `machine`, read it in `readDataSettings()`, pass it through `DataAccess` (and `NotebookSpec` if needed) and document it in [Data access](data-access.md#settings-and-s3-credentials). `manifest.test.ts` checks that the README lists every setting.

## The webview bundles

The grid and the report pages are separate esbuild entries (`src/grid/client.ts` and `src/shell/client.ts`, see [Architecture](architecture.md#the-three-bundles)).

- **See a change.** Rebuild, then run `Developer: Reload Webviews`. A change in `src/grid/html.ts` or `style.ts` needs the panel closed and reopened.
- **Look inside.** `Developer: Open Webview Developer Tools` opens the browser tools. In a watch build the scripts are not minified.
- **Check without a window.** `npx vitest run test/unit/grid-client.test.ts` bundles the grid client fresh and runs it against a fake DOM.
- **Where to put a change.** Decisions (order, filter, text, CSV) go into a pure module such as `src/grid/model.ts` with a unit test; `client.ts` stays thin. A new message needs its type in `protocol.ts` and, for messages from the page, a check in the guard, because the extension does not trust the webview. Never write data into the HTML; post it ([Data grid](grid.md)).
- **Packaging.** A new file that must travel in the VSIX is added to `.vscodeignore` and `scripts/package.ps1` ([Packaging](packaging.md)).

## The `viewColumns` seam

A view has no typed columns in the catalog; only DuckDB can tell them, by running the view's SQL. `CatalogTreeDeps.viewColumns` in `src/tree/model.ts` is the optional seam: without it a view has no `Columns` folder; with it, expanding that folder calls it. `src/extension.ts` passes a function that asks `confirmViews` and calls `describeRelation` at the shown snapshot. A rejection (error or declined question) becomes one message node. Nothing in the tree decides about trust. The behaviour is in [Tree](tree.md#columns-of-views). `tree-model.test.ts` uses a fake; `data-engine.test.ts` covers the real path.

## Recipe: add a catalog query

The reader reads `ducklake_*` tables with `SELECT` only ([Catalog reader](catalog-reader.md)).

1. **SQL.** In `src/catalog/queries/`, add a function returning a `Query` (`{ sql, params }`). Snapshot-dependent statements start with `WITH_SNAPSHOT` and restrict every versioned table with `visible('<alias>')`. The text must run unchanged on SQLite, DuckDB and PostgreSQL: positional `?` only, no engine-specific functions, no `?` inside a string literal, and `CAST(... AS BIGINT)` around `SUM`, `COUNT` and `MAX`.
2. **Model.** Add the type to `src/catalog/model.ts` and a method to `CatalogReader`. Methods that read versioned data take a snapshot id.
3. **Mapping.** In the matching `src/catalog/reader/` module call `run(queries.<name>(...))` and map rows with `toNumber`, `toText`, `toTextOrNull` from `reader/rows.ts`.
4. **Test.** Add a case to `test/contract/reader.contract.test.ts`, which runs against every catalog source. If the fixture cannot show the fact, change `test/fixtures/generate.py` and regenerate ([Test fixtures](test-fixtures.md)); snapshot ids depend on its statement list.
5. **Docs.** [Catalog reader](catalog-reader.md).

## Recipe: add a driver

1. **Driver.** `src/catalog/drivers/<engine>.ts` exports `open<Engine>(options): Promise<Driver>` and keeps the contract of `driver.ts` (positional `?`, read-only, lower-case names, integers as `number`, ISO 8601 dates, `AantjeError`). Copy the style of `sqlite.ts`.
2. **Profile.** Add the kind to `src/connections/profile.ts` (`parseDetails`, `toSettingEntry`), to `aantje.connections` in `package.json`, and to the wizard.
3. **Wiring.** Add a `case` to `openDriver` in `src/catalog/open.ts`, importing the module with `await import(...)`. A native binding stays out of the bundle: list it in `external` in `esbuild.mjs` ([Packaging](packaging.md)).
4. **Tests.** A driver unit test and a catalog source in `test/support/sources/<engine>.ts`, added in `index.ts`. The contract suite then runs against it.
5. **Docs.** `driver-<engine>.md`, the module map in [Architecture](architecture.md), [Connections](connections.md).

## Debugging

- **Output channel.** **aantje** shows connecting, failures with causes and ignored settings entries ([Logging](logging.md)). The tree shows only the short `userMessage`. Set its level with `Developer: Set Log Level...`.
- **Breakpoints.** F5 starts with source maps, so breakpoints in `src/**/*.ts` work. For logic, a unit test is usually faster.
- **One host test.** `npx vscode-test --grep "<title>"` after `npm run build`.
- **code-server.** `.\test\e2e\run.ps1 -Up` starts code-server with the Linux package; `-Clean` removes it ([End-to-end tests](e2e-tests.md)).
- **A preview or notebook that fails.** The notification shows the `userMessage`; the cause is in the output channel. Check `aantje.s3.*`, **Set S3 Credentials...** and `aantje.duckdb.extensionDirectory` first. `npx vitest run test/unit/data-engine.test.ts` shows the engine alone; a skip reason usually means the extension cache is missing.
- **A catalog that does not open.** Read the message in the tree, then the cause in the channel. For a file, make sure no application holds it for writing (`LOCKED`, [DuckDB driver](driver-duckdb.md)) and that a SQLite file has no write-ahead log ([SQLite driver](driver-sqlite.md)).

## Release checklist

Details are in [Packaging](packaging.md).

- [ ] The version is not committed: the release workflow counts it up from the tags and generates the release notes from the merged pull requests ([Packaging](packaging.md#release)). `package.json` keeps the version of the first release, which `CHANGELOG.md` describes.
- [ ] README and documentation up to date; `npm run check:docs` green.
- [ ] `lint`, `typecheck`, `format`, `test:full` and `test:integration` green.
- [ ] `npm run package:win32` and `npm run package:linux` build and verify both packages.
- [ ] `npm run test:e2e` green against the fresh Linux package.
