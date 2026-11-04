# SQLite driver

`src/catalog/drivers/sqlite.ts` reads a DuckLake catalog stored in a SQLite file. It implements the `Driver` interface of `src/catalog/drivers/driver.ts` (positional `?` parameters, lower-case column names, read-only, failures as `AantjeError`). It runs SQLite as WebAssembly (`sql.js`) on an in-memory copy of the file.

## API

```ts
export interface SqliteOptions {
  readonly path: string; // the SQLite file with the ducklake_* tables
  readonly wasmPath: string; // location of sql-wasm.wasm
}
export function openSqlite(options: SqliteOptions): Promise<Driver>;
```

`query` returns plain objects with lower-cased column names. Integers come back as `number`, `NULL` as `null`, text as stored (SQLite keeps timestamps as text such as `2026-10-29 21:16:30.953304+00`; converting them is the reader's job) and BLOB values as base64 strings. A boolean parameter is bound as `0` or `1`. `close` frees the in-memory database.

The driver does not check that the file is a DuckLake catalog; `CatalogReader.info()` reports `NOT_A_DUCKLAKE` or `UNSUPPORTED_VERSION`.

## How it works

1. Read the whole file into memory.
2. Refuse the file when a non-empty write-ahead log (`<path>-wal`) sits next to it.
3. Start `sql.js` with the binary from `wasmPath` and create an in-memory database from the file bytes.
4. Set `PRAGMA query_only = ON` and run `SELECT count(*) FROM sqlite_master`. SQLite opens lazily, so this is the first statement that reads the file and detects a file that is not a database.

Every later query runs against the copy. The file on disk is not touched after step 1.

## Design decisions

- **`sql.js` instead of a native module.** The same code runs in desktop VS Code on Windows, macOS and Linux and in code-server, with no build per platform. DuckDB is the only native dependency.
- **In-memory copy.** The original can never be modified. A writer holding a lock does not block aantje and vice versa, because no SQLite lock is taken.
- **Two read-only layers.** The copy, and `PRAGMA query_only = ON`: a write fails with `attempt to write a readonly database` (`QUERY_FAILED`). Even a statement that switched the pragma off could only change the copy.
- **A write-ahead log is refused.** Commits in `<path>-wal` are not in the main file, and `sql.js` reads only the main file, so the driver would show an old state without a hint. An absent or empty `-wal` file is fine. The case arises when a catalog in WAL mode is still open in the writing application, or after it crashed.
- **`wasmPath` is an option** because only the wiring code knows the install folder, which keeps the driver free of `vscode`. `esbuild.mjs` copies the binary to `dist/sql-wasm.wasm` and `.vscodeignore` ships it; tests pass the file from `node_modules`. A wrong path is a packaging error and rejects with the original file system error, not an `AantjeError`.

## Errors

| Situation                                      | Code                | Message                                                                                                                            |
| ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The file cannot be read (missing, no access)   | `FILE_NOT_FOUND`    | `Cannot read "<path>": <errno code>.`                                                                                              |
| The file is not a SQLite database              | `CONNECTION_FAILED` | `"<path>" is not a valid SQLite database.`                                                                                         |
| A non-empty write-ahead log sits next to it    | `CONNECTION_FAILED` | `"<path>" has an uncheckpointed write-ahead log. Close the application that writes to it or run a checkpoint, then connect again.` |
| A statement fails, including any write attempt | `QUERY_FAILED`      | `The catalog query failed: <SQLite message>`                                                                                       |
| `query` after `close`                          | `CONNECTION_FAILED` | `The catalog connection is closed.`                                                                                                |
| The call's `AbortSignal` is already aborted    | `ABORTED`           | `The query was cancelled.`                                                                                                         |

The original error stays in `cause`. Messages contain the file path and nothing that could be a secret.

## Testing

```bash
npx vitest run test/unit/sqlite-driver.test.ts
```

The suite runs against the real fixture catalog and checks reads, parameter binding, the error codes above and that a write fails and leaves the data unchanged, including a catalog in WAL mode. The contract suites in `test/contract` run this driver on the fixture without a container. The end-to-end spec `files-errors` checks the messages in code-server ([End-to-end tests](e2e-tests.md)).

## Limits

- **Point-in-time copy.** Commits by other processes become visible only after you disconnect and connect again. This is unrelated to DuckLake snapshots.
- **No lock, no consistency guarantee during a commit.** A commit in progress when the file is read can leave the copy inconsistent, and the driver does not inspect a rollback journal (`<path>-journal`). Connect again.
- **Memory grows with the file.** The whole file is read and copied into the WebAssembly heap for every open connection, with no size limit.
- **No cancellation and no timeout.** `sql.js` runs a statement synchronously, so it cannot be interrupted and blocks the extension host while it runs. The `signal` is only checked before the statement starts.
- **Local files only.** The path goes to `readFile` as given.
