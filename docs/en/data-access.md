# Data access

The explorer reads the metadata of a DuckLake catalog. `src/data` reads the data: the first rows of a table or of a view of a trusted connection ("Select Top 1000 Rows"), the columns of views and the row changes between two snapshots. It uses a private in-memory DuckDB that attaches the DuckLake read-only. The notebook builds the same statements in Python ([Notebooks](notebooks.md)), the grid shows the rows ([Data grid](grid.md)). The SQL editor does not use this read-only path; it has its own writable session ([SQL session](sql-session.md)) that reuses `setupStatements` with a `session` argument.

## How a read runs

Every read opens a fresh DuckDB instance. Nothing survives between two reads, and the file locks of a DuckDB catalog are not touched.

1. Load `@duckdb/node-api` lazily.
2. Create the in-memory instance with the options from `instance.ts`.
3. Run `setupStatements(access)`:
   - `INSTALL` and `LOAD` of `ducklake` and of `postgres`, `sqlite` or `quack` (a DuckDB-file catalog needs none).
   - `azure` and the secret `aantje_azure` (`PROVIDER access_token`), only for a profile with `azureAccount` ([Azure DuckLake](azure-lake.md)). On Linux `azure_transport_option_type` is `curl`. A session replaces the token every ten minutes.
   - With `azureAuth: "entra"` the secret `aantje_pg` carries a token of the Microsoft account as `PASSWORD`, and a session replaces it every ten minutes too.
   - `httpfs` and the secret `aantje_s3`, only when an S3 endpoint is set or S3 keys exist. A region or URL style alone does not count, so a local lake never loads `httpfs`. A Quack catalog always loads `httpfs`, because the quack extension sends its requests through it.
   - For PostgreSQL the secret `aantje_pg` with the password. The password is never in the `ATTACH` string. TLS on means `SSLMODE 'verify-full'` with the system roots, TLS off means `SSLMODE 'disable'`, so DuckDB never falls back to cleartext on its own.
   - For Quack the secret `aantje_quack` (`TYPE quack`, `SCOPE 'quack:<host>:<port>'`) with the token, and the target `ducklake:quack:<host>:<port>` with `META_DISABLE_SSL` from the TLS flag and, for a pinned certificate with TLS on, `META_SSL_FINGERPRINT`. A Quack attach never has `READ_ONLY`; a read uses `CREATE_IF_NOT_EXISTS false` instead, so that the attach cannot create a lake. No `ca_cert_file` is set, because it would replace the trust store for every HTTPS request of the engine ([Security](security.md#tls-for-quack)).
   - `ATTACH ... AS lake (READ_ONLY ...)`, with `SNAPSHOT_VERSION n` when a snapshot is pinned (`access.snapshot`; unset means the newest).
   - `SET autoinstall_known_extensions = false` and `SET autoload_known_extensions = false` (after the `ATTACH`, which may load `httpfs` itself for an `s3://` lake), then `SET lock_configuration = true`.
4. Begin a transaction, run `guardRelation`, run the query, roll back. The guard and the read see the same snapshot, so a PostgreSQL catalog author cannot swap a view or a path in between. The query is `SELECT * FROM lake."schema"."table" LIMIT 1001`; the extra row tells `truncated`.
5. Convert the result and close connection and instance on every path.

Values arrive JSON-safe. `BIGINT`, `HUGEINT`, `UBIGINT` and `DECIMAL` are text so nothing is rounded; `NaN` and `Infinity` are text; `STRUCT`, `LIST`, `MAP`, `UNION` and `INTERVAL` are compact JSON text (`kind: 'nested'`); `NULL` stays `null`. `TIMESTAMP WITH TIME ZONE` is shown in the time zone of the extension host. `elapsedMs` covers the query only.

### Time limits and cancel

- Installing and loading the extensions has its own limit of 5 minutes (about 40 MB on first use). No setting changes it.
- `aantje.queryTimeoutSeconds` starts after that and covers secrets, attach and query. Without it there is no limit.
- `TIMEOUT` and `ABORTED` release the caller at once and interrupt the statement. A statement blocked in the network (unreachable S3 endpoint) cannot be interrupted: the call ends on time, but the engine stays open until DuckDB's own network timeout (about 90 seconds) and closes then.

## Changes between snapshots

`readChanges` reads the rows a table gained, lost or changed after snapshot `from` up to and including `to`, with DuckLake's `table_changes`. It uses the same one-shot engine, guard and limits as the preview. The commands are in [Time travel](time-travel.md#show-changes), the grid in [Data grid](grid.md#the-changes-of-a-table).

- The range needs whole numbers with `0 <= from < to`. The result starts at the first snapshot after `from` that still exists, so the changes `from` itself made are not included.
- The attached snapshot stays unset, because `to` may be newer than the tree's snapshot. The guard judges the table at `to`, where `table_changes` binds its name.
- The grid columns are `snapshot_id`, `rowid`, `change_type`, then the table's columns as of `to`. A column added later is NULL (or its default) for older changes. Rows are ordered by snapshot and `rowid`, the pre-image of an update before its post-image. At most 1000 rows are read; a cut never splits an update pair.
- Updates that change nothing are dropped. `ducklake_rewrite_data_files` rewrites rows under the same row ids, and `table_changes` reports them as updates with equal pre- and post-image. Both statements filter such pairs, so an `UPDATE` that sets a value to itself shows no change.
- The summary (`counts`, per-snapshot counts, `total`) covers the whole range, not only the 1000 rows, and counts an update once. Rows of an unknown change type are left out and reported in the summary line.
- A snapshot that does not exist, or a table that does not exist at `to`, gets a readable `QUERY_FAILED` message. DuckLake refuses a view.

The range itself has no limit. A range over millions of changes is read twice (rows, counts) until the time limit or the user ends it.

## Views and trust

DuckLake stores only the SQL of a view. DuckDB can name its columns only by binding it, and binding runs the SQL of the catalog author with external access enabled. A view could read local files or reach the network, so views need trust.

- `describeRelation` binds the relation (`LIMIT 0`, `DESCRIBE`) and reads no rows. Types are written like the grid header; `DESCRIBE` only supplies `nullable`. A view that cannot be bound fails with `QUERY_FAILED` and the first line of the engine message; the tree shows it below `Columns`.
- `guardRelation` decides from the relation that the read binds at the snapshot, not from the tree node. A view without `viewsTrusted` fails with `VIEW_UNTRUSTED` before any SQL is bound. This also covers a name that is a table now and a view at an older snapshot. The command layer passes `ViewTrustStore.isTrusted(profile)` into the access, asks in a modal on `VIEW_UNTRUSTED` and retries once. The tree button "Trust and Resolve Views" does the same through `resolveViewColumns`. Completion in the SQL editor uses `resolveViewColumns` too, with a check instead of the question: it binds a view only of a trusted connection ([SQL IntelliSense](sql-intellisense.md#columns-of-views)). Tables are never subject to this.
- `ViewTrustStore` keeps the trusted connections in the extension's `Memento`. The key is the profile id plus the connection target (PostgreSQL host, port, database, user, metadata schema, TLS flag; for SQLite and DuckDB the kind and path; for Quack the kind, host and port). Name, password or token, and for Quack the TLS flag and fingerprint are not part of it and nothing secret is stored. Editing the target asks again. `revoke(profile)` forgets one connection, `revokeAll()` all.

## Settings and S3 credentials

| Setting                            | Meaning                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `aantje.queryTimeoutSeconds`       | Time limit of the attach and the query (see above)                                                    |
| `aantje.s3.endpoint`               | `host:port` or `http(s)://host:port` of an S3-compatible store; empty means AWS. No scheme means TLS. |
| `aantje.s3.region`                 | Region of the S3 secret, default `us-east-1`                                                          |
| `aantje.s3.urlStyle`               | `path` (MinIO, most self-hosted stores) or `vhost`                                                    |
| `aantje.duckdb.extensionDirectory` | Directory for the DuckDB extensions, see below                                                        |

The key id and secret are never settings. `S3CredentialStore` keeps them in the editor's secret storage; "aantje: Set S3 Credentials..." and "aantje: Clear S3 Credentials" write them. With nothing stored it falls back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (a half pair counts as nothing). Every key it handles is registered for log redaction. Temporary credentials with a session token are not supported.

- The keys sign every request to `aantje.s3.endpoint`. With a plain `http://` endpoint on another machine, data and key id are readable on the way. The [health check](health-check.md#connection-and-configuration) warns; nothing is blocked.
- A lake on S3 with an empty endpoint sends every request to AWS. For MinIO or RustFS that gives `NoSuchBucket` or `403`. The health check reports it as `connection.endpoint-not-set`. The data features read only the settings and the secret storage, never `AWS_ENDPOINT_URL*`.
- A lake with an `s3://` data path and nothing configured (public bucket, default credential chain) relies on the `ATTACH`, which loads `httpfs` itself with DuckDB's own defaults (region `us-east-1`). That download counts against the attach limit.

## Extension directory and offline use

DuckDB downloads `ducklake`, `postgres`, `sqlite` or `quack`, and `httpfs` from `extensions.duckdb.org` on first use (about 40 MB). Without internet access, install them elsewhere, copy them and point `aantje.duckdb.extensionDirectory` to the copy. The layout is `v<version>/<platform>/<name>.duckdb_extension`; version and platform must match the DuckDB of `@duckdb/node-api`. A local lake needs only `ducklake` and the metadata extension; a Quack catalog needs `quack` and `httpfs`; an Azure lake needs `azure` as well.

## Errors

| Code                | When                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONNECTION_FAILED` | Engine or an extension cannot load, or the lake cannot be attached (server unreachable, TLS check failed, file missing, unknown snapshot, catalog of another DuckLake version; aantje opens read-only and cannot migrate) |
| `AUTH_FAILED`       | PostgreSQL rejects the login, or a Quack server the token (or none is stored)                                                                                                                                             |
| `QUERY_FAILED`      | The query fails, a view cannot be bound, the guard refuses a file location or a view. File and network failures name the `aantje.s3.*` settings.                                                                          |
| `VIEW_UNTRUSTED`    | A view is read on a connection that is not trusted                                                                                                                                                                        |
| `TIMEOUT`           | `aantje.queryTimeoutSeconds` or the 5 minutes for the extensions exceeded                                                                                                                                                 |
| `ABORTED`           | The signal fired                                                                                                                                                                                                          |

Only the first line of the engine message is used. Every message and `cause` goes through `maskSecrets` (`src/secrets.ts`): PostgreSQL password, Quack token and S3 keys become `***`, also inside SQL string literals and across line breaks. On a Quack catalog the messages of the quack extension are explained by the table of `quackProblem`; a refusal by the server's authorization function while attaching counts as `CONNECTION_FAILED`.

A failed read carries `AantjeError.table` and `connectionId`. For a missing file (HTTP 404, or a local file that is gone), a 403 or a broken connection, the message gets a button, **Check Table Health** or **Check Health**, that starts the quick [health check](health-check.md#the-button-in-error-messages).

A data file that the catalog lists but the store or disk does not have is explained, not repeated. The message names the file, says that the catalog lists it (only when it lies below the catalog's `data_path`), and names the likely causes: file removed or moved, `data_path` or endpoint pointing to another store, only the catalog copied here. A pinned read also says whether a newer snapshot exists. A 403 keeps its text with advice about the S3 settings.

## Missing data files

aantje reports a lost file and does not repair it. What holds for DuckDB 2.0 with DuckLake:

- Renaming a table keeps its directory, and the reader takes every path from the catalog.
- Compaction plus `ducklake_cleanup_old_files` removes merged-away files, but older snapshots stay readable. `ducklake_expire_snapshots` removes snapshots; reading one then fails with "Snapshot @N does not exist", not with a 404.
- A 404 at the newest snapshot therefore means the object is gone: deleted by hand or by a lifecycle rule, a reset bucket or volume, `ducklake_delete_orphaned_files` racing a writer, or another store behind the endpoint. A wrong region or URL style does not give a 404.
- Each read uses a new DuckDB, so a file that comes back is read on the next try. A long-lived SQL session may still serve cached rows.

The tree also lists tables whose files are gone. To find out why, read `ducklake_files_scheduled_for_deletion` on the metadata database and compare `data_path` in `ducklake_metadata` with the bucket and prefix of the settings.

## Security

The full model is in [Security](security.md). In short:

- Tables never execute catalog SQL. Reading a table reads only the Parquet files the catalog names, and only on the S3 endpoint, on this machine or below the data path.
- Views execute catalog SQL, so only after trust. A trusted view must not call DuckLake maintenance functions (the names come from the engine's `duckdb_functions()`), `checkpoint`, functions that run assembled SQL or `quack_*` functions (`quack_query` runs any SQL on a Quack server with your token). Its definition is parsed with `json_serialize_sql` and nothing of it runs. A view that reaches another catalog (`memory`, `temp`, the metadata database) is refused. Names that differ only in ASCII case are refused as ambiguous.
- Read-only: `READ_ONLY` attach, locked configuration, SQL built from quoted names. No user-typed SQL runs here. On a Quack catalog the attach is not read-only: DuckDB 2.0.0 accepts `READ_ONLY` on a Quack attach without enforcing it, and newer quack builds refuse it (`READ_ONLY is not currently supported for Quack databases`), so aantje attaches a Quack catalog without it. Only the server can refuse a write. DuckLake's maintenance functions can still delete files, which is why the guard refuses views that call them.
- Secrets exist only in `CREATE SECRET` statements in the memory of the private instance. They are not in the `ATTACH` string, in messages, in the webview data or in the notebook.
- PostgreSQL TLS uses `verify-full`; there is no switch to accept an untrusted certificate. The engine ignores `NODE_EXTRA_CA_CERTS`. For a private CA, or a CA only in the Windows trust store, set `SSL_CERT_FILE` or `SSL_CERT_DIR` in the extension host environment. Quack TLS checks the system trust store or a pinned fingerprint ([Security](security.md#tls-for-quack)).
- A catalog names its data files. A file on another server (`http(s)://`, `hf://`, `gs://`, `\\host\share`, a `file://` URL with a real host) that is not the origin of the data path is refused before any request (`assertFilesStayHome`). Show Changes checks the files of the whole range. A trusted view is refused when a lake table it reads has such a file. A catalog from an untrusted source can still make a read open any Parquet file on this machine or in a bucket the keys reach, and the catalog's own `data_path` is followed. Use catalogs you trust.

## Limits

- At most 1000 rows, for the preview and for changes. `truncated` says there are more. No paging, sorting or filtering on the server. Change counts are exact.
- Rows that DuckLake keeps inlined in the catalog are read like any other row.
- An explicitly relative data path (`DATA_PATH 'files/'`) is resolved against the working directory of the extension host and is found only if that is the right one.
- `ARRAY` columns do not exist in DuckLake; a `UNION` can only come from a view and is shown as JSON text.
- The first read downloads the extensions. On a slow network it fails with `TIMEOUT`; copy the extensions beforehand.
