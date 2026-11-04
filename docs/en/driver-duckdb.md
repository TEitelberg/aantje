# DuckDB driver

`src/catalog/drivers/duckdb.ts` reads a DuckLake catalog stored in a DuckDB database file. In such a catalog the `ducklake_*` tables are ordinary tables in schema `main`, so the driver opens the file and queries them directly; it needs neither the DuckLake extension nor an `ATTACH`. It implements the `Driver` interface of `src/catalog/drivers/driver.ts` (positional `?` parameters, lower-case column names, read-only, failures as `AantjeError`) with the native engine of `@duckdb/node-api`, the only native dependency of the extension.

## API

```ts
export interface DuckdbOptions {
  readonly path: string; // the DuckDB file with the ducklake_* tables
  readonly statementTimeoutMs?: number; // per query; none by default
}
export function openDuckdb(options: DuckdbOptions): Promise<Driver>;
```

- `query` binds booleans, numbers, strings and `null` as positional parameters and returns plain objects with lower-cased column names ([Type conversion](#type-conversion)). The `signal` of the call cancels the running statement (`ABORTED`).
- `statementTimeoutMs` limits one query from the call until its rows are read. DuckDB has no statement timeout, so the driver interrupts the engine and rejects with `TIMEOUT`.
- `close` cancels running queries (`ABORTED`), waits for them and closes the instance, which releases the file. It may be called more than once; a `query` afterwards rejects with `CONNECTION_FAILED`.

The driver does not check that the file is a DuckLake catalog; `CatalogReader.info()` reports `NOT_A_DUCKLAKE` or `UNSUPPORTED_VERSION`.

## How it works

1. Open the file with Node.js and close it again. A missing or unreadable file becomes `FILE_NOT_FOUND`; on Windows a writer holding the file shows up as `EBUSY` and becomes `LOCKED`.
2. Load the engine with `import('@duckdb/node-api')` (`loadEngine` in `src/data/open-lake.ts`), now and not when the module loads ([The native binding](#the-native-binding)).
3. Create a DuckDB instance for the file with `access_mode=READ_ONLY` and `enable_external_access=false`. Each `openDuckdb` call has its own instance. A lock held by another process becomes `LOCKED` (Linux and macOS), any other refusal `CONNECTION_FAILED`.

Every `query` runs on its own connection: connect, execute, read all rows, convert, disconnect, also on failure or cancellation. A cancelled or timed-out query is stopped with `connection.interrupt()`.

## Type conversion

| DuckDB type                                                                               | Result                                        | Remarks                                                                                                                          |
| ----------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BOOLEAN`                                                                                 | `boolean`                                     |                                                                                                                                  |
| `TINYINT`, `SMALLINT`, `INTEGER`, `UTINYINT`, `USMALLINT`, `UINTEGER`, `FLOAT`, `DOUBLE`  | `number`                                      |                                                                                                                                  |
| `BIGINT`, `UBIGINT`, `HUGEINT`, `UHUGEINT`                                                | `number`                                      | Beyond `Number.MAX_SAFE_INTEGER` the query fails with `QUERY_FAILED` instead of rounding. `sum()` of integers passes.            |
| `DECIMAL`                                                                                 | `number`                                      | Converted through a double.                                                                                                      |
| `VARCHAR`, `ENUM`                                                                         | `string`                                      |                                                                                                                                  |
| `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `DATE`                                           | ISO 8601 string in UTC, millisecond precision | A `TIMESTAMP` is taken as UTC; a `DATE` becomes midnight UTC.                                                                    |
| `NULL`                                                                                    | `null`                                        |                                                                                                                                  |
| everything else (`UUID`, `TIME`, `INTERVAL`, `BLOB`, nested types, `TIMESTAMP_S/_MS/_NS`) | `string`                                      | DuckDB's text form. The DuckLake metadata tables use only `BIGINT`, `VARCHAR`, `BOOLEAN`, `UUID` and `TIMESTAMP WITH TIME ZONE`. |

Parameters are bound by JavaScript type: booleans as `BOOLEAN`, integers as `INTEGER` or `BIGINT`, other numbers as `DOUBLE`, strings as `VARCHAR`. If a statement returns the same column name twice, the engine names the second `name:1`.

## Errors

| Situation                                                        | Code                | Message                                                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The file cannot be read (missing, no permission)                 | `FILE_NOT_FOUND`    | `Cannot read "<path>": <errno code>.`                                                                                                                                                              |
| Another process holds the file open for writing                  | `LOCKED`            | `"<path>" is in use by another application that has it open for writing, for example a notebook or script that attached the DuckLake. Close it there (or detach the catalog), then connect again.` |
| The file is not a DuckDB database (text, empty, SQLite, ...)     | `CONNECTION_FAILED` | `"<path>" is not a valid DuckDB database file.`                                                                                                                                                    |
| DuckDB cannot open it for another reason (corrupt, newer DuckDB) | `CONNECTION_FAILED` | `Cannot open "<path>" as a DuckDB database: <DuckDB message>`                                                                                                                                      |
| The native engine cannot be loaded                               | `CONNECTION_FAILED` | `The native DuckDB engine could not be loaded on this platform (<platform>-<arch>). Install the aantje build for this platform, ...`                                                               |
| A statement fails, including any write attempt                   | `QUERY_FAILED`      | `The catalog query failed: <DuckDB message>`                                                                                                                                                       |
| A result integer is beyond `Number.MAX_SAFE_INTEGER`             | `QUERY_FAILED`      | `The catalog returned the integer <n>, which is larger than the largest exactly representable number (9007199254740991).`                                                                          |
| `query` after `close`                                            | `CONNECTION_FAILED` | `The catalog connection is closed.`                                                                                                                                                                |
| `statementTimeoutMs` has passed                                  | `TIMEOUT`           | `The catalog query exceeded the time limit of <n> s and was cancelled.`                                                                                                                            |
| The call's `AbortSignal` fired, or `close` ran                   | `ABORTED`           | `The query was cancelled.`                                                                                                                                                                         |

The original error stays in `cause`. Messages contain the file path and nothing that could be a secret.

## Read-only access and locks

- **Read-only.** Every statement that would change the database fails inside DuckDB and is reported as `QUERY_FAILED`, also a write chained behind a `SELECT`. The file and its `.wal` file are never modified, not even on open.
- **No external access.** `enable_external_access=false` stops a view or macro inside a catalog file from reading other files, reaching the network, writing files (`COPY ... TO`) or loading extensions. A catalog can come from a shared drive or a download. It also means a SQLite file handed to this driver is rejected as not a DuckDB database, instead of DuckDB loading its `sqlite` extension and opening it.
- **One writer or many readers.** DuckDB lets one process hold a file read-write or several hold it read-only. aantje is always a reader:
  - If another process has the DuckLake attached read-write, `openDuckdb` rejects immediately with `LOCKED`. The connection stays in the error state; connect again once the other application has closed or detached the catalog.
  - While a driver is open, the file is locked against writers. A notebook that attaches the catalog read-write fails with DuckDB's lock error. Disconnecting in aantje releases the file at once. Several aantje connections, windows and other read-only tools can share the file.
- **The data cannot change while connected.** The tree shows the file as it was at connect time.
- **A write-ahead log is read, not refused.** If a writer was killed before it checkpointed, DuckDB replays the `.wal` file in memory on a read-only open, so committed rows are visible and no file changes. The SQLite driver, in contrast, refuses a write-ahead log.

How `LOCKED` is detected depends on the OS. On Windows DuckDB takes an exclusive handle on a file it may write, which shuts out even a plain reader; Node.js reports `EBUSY`, so step 1 finds the lock (DuckDB's own Windows message is localised and cannot be matched). On Linux and macOS the lock is an advisory `fcntl` lock that a plain read does not see; DuckDB reports it when it opens the file (`Could not set lock on file`), and the driver maps that message.

## The native binding

`@duckdb/node-api` is JavaScript on top of `@duckdb/node-bindings`, which declares one optional dependency per platform, `@duckdb/node-bindings-<platform>`, holding the compiled engine (about 60 MB for `win32-x64`). `npm install` fetches only the one for the current platform. The VS Code targets map to `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`, `linux-x64-musl` and `linux-arm64-musl` (Alpine), `darwin-x64` and `darwin-arm64`.

- `esbuild.mjs` bundles everything except `vscode` and `@duckdb/node-bindings*`, so the JavaScript API `@duckdb/node-api` is part of `dist/extension.js`. The compiled engine ships as ordinary `node_modules` in the VSIX (`.vscodeignore` keeps `node_modules/@duckdb/node-bindings*/**`), so the extension is published as one VSIX per platform.
- The driver loads the engine lazily. Nothing evaluates `@duckdb/node-api` at start-up (the dynamic import is a lazy module in the bundle), so SQLite and PostgreSQL catalogs keep working on a platform without a binding, and the library is not loaded before the first DuckDB connection. Only `import type` references it at the top of the module; do not replace that with a normal import.

## Design decisions

- **One connection per query.** `connection.interrupt()` stops whatever runs on that connection. A shared connection could cancel a different or the next query. Separate connections also run in parallel.
- **An own instance per driver**, not `DuckDBInstance.fromCache`, which shares one instance per path and refuses a second open of the same file with a different configuration. With `create`, `close` really releases the file.
- **The interrupt is repeated every 50 ms until the query ends** (`interruptRepeatedly`), because DuckDB discards an interrupt that arrives while it prepares the statement.
- **A timeout is a signal.** `AbortSignal.timeout`, the call's signal and the driver's shutdown signal are combined; whichever fires first interrupts the connection, and the reason decides between `TIMEOUT` and `ABORTED`.
- **Failing instead of rounding.** Ids, snapshot numbers and sizes are far below 2^53, so a larger integer means something is wrong.
- **No DuckLake extension and no `ATTACH`.** The result does not depend on the extension version, and nothing is installed or downloaded.

## Testing

```bash
npx vitest run test/unit/duckdb-driver.test.ts
```

The suite runs against the real fixture catalog (a temporary copy for anything that could write or lock). It checks type conversion, parameter binding, read-only behaviour, `TIMEOUT` and `ABORTED` timing, locks (a second Node.js process holds the file), `close` semantics and unusable files. The contract suites in `test/contract` run this driver on the fixture, and are skipped when the native binding is missing. The end-to-end spec `files-errors` checks `LOCKED`, the writer lock and the query timeout in code-server ([End-to-end tests](e2e-tests.md)).

## Limits

- **The file is locked while connected.** Disconnect before another application has to write to the catalog.
- **Local files.** The path is passed on as given; locks on a network share are only as good as that file system.
- **DuckDB 2.0 format.** The engine is `@duckdb/node-api` 2.0.0-r.1. A file from a newer DuckDB fails with `CONNECTION_FAILED` and the engine's message.
- **A running query occupies a thread of Node's pool** (four by default). Four long queries at once would delay every file system call of the extension host until they end or time out. Catalog queries are short; use `statementTimeoutMs`.
- **Engine defaults.** Worker threads and the memory limit are not tuned.
- **Millisecond precision.** DuckDB stores microseconds; the driver returns milliseconds, rounded down.
- **Unusual types are text.** `TIMESTAMP_S/_MS/_NS`, `TIME` and nested types come back in DuckDB's text form. The catalog does not use them.
