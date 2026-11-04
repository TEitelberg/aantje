# Health check

The health check tells the user whether a lake is in order and, if not, what is wrong. It looks at three things: whether the catalog contradicts itself, whether aantje can reach the lake (catalog, DuckLake extension, object store, credentials), and whether the files the catalog lists are in the store. An optional deep check also reads the Parquet footers.

`src/health` is the engine: vscode-free functions that take their surroundings through a small interface and return findings. `src/health-report` is the panel on the report shell (see [Reports](reports.md)) plus the button in error messages.

## The panel

The scope is the lake, one schema or one table. A schema report is limited to the tables of the schema (see [Scope of a schema](#scope-of-a-schema)).

**Check Health** (Reports submenu of an open connection or of a schema) and **Check Table Health** (Reports submenu of a table) open the panel `Health · <connection>`, `Health · <connection> · Schema <schema>` or `Health · <connection> · schema.table` and start the quick check. There is one panel per connection and scope; the command again reveals it and starts a new run when none is going. Both commands need a node and are hidden from the Command Palette. On a folder, a column or any other node Check Table Health does nothing; on a closed connection both say `Connect to a catalog first to check its health.`

- **Header.** Scope, connection and, once known, the checked snapshot. Buttons: **Run** (**Run again**), **Create maintenance script for all findings** ([below](#the-maintenance-script-for-all-findings)), **Cancel** (while a run is going) and **Open as Markdown**.
- **Depth.** **Quick + existence** (default) reads the catalog and lists the store. **Deep check** also reads the Parquet footers of up to N files (default 200, 1 to 10 000; a number outside the range is not sent).
- **Key figures.** Errors, Warnings, Infos, Duration, Checked snapshot and **Not checked** (files or checks left out, findings counted and not listed, limits reached).
- **Groups.** Catalog, Connection, Storage and Deep, live: `Waiting`, `Running...` (with `12 of 200 files` for the deep check), `Done`, `Skipped: <reason>` or `Failed: <message>`.
- **Verdict.** `No problems found.`, `Found 2 errors and 1 info.`, a cancel, or `The check could not run: ...`. A finished run also lists what was checked and what was not, so a healthy result says what it does not cover.
- **Findings.** Grouped under `Lakehouse` (`Lakehouse (lake-wide)` in a schema report), the schema and each table. Each is an expandable card with a severity sign and word (never colour alone), the title and, opened, the detail, likely cause, fix, file or key, setting, check id, the SQL to inspect it and, when a script fixes it, the SQL to fix it (`fixSql`). Filters: severity, group and a text search. The list shows 100 findings; **Show more** adds 100.
- **Closing the panel stops its run.** A new run replaces the results of the last one.

### Actions of a finding

| Button                                                                                                                    | When                                                                                              | What it does                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Open SQL to inspect**                                                                                                   | the finding has SQL                                                                               | Opens it in a new SQL document of the connection (the lake is `lake`, its catalog `__ducklake_metadata_lake`).        |
| **Open setting**                                                                                                          | the finding names a setting                                                                       | Opens `aantje.<key>` in the settings editor.                                                                          |
| **Use suggested endpoint**                                                                                                | `connection.endpoint-not-set` with a suggestion                                                   | After a modal confirmation writes `aantje.s3.endpoint` (and `aantje.s3.urlStyle`), then runs the quick check.         |
| **Set S3 Credentials...**                                                                                                 | `connection.credentials-missing`, `connection.store-access-denied`, `connection.endpoint-not-set` | Runs `aantje.setS3Credentials` (masked prompts), then runs the quick check.                                           |
| **Clean Up Old Files**, **Expire Snapshots**, **Merge Adjacent Files**, **Flush Inlined Data**, **Delete Orphaned Files** | the check has a maintenance script (`SCRIPTS` in `src/health-report/model.ts`)                    | Opens that script of the Maintenance menu for the table or the lake. Nothing runs; destructive ones start as dry run. |
| **Show table in tree**, **Show Statistics**                                                                               | the finding is about a table                                                                      | Selects the table in the tree; opens its statistics report at the snapshot the tree shows.                            |

Only the two endpoint and credentials actions change the setup. **Use suggested endpoint** asks in a modal dialog that names the setting, the value and the environment variable it came from, and writes only after **Write Settings**, to the user settings (machine scope, never the workspace). Cancelling writes nothing. The credentials go through the existing masked prompts into the secret storage; the panel never sees a key. Both buttons are disabled while a run is going.

**The page asks, the extension decides.** The page sends an action and the id of a finding, never a command, SQL, setting or table. The extension looks the finding up in the data it sent, takes what the action does from that finding and only then acts (`planHealthAction` in `src/health-report/actions.ts`). A run request carries the depth and the file count; a run while one is going and a cancel while none is are ignored. The guards are in `src/health-report/protocol.ts`.

**How a run reaches the page.** The panel holds the state (`HealthData`). A run reports events; the extension applies them with `applyHealthEvent` and sends the page the same events in batches (findings and deep-check progress every 100 ms, only the newest position per group). The page applies them with the same function. A rebuilt page gets the whole state.

**Open as Markdown** writes `healthMarkdown` (`src/health-report/markdown.ts`) with the panel's filter applied, at most 200 findings, then `… n more omitted (limit: 200).` Catalog text is untrusted: every character that starts emphasis, a link, a tag, a table cell or a strike-through is escaped, and so are `://` and `www.`, so a `data_path` in a detail is text and never a clickable link. Names, keys and checks are code spans; SQL is a fenced block.

## The maintenance script for all findings

**Create maintenance script for all findings** (header of the panel; enabled when no run is going and a finding has a script) opens one untitled SQL document. It is a button of the report, not an entry of the context menu. The button uses the findings of the panel, so its script follows the scope of the report (a table panel gives the script for that table). Nothing runs when the document opens.

A finding has a script when maintenance can fix it: `HealthFinding.fixSql` with `fixStep`. `finding()` adds the script of the Maintenance menu for the checks in `src/health/fix.ts` (`catalog.cleanup-overdue` and `catalog.cleanup-pending`: Clean Up Old Files; `catalog.many-snapshots`: Expire Snapshots; `storage.file-orphaned`: Delete Orphaned Files; `catalog.small-files`: Merge Adjacent Files of the table; `catalog.large-inlined-data`: Flush Inlined Data of the table), built by `lakeScript` and `tableScript` of `src/maintenance.ts`, so the text is the same as in the menu. `catalog.auto-compact-off` brings its `set_option('auto_compact', true, ...)` itself. `maintenanceScriptOf` (`src/health/maintenance-script.ts`) builds the document:

- **Decisions first.** Errors and warnings without a script (a lost file, a wrong data path) are listed at the top as comments with their advice, at most 50.
- **Order.** The step decides, because the steps depend on each other: options (a table with `auto_compact` `false` is skipped by the compaction, so the option comes first), merge and flush, expire snapshots, clean up old files, delete orphaned files last. Inside a step the lake comes first, then the tables by name.
- **Blocks.** Each block says whether it is for the lake or a table and names the findings it covers (three, then a count); findings with the same statements share one block, so many orphaned files give one dry run.
- **Destructive calls** start with their dry run; the real call is commented out, as in the Maintenance menu. Catalog and store text in a comment is cut to one line.

The Maintenance Advisor writes its [own script for all recommendations](advisor.md#the-maintenance-script-for-all-recommendations) with the same document builder, `scriptDocument` in `src/maintenance-document.ts`; this module only turns findings into blocks.

## The button in error messages

When a read fails with an error the health check can explain (a file the store lost or a data file gone from the local disk, HTTP 404; a refused request, HTTP 403; a connection that does not work), the message gets a button: **Check Table Health** when the error names a table, otherwise **Check Health**. It opens the panel and starts the quick check. Other errors have no button, and the message text is unchanged.

- `dataError` (`src/data/errors.ts`) puts the table and the connection of the failed read into `AantjeError.table` and `connectionId`; without a connection there is no button.
- `showError` (`src/health-report/error-action.vscode.ts`) shows such a message. `guarded` in `src/command.vscode.ts` calls it, so every command and report action gets it. `offerFor` (`src/health-report/offer.ts`) decides with `healthRequestForError`.
- `scopeForOffer` looks the table up in the snapshot the tree shows, then in the newest; a table in neither (dropped, renamed) is checked as the lake.
- Errors of a SQL editor run appear in its results panel and have no button.

## Modules

| Module                                                                                | Job                                                                                          |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/health/run.ts`                                                                   | `runHealthCheck`: runs the groups, emits events, builds the report.                          |
| `src/health/model.ts`                                                                 | `CHECKS`, request, finding, event and report types, default limits.                          |
| `src/health/catalog-checks.ts`, `catalog-run.ts`, `auto-compact.ts`                   | The catalog group: facts to findings, and the reads; the auto_compact findings.              |
| `src/health/fix.ts`, `maintenance-script.ts`                                          | The script of a finding; one script for all findings.                                        |
| `src/health/connection-checks.ts`, `connection-run.ts`                                | The connection group: settings checks, attach, store probe, classification of failures.      |
| `src/health/storage-checks.ts`, `storage-run.ts`                                      | The storage group: listing and comparison.                                                   |
| `src/health/deep-checks.ts`, `deep-run.ts`                                            | The deep group: Parquet footers.                                                             |
| `src/health/request.ts`                                                               | `healthRequestForError`, `resolveRequest`: the button in error messages.                     |
| `src/health-report/model.ts`                                                          | Panel state, `applyHealthEvent`, filter, verdict, key figures, `SCRIPTS`, `actionsOf`. Pure. |
| `src/health-report/controller.ts`, `batcher.ts`                                       | The panels and their runs, cancel, close, event batches.                                     |
| `src/health-report/protocol.ts`, `actions.ts`                                         | Message guards; `planHealthAction`.                                                          |
| `src/health-report/page.ts`, `render.ts`, `style.ts`                                  | The browser side.                                                                            |
| `src/health-report/markdown.ts`, `offer.ts`                                           | The Markdown document; the error-message offer.                                              |
| `src/health-report/commands.vscode.ts`, `perform.vscode.ts`, `error-action.vscode.ts` | Commands, the real check, the actions that need VS Code.                                     |

## API

`runHealthCheck(deps, request, run?)` in `src/health/run.ts` takes:

- `deps`: the open `reader`, the `access` (`DataAccess`: profile, password, S3 settings and credentials), and optionally `credentialsFrom` (only words the advice), `now`, `exists`, `caseInsensitive` and `env` (the environment of the extension host; used to suggest an S3 endpoint, empty if not given). Check functions never read `process.env`.
- `request`: `scope` (`lake` or a table id), `depth` (`quick` or `deep`), the `snapshot` in view and optional `limits` (`findingsPerCheck`, `storageFiles`, `deepFiles`).
- `run`: an `AbortSignal` and an `onEvent` callback.

It returns a `HealthReport`: the groups (in the order catalog, connection, storage, deep), the findings (sorted by group, severity, check, table, id) and a summary. A `HealthFinding` has an `id` (`storage.file-missing:data:12`: check, then object), `check`, `severity`, `group`, `scope`, `title`, `detail`, `cause`, `fix`, and optionally `inspectSql`, `fixSql` with `fixStep`, `settingKey`, `objectKey` and `suggestion`. Events are `group`, `progress`, `finding` and `summary`; the summary is the last one. See `src/health/model.ts` for the types.

`runHealthCheck` never rejects. A failing check makes its group `failed` with a message and the others go on. A cancel keeps what was found, marks unfinished groups `skipped` with `Cancelled.` and sets `summary.cancelled`. The same catalog and store give the same list. The lake is attached at its newest snapshot, and `aantje.queryTimeoutSeconds` (default 30 s) limits the attach and each statement, not the run: a server that accepts the connection and never answers ends the attach as `connection.attach-failed`.

`healthRequestForError` returns a suggested request for a store 404, a data file missing on the local disk, a 403 or a connection failure, and nothing for other errors. `resolveRequest` turns it into a request with the table id looked up at the snapshot the read used; a table not found falls back to the lake.

## Scope of a schema

A schema report (`HealthScope` `{ kind: 'schema', schemaId }`, a finding scope `{ kind: 'schema', id, name }`) limits what depends on tables and shows what does not as lake-wide.

| What                                                              | In a schema report                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consistency, small files, inlined rows, `auto_compact` of a table | Only the tables of the schema (the tables it has or had). `auto_compact` is reported for the lake, the schema and its tables. A finding about rows of several tables of the schema has the scope of the schema.                                                             |
| Files in the store                                                | The directory of the schema is listed and compared with the files of its tables; a file in it that no row names is an orphan of the schema. A schema whose directory lies outside the data path is `skipped`. Orphans elsewhere in the data path belong to the lake report. |
| Snapshot gaps, many snapshots, files waiting for the cleanup      | Lake-wide, shown as findings of the `Lakehouse (lake-wide)` section: a table report has none.                                                                                                                                                                               |
| Connection and configuration                                      | Lake-wide, as in every report.                                                                                                                                                                                                                                              |

The Markdown document is titled `Health check of <connection> · schema <schema>` and its Scope row says that the Lakehouse findings are lake-wide.

## Groups and depth

| Group        | What it does                                                                                           | Needs                          |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `catalog`    | Reads the catalog with a few aggregating statements; finds contradictions and maintenance debts.       | the reader                     |
| `connection` | Reports an unreachable catalog, checks the settings against the data path, attaches, probes the store. | the data engine                |
| `storage`    | Lists the files below the data path and compares them with the catalog.                                | attached lake, reachable store |
| `deep`       | Reads Parquet footers of up to N files. `skipped` at depth `quick`.                                    | the same                       |

`connection`, `storage` and `deep` share one session of the one-shot engine (`withLakeSession` in `src/data/engine.ts`): a private in-memory DuckDB with the lake attached read-only, locked configuration and the S3 secret (see [Data access](data-access.md)). If the setup fails, `connection` reports it and the other two are `skipped`. If the store does not answer the first request, or a local data path does not exist, `connection` reports it once and `storage` and `deep` are `skipped` instead of reporting every file as lost. Every statement is built from fixed text and quoted literals; a table scope reads only that table's rows and directory, a schema scope only the rows of its tables and its directory.

- **quick** reads the catalog and lists the store (one ListObjectsV2 request per 1000 keys). No file is opened.
- **deep** adds the footers of up to `deepFiles` files: those the newest snapshot needs, the largest half first, then the newest, ties by id. A footer is two small ranged reads. It checks that the file is readable, that the row count matches `record_count` (or `delete_count` of a Parquet delete file), and that the columns are known: DuckLake writes the column id as Parquet field id, so a field id the table never had is a stranger; files without field ids are matched by name. Renamed and dropped columns are fine. Files of an encrypted lake and deletion vectors (Puffin) are not opened.

A file that vanished between the listing and the footer is reported once, as `storage.file-missing`. The signal is checked between files and ends a running statement.

## The checks

An id is the id of its check, then `:` and the object when a check can find several (`catalog.small-files:table:3`). Severity is fixed per check except where two are listed. aantje changes nothing itself; **Fix** names the Maintenance script that helps, if any.

### Catalog (metadata only)

Consistency checks are one statement each, with the count of all offending rows and the first ten by id. They also run for a table or schema scope, restricted to that table or the tables of the schema, except the checks on views, snapshots and cleanup.

| Id                                               | Severity      | What it finds, and what to do                                                                                                                                                                                                                   |
| ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catalog.spec-version`                           | error         | The specification version is not 1.x, or the database is no DuckLake catalog. Open a 1.x catalog; aantje does not migrate.                                                                                                                      |
| `catalog.spec-version-newer`                     | info          | Version 1.2 or later (tested with 1.0 and 1.1). Nothing to do; update aantje if something fails.                                                                                                                                                |
| `catalog.data-path-missing`                      | error         | `ducklake_metadata` has no `data_path`. Attach once with `DATA_PATH`, or restore the row.                                                                                                                                                       |
| `catalog.snapshot-gaps`                          | info          | Snapshot ids between the first and the newest are missing (Expire Snapshots). Time travel to them is gone.                                                                                                                                      |
| `catalog.many-snapshots`                         | info          | More than 10 000 snapshots. Expire Snapshots (dry run first), then Clean Up Old Files.                                                                                                                                                          |
| `catalog.files-without-table`                    | error         | File rows of a table that has no row. Restore the catalog from a backup; do not clean up first.                                                                                                                                                 |
| `catalog.files-unknown-partitioning`             | warning       | Data files name a partition id that does not exist. Check the partitioning; restore if rows are missing.                                                                                                                                        |
| `catalog.delete-files-without-data-file`         | error         | Delete files of a data file that does not exist. Restore the catalog.                                                                                                                                                                           |
| `catalog.stats-without-column`                   | warning       | Column statistics of a column the table does not have. Harmless unless column rows are missing.                                                                                                                                                 |
| `catalog.partition-values-without-partitioning`  | warning       | Partition values of a file without partition id or row. A writer wrote values and no partition id; ask its author.                                                                                                                              |
| `catalog.partition-columns-without-partitioning` | warning       | Partition columns of a partitioning that does not exist. Set the partitioning again, or restore.                                                                                                                                                |
| `catalog.sort-expressions-without-sort-order`    | warning       | Sort expressions of a sort order that does not exist. Set the sort order again, or restore.                                                                                                                                                     |
| `catalog.tables-without-schema`                  | error         | Tables of a schema that has no row. Restore the catalog.                                                                                                                                                                                        |
| `catalog.views-without-schema`                   | error         | Views of a schema that has no row (lake scope only). Restore the catalog.                                                                                                                                                                       |
| `catalog.tables-without-columns`                 | error         | Tables of the newest snapshot without any column. Restore the catalog.                                                                                                                                                                          |
| `catalog.negative-counts`                        | error         | Data or delete files with a negative row count or size. A writer stored a wrong number; the deep check shows the real rows.                                                                                                                     |
| `catalog.delete-count-over-records`              | error         | A delete file deletes more rows than its data file holds. Row counts are wrong until fixed.                                                                                                                                                     |
| `catalog.files-without-size`                     | warning       | Files without size or with size zero. Sizes in the tree and statistics are too small; the storage check cannot compare these files.                                                                                                             |
| `catalog.snapshot-range-invalid`                 | error         | Files that end before they begin, or begin after the newest snapshot. Restore the catalog.                                                                                                                                                      |
| `catalog.row-ids-overlap`                        | error         | Files of the newest state of a table claim the same row ids (a file that flushed inlined rows of several snapshots is left out). Deletes and Show Changes may hit wrong rows; restore or ask the writer's author.                               |
| `catalog.cleanup-overdue`                        | warning       | The oldest file in `ducklake_files_scheduled_for_deletion` waits more than 7 days. The detail says how many files are ready to delete now and how many wait for the age (`delete_older_than`, else 2 days). Clean Up Old Files (dry run first). |
| `catalog.cleanup-pending`                        | info          | Files wait for cleanup, none longer than 7 days (lake scope only); ready and waiting files are counted as in the Storage report, and when none is old enough the detail says what the script has to use. Clean Up Old Files when convenient.    |
| `catalog.small-files`                            | info, warning | A table has at least 5 data files and at least half are below 16 MiB (the thresholds of the statistics report); warning from 1000 small files. Merge Adjacent Files, then Clean Up Old Files.                                                   |
| `catalog.large-inlined-data`                     | info          | More than 10 000 rows of a table are inlined in the catalog. Flush Inlined Data.                                                                                                                                                                |
| `catalog.auto-compact-off`                       | info          | `auto_compact` is `false` for the lake, a schema or a table, so merge, rewrite, flush and `CHECKPOINT` skip it. Set it back to `true` (`fixSql`).                                                                                               |

### Connection and configuration

Static checks need no request. A failed request is classified from the text DuckDB gives (see [What the store says](#what-the-store-says-when-it-fails)). The `aantje.s3.*` settings belong to the machine, not to a connection, so the checks of the S3 endpoint and the S3 credentials run only for a lake whose `data_path` starts with `s3://` or `s3a://`. A lake on Azure, Google Cloud Storage or the local disk gets none of them.

| Id                                 | Severity       | What it finds, and what to do                                                                                                           |
| ---------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `connection.catalog-unreachable`   | error          | The catalog database cannot be read. Check the connection settings and the database.                                                    |
| `connection.engine-unavailable`    | error          | A DuckDB extension could not be installed or loaded. Copy the extensions to `aantje.duckdb.extensionDirectory`.                         |
| `connection.attach-failed`         | error          | The engine cannot attach the lake or read it after attaching. Wrong login or a catalog of another DuckLake version.                     |
| `connection.local-path-missing`    | error          | The local `data_path` is no directory on this machine; the storage check is skipped. Open the lake where the files are.                 |
| `connection.relative-data-path`    | warning        | The local `data_path` is relative. Attach once with an absolute `DATA_PATH`.                                                            |
| `connection.credentials-missing`   | warning        | The lake is on S3 and aantje has no credentials. Run "aantje: Set S3 Credentials..." or set the environment variables.                  |
| `connection.endpoint-not-set`      | warning, error | The lake is on S3, `aantje.s3.endpoint` is empty and the request failed (it went to AWS). See below.                                    |
| `connection.url-style-vhost-ip`    | warning        | `aantje.s3.urlStyle` is `vhost` and the endpoint is an IP address or localhost. Set it to `path`.                                       |
| `connection.endpoint-with-path`    | warning        | `aantje.s3.endpoint` contains a path. Host and port only.                                                                               |
| `connection.endpoint-cleartext`    | warning        | `aantje.s3.endpoint` is an `http://` address of another machine and S3 credentials are in use. Use `https://` or a network you control. |
| `connection.store-access-denied`   | error          | HTTP 403: wrong key id or secret, no credentials, keys of another store. Set S3 Credentials; for a self-hosted store set the endpoint.  |
| `connection.store-bucket-missing`  | error          | `NoSuchBucket`. Compare data path and endpoint; create the bucket again.                                                                |
| `connection.store-host-unresolved` | error          | The host name cannot be resolved (`vhost` style on an IP address, wrong host). Use `path` style; check the endpoint.                    |
| `connection.store-unreachable`     | error          | Nothing answers at the endpoint, or the request timed out. Check `aantje.s3.endpoint` and the store.                                    |
| `connection.store-ssl-mismatch`    | error          | TLS and the store do not match: an endpoint without `http://` makes DuckDB use TLS. Write `http://host:port` for a store without TLS.   |
| `connection.store-not-found`       | error          | HTTP 404 without an S3 error code: a web server or proxy, not the S3 API. Use the address of the S3 API.                                |
| `connection.store-failed`          | error          | Any other failure; the engine's message is the detail. Check `aantje.s3.*` and the credentials.                                         |

**The endpoint is not set.** A lake on S3 with an empty `aantje.s3.endpoint` sends its requests to AWS, which is wrong for MinIO or RustFS: the answer is `NoSuchBucket` or `403`. `connection.endpoint-not-set` says that once and makes it fixable in one step.

- Reported only when the data path is `s3://` or `s3a://`, the endpoint is empty and the request to the store failed.
- It is an error when the store gave what a self-hosted lake gets from AWS (`NoSuchBucket`, `403`, unresolvable host). It is a warning for other failures when the environment names an endpoint; otherwise those failures keep only their own finding.
- It stands next to the finding of the failure, which keeps its text. Storage and Deep stay skipped.
- The suggestion is the first plain address in `AWS_ENDPOINT_URL_S3`, else `AWS_ENDPOINT_URL`, read from the extension host environment. A value with a path, a query or odd characters is not suggested, because the panel writes it into the settings.
- `urlStyle: path` is suggested with it unless the host is an `amazonaws.com` host.

### Object store

| Id                           | Severity       | What it finds, and what to do                                                                                                                                                                                                                                                               |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.file-missing`       | error, warning | A data or delete file the catalog lists is not in the store. Error when the newest snapshot needs it, warning when only older snapshots do. Restore the file under the same key; cleanup does not repair it.                                                                                |
| `storage.file-size-mismatch` | error, warning | The key exists with another size than `file_size_bytes` (error for current, warning for retained files). Run the deep check; restore from a backup.                                                                                                                                         |
| `storage.file-orphaned`      | info           | A key below the data path that no file row names and that is not scheduled for deletion; its age is in the detail. Do not delete by hand. Delete Orphaned Files starts with a dry run; give it an `older_than` later than your longest write, because a running writer would lose its file. |
| `storage.nothing-found`      | error          | The listing returned no key although the catalog lists files. Compare `data_path` with bucket and prefix, and the endpoint with the store.                                                                                                                                                  |

### Deep check

| Id                        | Severity | What it finds, and what to do                                                            |
| ------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `deep.file-unreadable`    | error    | The footer cannot be read (cut off, overwritten, no Parquet, timeout). Restore the file. |
| `deep.row-count-mismatch` | error    | The footer has another row count than the catalog. Restore the file or the catalog.      |
| `deep.columns-unknown`    | warning  | The file has columns the table never had. Find out where the file came from.             |

## How the files in the store are found

Verified with DuckDB 2.0.0, DuckLake 1.1 and `rustfs/rustfs:1.0.4`.

**Listing.** One statement lists everything below a directory with sizes and times:

`SELECT filename, size, epoch_ms(last_modified) FROM read_blob('<directory>/**') ORDER BY filename LIMIT n`

- The size must be selected: `SELECT filename FROM read_blob(...)` makes DuckDB send a `HEAD` per object (1202 for 1202 files); the statement above needs 6 requests. `count(*)` over `read_blob` has the same effect and is not used.
- DuckDB follows the continuation token, so the result is complete. `LIMIT` bounds what comes back, not the listing.
- Pattern characters (`*`, `?`, `[`) in paths are written as classes (`[*]`), so such a path matches itself.
- A prefix without a key gives an empty result; a bucket that does not exist is an error. Keys ending in `/` are ignored. Backslashes in DuckLake's answers become `/`, and for a local data path on Windows names are compared case-insensitively.
- The probe before the listing is a `glob` of a name that matches nothing: one small request that shows a refused or unreachable store.

**Where DuckLake keeps a file.** The file path is relative to the table directory, the table path to the schema directory, the schema path to the data path, each unless `path_is_relative` says it is absolute. `src/catalog/locations.ts` does this, using the newest version of the table and schema (a renamed table keeps its directory). The check takes every path from the catalog and never builds one from a name.

**Comparing.** The catalog side is every data and delete file row, current and retained. The store side is the listing. DuckLake writes an Azure path as `abfss://<container>@<account>.dfs.core.windows.net/<key>`, while DuckDB lists it as `abfss://<account>.dfs.core.windows.net/<container>/<key>`; the comparison treats both as the same file. Files scheduled for deletion are in no file row but are no orphans. A file outside the listed directory, or without a place, is counted in `notChecked`. If a table's directory lies outside the data path, the group is `skipped`. For a table scope only that table's directory is listed, for a schema scope the directory of the schema; files of other tables in it are known, so a dropped and re-created table does not turn its old files into orphans.

## What the store says when it fails

Reproduced against RustFS 1.0.4 with a listing of the data path.

| Situation                                    | Text of DuckDB                                                                            | Finding                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| wrong secret, unknown key id, no credentials | `HTTP 403 Forbidden` with `SignatureDoesNotMatch`, `InvalidAccessKeyId` or `AccessDenied` | `connection.store-access-denied`   |
| no endpoint (AWS) with the keys of RustFS    | `HTTP 403 Forbidden`, `InvalidAccessKeyId` (the key id is replaced by `***`)              | `connection.store-access-denied`   |
| bucket does not exist                        | `HTTP 404 Not Found`, `NoSuchBucket`                                                      | `connection.store-bucket-missing`  |
| `vhost` style on an IP address               | `Could not resolve hostname error for HTTP GET ...`                                       | `connection.store-host-unresolved` |
| TLS against a plain HTTP port                | `SSL connect error error for HTTP GET to 'https://...'`                                   | `connection.store-ssl-mismatch`    |
| nothing listens (about 9 s)                  | `Could not connect to server error for HTTP GET ...`                                      | `connection.store-unreachable`     |
| proxy without route                          | `HTTP 404 Not Found` without an S3 code                                                   | `connection.store-not-found`       |

The detail of the finding is the first paragraph of the message plus the store's answer; DuckDB's echo of the statement ("LINE 1: ...") is cut off.

## Limits and cost

| Limit                | Default | Above it                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findingsPerCheck`   | 50      | Further findings are counted in `omitted`. Consistency checks name the first 10 rows in one finding.                                                                                                                                                                                                                          |
| `storageFiles`       | 100 000 | If the catalog lists more files for the scope, the storage group is `skipped` (`truncated`) with the advice to check one table. If the store holds more keys, the listing is cut in key order; catalog files with a larger key are counted in `notChecked`.                                                                   |
| `deepFiles`          | 200     | The others are counted in `notChecked`; the group is `truncated`.                                                                                                                                                                                                                                                             |
| statement time limit | 30 s    | `aantje.queryTimeoutSeconds`, per statement. A listing that exceeds it fails the storage group; one deep file that exceeds it is reported as unreadable. A statement that cannot be interrupted ends the deep check. After an interrupt the engine waits up to 3 s, then closes anyway and the Output channel gets a warning. |

A quick run costs about twenty statements on the catalog (anti-joins read whole tables, so millions of file rows take a few seconds), the engine start (the first run downloads extensions, see [Data access](data-access.md)), one probe request and the listing. The deep check adds two small reads per file.

## Security

- **Read-only.** The lake is attached `READ_ONLY` with a locked configuration, like every data read. The check never writes to the catalog or the store and never deletes.
- **Statements.** Fixed text, integers and quoted literals. The only identifiers from the catalog are inlined table names (`ducklake_inlined_data_<id>_<version>`), used only after a check against exactly that shape. Paths are literals with doubled quotes and escaped glob characters.
- **Setup changes are confirmed or masked.** See Actions of a finding. The page's request carries only a finding id.
- **Secrets.** The text of every failed statement goes through `maskSecrets` (password, key id, secret) before use.
- **Only paths below the data path are read.** A catalog from an untrusted source can name a URL or path anywhere. The storage and deep checks list a directory or open a footer only when the path lies below the data path (`isBelowDataPath` in `src/catalog/locations.ts`, the rule the [Maintenance Advisor](advisor.md) uses as well). A URL, another root, another bucket or a `..` segment is never contacted; such a file is counted in `notChecked`. The table preview is different: it follows the catalog's paths as the engine reads them (see [Security](security.md)). Use the check and the preview on catalogs you trust.

## How to add a check

1. Add its id to `CHECKS` in `src/health/model.ts` with its group and severities, and a row in the tables above (a test requires it).
2. A catalog check: add a `check` to `CONSISTENCY_CHECKS` in `src/catalog/model.ts`, its rows to `CONSISTENCY_SQL` in `src/catalog/queries/maintenance.ts` (columns `table_id`, `kind`, `id`, `value`) and its texts to `PROBLEMS` in `src/health/catalog-checks.ts`. For another kind of fact, write a pure function from facts to findings in `src/health/*-checks.ts`.
3. Build the finding with `finding()` from `src/health/finding.ts`: title, detail with numbers, cause, fix and `inspectSql`. When maintenance can fix it, add the check to `src/health/fix.ts` (or pass `fixSql` and `fixStep`) so that the script for all findings includes it.
4. Test it against an edited copy of the history fixture with the exact finding, and check that the healthy fixture stays free of errors and warnings.

## How to test

```text
npx vitest run test/unit/health- test/contract/health-reader.contract.test.ts
npx vitest run test/unit/health-report
AANTJE_POSTGRES=1 npx vitest run test/contract test/unit/health-
AANTJE_RUSTFS=1 npx vitest run test/unit/health-rustfs.test.ts
npm run test:integration -- --grep "the Health check"
```

Unit tests run every check on an edited copy of the history fixture and on a lake DuckDB writes and maintains (no error or warning after any maintenance step). They also cover the path rules, the comparison on the local disk and a fake S3 server, classification of the store's real error texts, and that no secret or foreign URL reaches a report. The panel is tested without VS Code (model, protocol, controller, Markdown, the page bundle against a DOM stand-in). The PostgreSQL and RustFS tests run only with their environment variable; the integration test runs in a real VS Code.

## Known limits

- The check reads the newest snapshot; whether an older one is readable is told by the `storage.file-missing` warning for files only it needs.
- Files outside the data path (for example registered in place with `add_data_files`) are neither compared nor opened; they are counted in `notChecked`. Encrypted lakes and deletion vectors (Puffin) are not opened by the deep check.
- A delete file without an end next to a data file that has ended is normal (a partial delete, then `DELETE FROM t`); no check reports it.
- Listing a store with millions of keys takes as long as the store needs; the statement limit ends it.
- The checks were tuned on catalogs DuckDB 2.0.0 wrote and maintained. A writer that records things differently may trigger a harmless warning.
