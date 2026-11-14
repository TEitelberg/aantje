# SQL session

`src/sql` holds a long-lived DuckDB session that runs any SQL against the DuckLake, for the [SQL editor](sql-editor.md). It is free of the VS Code API and is tested against the real engine. The explorer stays read-only: tree, tooltips, snapshot selection and search read through the read-only drivers, so a mistake in a session cannot damage the tree, and the tree works with a database user who may only read.

## Lifecycle

`openSqlSession`:

1. A file catalog (SQLite, DuckDB) must exist: a writable `ATTACH` of a missing file would create an empty catalog, so a missing file fails with `FILE_NOT_FOUND`. A file that exists but is no DuckLake must not become one either; the writable `ATTACH` carries `CREATE_IF_NOT_EXISTS false`, so it fails with `CONNECTION_FAILED` "The catalog is empty or does not exist" and stays unchanged. PostgreSQL and Quack catalogs have no file to check; their writable `ATTACH` carries the same option.
2. It loads the native engine (`CONNECTION_FAILED` where no binding exists for the platform).
3. It creates one in-memory DuckDB instance with `extension_directory` from the access and `allow_persistent_secrets=false` (a creation option: DuckDB refuses to change it once a secret was used).
4. It opens two connections: the user connection runs the statements; the parser connection only parses, so it works while a statement runs and while a transaction is aborted.
5. It runs `setupStatements`: install and load the extensions, the secrets, the `ATTACH`, then `USE lake` (a lake without schema `main` falls back to `USE lake.<first schema>`), `SET default_transaction_invalidation_policy = 'SYNTACTIC_ERRORS_DO_NOT_INVALIDATE'`, and `SET autoinstall_known_extensions = false` and `autoload_known_extensions = false`. The configuration is not locked. `httpfs` is installed only together with an S3 or R2 storage, or for a Quack catalog, whose requests go through it; a lake with an `s3://` data path and nothing set gets it from the autoload during the `ATTACH` ([Data access](data-access.md#connections-without-storage)). A Quack catalog gets the secret `aantje_quack` with the token and the TLS options of the profile.

The first run downloads the extensions (about 40 MB), so installing and loading has its own limit (`extensionTimeoutMs`, default five minutes). `access.timeoutMs` bounds only the attach; statements have no time limit, and `cancel()` or a signal ends them. `access.snapshot` is ignored: a session works on the latest snapshot, and `AT (VERSION => n)` in the SQL travels in time. The opening is `openLakeSession` of `src/data/open-lake.ts`, which shares the guarded open of the data features; the signal ends it at once, and whatever was created is closed on every path. For a DuckDB-file catalog the file is locked from the `ATTACH` on, so a cancel is reported only after the instance is closed (the statement is interrupted every 50 ms), and an immediate reconnect does not fail with "being used by another process".

`close()` cancels a running statement, waits for it, rolls back an open transaction, then closes both connections and the instance. It may be called more than once.

## Running a script

```ts
const session = await openSqlSession({ access, mode: 'read-write' });
for await (const event of session.run('INSERT INTO t VALUES (1); SELECT * FROM t')) {
  // start, message (1 row affected), start, resultSet
}
```

1. The script is tokenized with DuckDB's `sql_tokenize` on the parser connection and cut at the terminators. Semicolons in strings, quoted names, comments and `$$` blocks do not split; comments and empty statements are dropped. DuckDB's parser must agree on the statement count, otherwise nothing runs.
2. A script that does not parse runs nothing: one `error` event with the parser's message, "No statement was run." and the position of the syntax error. A script that is empty or has only comments answers with one `message` event.
3. Each statement is prepared when its turn comes (so it binds against what earlier statements created), streamed, and read up to `maxRows` rows. The stream is closed before the next statement, so a result of five million rows costs milliseconds and megabytes.
4. Events of statement `index`: `start`, then `resultSet` for statements that return rows or `message` for the others (`3 rows affected.` for INSERT, UPDATE and DELETE, `Commands completed successfully.` otherwise).
5. At the first error the run stops. The `error` event says how many statements were not run and carries the position DuckDB points to in its `LINE n:` excerpt.

Only one script runs at a time per session. A second `run` while one is active, and a `run` on a closed session, throw an `AantjeError` (`QUERY_FAILED`) when the iteration starts.

## Cancel

`cancel()` (or the signal of `run`) calls `connection.interrupt()` every 50 ms until the statement has ended, because the engine drops an interrupt that arrives before the statement starts (`interruptRepeatedly` in `src/duckdb/engine.ts`). The statement ends with an `error` event "The statement was cancelled." and the rest of the script does not run. The session stays usable. `cancel()` does nothing when no script runs.

## Transactions

`inTransaction` follows the statements: `BEGIN` and `START` open; `COMMIT`, `END`, `ROLLBACK` and `ABORT` end (also when they fail). After every failure inside an open transaction the session asks the engine with `SELECT 1`; an aborted transaction refuses it, and the state becomes `aborted`.

- With `SYNTACTIC_ERRORS_DO_NOT_INVALIDATE` a parser, binder or catalog error (a typo, an unknown table) keeps the transaction alive; a runtime error (a failed conversion) or a cancelled statement aborts it.
- An aborted transaction accepts only `ROLLBACK` (and `COMMIT`, which then rolls back).
- A transaction may span several runs. An explicit transaction creates one snapshot, at `COMMIT`; every statement outside a transaction commits itself and creates one.

## Diagnostics while typing

The session has no `diagnose`. The marks while typing come from the language service (`src/sql/language.ts`, [SQL IntelliSense](sql-intellisense.md)), which has its own DuckDB. Both use `json_serialize_sql(text)` through `serializeSql` of `parser-engine.ts` and `syntaxErrorsOf` of `syntax.ts` (inside the session joined in `syntaxErrors`): it only parses and never executes. A valid statement that is not a SELECT answers "Only SELECT statements can be serialized", which counts as no error. The language service also checks the parse tree of the queries against the catalog and warns of the tables, views and columns that the lake certainly lacks ([Unknown names](sql-intellisense.md#unknown-names)); other errors that only binding finds (types, ambiguity) appear after the run.

## Errors

Every message goes through `maskSecrets` (`src/secrets.ts`) with the PostgreSQL password or Quack token and the S3 keys of the access, also for statements the user typed. Then `translateSqlError` (a table of patterns, in order) turns the engine's text into advice. On a Quack catalog it tries the table of `quackProblem` in `src/duckdb/quack.ts` first: token refused or missing, refused by the server's authorization function, server unreachable, TLS. The session does not attach again after a server restart; `Invalid connection id` says to close the session (status bar menu) and run the statement again. The other rules:

- Read-only session: a write is refused with a message that names the switch (also for `merge_adjacent_files`, `flush_inlined_data` and `CHECKPOINT`).
- `Current transaction is aborted`: run ROLLBACK. `Transaction conflict`: another writer changed the same table first, run the statement again.
- `database is locked` and the DuckDB file lock (`being used by another process`, `LOCKED`): see below. `attempt to write a readonly database`: the SQLite file is read-only for this user. `permission denied for table|schema X`: the user may not write to the catalog.
- `password authentication failed` and HTTP 403 from the object store (`AUTH_FAILED`).
- A catalog that does not exist or is no DuckLake (`CONNECTION_FAILED`); an unwritable data path (names the directory).
- A data file the catalog lists that is missing in the store (HTTP 404) or on the local disk: names the file and the likely causes ([Missing data files](data-access.md#missing-data-files)).

Anything else is reduced to the first line of the message. A failed opening is an `AantjeError` "Cannot open the SQL session: ..." with the code of the rule (`CONNECTION_FAILED` when none matches).

## Limits and decisions

- **`maxRows`** (10 000 by default) keeps memory flat. The result says `truncated` when there were more rows; the rest is not read.
- **`maxCells`** (unlimited by default, per run) bounds rows times columns over all result sets of one script. A result set that does not fit is cut and marked `truncated`; later ones get what is left, down to none (columns stay, no rows). The editor passes 2,000,000. Without it a wide result at a large `maxRows` would be read in full and could exhaust the extension host's memory.
- **Data inlining.** DuckLake stores an INSERT or DELETE of up to ten rows in the catalog instead of a Parquet file. The explorer counts the rows of files only, so such rows are missing from its statistics until they are written to a file. The session does not change `DATA_INLINING_ROW_LIMIT`; `CALL ducklake_set_option('lake', 'data_inlining_row_limit', 0)` does, for every writer.
- DuckLake does not support `RETURNING` on an INSERT into its tables; temporary tables do.
- A syntax error anywhere stops the whole script before the first statement runs, as a batch in SSMS does.
- **Positions.** A leading byte order mark counts as one character. The caret DuckDB draws is in display columns and one character early after a TAB, so a marked range can be off by the tabs in front of it. Wide characters (CJK, emoji) are handled.
- **Not verified:** the exact wording of the DuckDB file lock on Linux and macOS, a `database is locked` at COMMIT on SQLite, a read-only directory on Linux.

## DuckDB-file catalogs

A writable session locks a DuckDB catalog file exclusively, in the same process too: the explorer and any second session fail with "being used by another process" until it closes. Several read-only sessions and the explorer share the file. The error message names the lock and the way out (close the other session, disconnect the explorer, or use a read-only session). The SQL editor disconnects the explorer before it opens a writable session on a DuckDB file, and the wizard suggests a read-only session ([SQL editor](sql-editor.md#duckdb-file-catalogs)).

## What read-only means

`mode: 'read-only'` attaches the lake with `READ_ONLY`. DuckLake then refuses every statement that writes to that attachment: DDL, INSERT, UPDATE, DELETE, COMMENT, `set_option`, `ducklake_expire_snapshots` and the maintenance calls that end in a commit. All come back with the read-only text and change nothing in the catalog. It is not a hard guarantee, because the session still runs any SQL with the rights of its credentials. Known bypasses, each pinned by a test (if DuckLake closes one, the test fails and this page must change):

- `CALL ducklake_cleanup_old_files('lake', cleanup_all => true)` deletes the data files scheduled for deletion before its metadata write fails: the error is shown, the files are gone.
- `CALL ducklake_delete_orphaned_files('lake', older_than => ...)` deletes files in the data path that the catalog does not know, without any error. The scripts **Clean Up Old Files** and **Delete Orphaned Files** say so in a comment line (`-- This deletes files even in a read-only session.`). aantje does not refuse these calls by their text: a guard on text can be bypassed and would suggest a protection that does not exist.
- A second `ATTACH` of the same catalog without `READ_ONLY` is writable on a SQLite or PostgreSQL catalog. On a DuckDB-file catalog it fails, because the first attach holds the file.
- `enable_external_access = false` does not help: the second attach still worked, and the setting also blocks the lake's own file access and cannot be undone. aantje does not set it.

For a hard guarantee use credentials that may only read (a PostgreSQL role with `SELECT` on the metadata schema, an object-store key without write access, a file the user may not write); the session then reports "permission denied" or the equivalent.

A Quack catalog has no read-only session. The mode exists to avoid the lock of a DuckDB file, and a Quack server has none. Quack cannot be attached `READ_ONLY` either: DuckDB 2.0.0 lets writes to the metadata database next to the lake reach the server, and newer quack builds refuse the option. A session on a Quack catalog therefore always has full access, and the server decides what the token may change (`quack_authorization_function`).

## Security consequences

The session runs everything the credentials allow, with external access on (a notebook has the same reach), so the SQL runs with the rights of the extension host (in code-server: of the container user). Verified with DuckDB 2.0.0:

- `COPY ... TO` writes files; `read_text`, `read_csv` and the like read any file the user can read; `glob` lists directories; `ATTACH` creates files; `EXPORT DATABASE` writes directories; HTTP(S) works once `httpfs` is loaded.
- `CREATE PERSISTENT SECRET` is blocked (`allow_persistent_secrets=false`); `duckdb_secrets()` masks values and refuses `redact := false`. The PostgreSQL password, the Quack token and S3 keys exist only in `CREATE SECRET` statements of the setup, never in the text of the `ATTACH`, a message or a log.
- Not changeable at run time: `allow_unsigned_extensions`, `access_mode`. `SET enable_external_access = false` works and cannot be undone.
- Autoinstall and autoload are off, so a function from an extension that is not loaded fails instead of downloading; an explicit `INSTALL` and `LOAD` works.
- The `sql` of a `start` event is the user's text; results are data. Neither is scrubbed.
