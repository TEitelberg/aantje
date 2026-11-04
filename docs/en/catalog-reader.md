# Catalog reader

The catalog reader turns the `ducklake_*` tables of a DuckLake catalog into the model in `src/catalog/model.ts`: snapshots with commit metadata and changes, schemas, tables, views, columns, partitioning, sort orders, tags, macros, and the properties and storage of the catalog. It talks to the database through a `Driver` with plain SQL, so one code base serves catalogs in SQLite, DuckDB and PostgreSQL, and catalogs that a DuckDB server serves over Quack. It is read-only and keeps no state: every call asks the database again.

## Modules

| File                                     | Job                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/catalog/open.ts`                    | `openCatalog`: opens the driver for a profile and validates the catalog                                                     |
| `src/catalog/reader.ts`                  | `createCatalogReader`: builds `run` and `attempt` and merges the reads of the modules below                                 |
| `src/catalog/reader/core.ts`             | Version check, snapshots, schemas, tables, views, columns, entries, properties, storage                                     |
| `src/catalog/reader/details.ts`          | Partitioning, sort order, tags, macros                                                                                      |
| `src/catalog/reader/table-statistics.ts` | `tableStatistics`                                                                                                           |
| `src/catalog/reader/growth.ts`           | `lakeGrowth`, `growthChanges`                                                                                               |
| `src/catalog/reader/history.ts`          | `snapshotChanges`, `snapshotActivity`, `lifetime`, `schemaHistory`, `columnHistory`                                         |
| `src/catalog/reader/lookups.ts`          | Names the objects behind the entries of `changes_made`                                                                      |
| `src/catalog/reader/maintenance.ts`      | `consistency`, `maintenanceFacts`, `smallFiles`, `deleteHeavyTables`, `fileLocations`                                       |
| `src/catalog/reader/columns.ts`          | The nested column tree and default expressions                                                                              |
| `src/catalog/reader/rows.ts`             | Conversion of driver values: numbers, text, booleans, times                                                                 |
| `src/catalog/queries/*.ts`               | All SQL, by area; `shared.ts` holds the snapshot visibility rule                                                            |
| `src/catalog/changes.ts`                 | `parseChanges`: structures `changes_made`                                                                                   |
| `src/catalog/schema-diff.ts`             | `diffColumns`, `diffEntries`: pure comparisons of two states                                                                |
| `src/catalog/statistics.ts`              | Pure helpers of `tableStatistics`: evenness, histogram bins, growth, order of types                                         |
| `src/catalog/thresholds.ts`              | `SMALL_FILE_BYTES` (16 MiB), `SMALL_FILES`, `CLEANUP_OVERDUE_DAYS`, shared by reports and the health check                  |
| `src/catalog/scheduled.ts`               | `DEFAULT_DELETE_OLDER_THAN`, `intervalMs`, `splitByAge`, `splitScheduled`, `isScheduled`: ready and waiting scheduled files |
| `src/catalog/expirable.ts`               | `DEFAULT_EXPIRE_OLDER_THAN`, `splitExpirable`, `isExpirable`: expirable and younger snapshots                               |
| `src/catalog/timestamp.ts`               | `toIsoUtc`: snapshot time as ISO 8601 UTC                                                                                   |

`openCatalog(profile, { password, wasmPath, statementTimeoutMs, extensionDirectory })` picks the driver by `profile.kind` and imports it on demand, so the native DuckDB binding and `pg` load only for connections that need them. It calls `info()` to check for a supported DuckLake catalog and returns `{ reader, info }`; the tree and Test Connection use that info. The caller ends the reader with `reader.close()`. On any failure the driver is closed again. An `AantjeError` passes unchanged; anything else becomes `CONNECTION_FAILED` with a generic message, and the original stays in `cause` for the log. The password goes only to the PostgreSQL driver, and as the token to the Quack driver, which also gets the extension directory (`aantje.duckdb.extensionDirectory`) for the `quack` extension.

The methods of `CatalogReader` are documented in `src/catalog/model.ts`. All except `info()`, `snapshots()`, `metadata()`, `snapshotCount()`, `properties()`, `scheduledForDeletion()` and `close()` take a snapshot id or an object id. `info().latestSnapshot` is the current state. [Tree](tree.md) shows how the explorer uses them.

## Where the data comes from

| Method                                                                  | Tables                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `info()`, `metadata()`, `snapshotCount()`, `properties()`               | `ducklake_metadata`, `ducklake_snapshot`                                                                         |
| `snapshots()`                                                           | `ducklake_snapshot`, `ducklake_snapshot_changes`                                                                 |
| `schemas`, `tables`, `views`, `columns`, `entries`                      | the schema, table, view and column tables, `ducklake_tag`, `ducklake_column_tag`, the file tables (for `tables`) |
| `storage()`, `scheduledForDeletion()`                                   | `ducklake_metadata`, the file tables, `ducklake_files_scheduled_for_deletion`                                    |
| `partitioning`, `sortOrder`, `tags`, `macros`                           | the partition, sort, tag and macro tables                                                                        |
| `snapshotChanges`, `snapshotActivity`, `lifetime`                       | the snapshot, changes and object tables                                                                          |
| `tableStatistics`, `smallFiles`, `lakeGrowth`, `growthChanges`          | the file tables, file statistics, partition values, inlined data tables                                          |
| `consistency`, `maintenanceFacts`, `deleteHeavyTables`, `fileLocations` | the file, schema, table, view and column tables, inlined data tables                                             |
| `columnHistory`, `schemaHistory`                                        | `ducklake_column` (every version), column tags, snapshots                                                        |

Comments are tags with the key `comment`. Snapshots come newest first, columns in `column_order`, schemas, tables, views and entries by name (in the collation of the engine). `columns` returns the top-level columns and nests struct fields, list elements and map key and value in `children`, following `parent_column`.

## Snapshot visibility

Schemas, tables, views, columns, tags, data files and delete files are versioned. `begin_snapshot` is inclusive, `end_snapshot` is exclusive, NULL means still valid. A row exists at snapshot `S` when:

```sql
S >= begin_snapshot AND (S < end_snapshot OR end_snapshot IS NULL)
```

`visible()` in `queries/shared.ts` is the only place that spells this rule. Every snapshot-dependent statement starts with `WITH snap AS (SELECT CAST(? AS BIGINT) AS id)`, so the snapshot is bound once as the first placeholder.

## Version policy

`ducklake_metadata.version` must be `1.x`. The reader uses only tables and columns that exist in 1.0 and 1.1 (it never reads `ducklake_schema.parent_schema_id`).

| Situation                                                        | Error                 |
| ---------------------------------------------------------------- | --------------------- |
| `ducklake_metadata` or `ducklake_snapshot` missing or unreadable | `NOT_A_DUCKLAKE`      |
| no `version` row                                                 | `NOT_A_DUCKLAKE`      |
| version other than `1.x`, for example `0.3` or `2.0`             | `UNSUPPORTED_VERSION` |

Only `info()` turns `QUERY_FAILED` into `NOT_A_DUCKLAKE`. `LOCKED`, `TIMEOUT` and `CONNECTION_FAILED` pass on unchanged, because they say nothing about the database.

## Table statistics

`tables()` computes rows, files and size from the files visible at the snapshot:

```sql
rows  = SUM(f.record_count - COALESCE(d.delete_count, 0))
files = COUNT(f.data_file_id)
size  = SUM(f.file_size_bytes + COALESCE(d.file_size_bytes, 0))
```

`f` are the visible data files, `d` their visible delete files. The numbers move correctly under time travel. `ducklake_table_stats` is not used: it has no snapshot, counts deleted rows and leaves out delete files.

Inlined rows (`ducklake_inlined_data_*`) are not counted. A table that holds only inlined rows shows 0 rows and 0 files.

Files that hold several snapshots limit exactness. A file with `partial_max` covers the snapshots from `begin_snapshot` to `partial_max` but has one count. A delete file collects several deletes, a compacted data file several snapshots of rows. The catalog does not say how many belong to an earlier snapshot, so the reader cannot compute it. `TableStats.approximate` is `true` when a visible file has a `partial_max` after the requested snapshot.

## Table statistics for the statistics report

`tableStatistics(tableId, snapshot, signal?)` feeds the [statistics report](statistics.md), which defines every figure. It runs its statements in two waves with `Promise.all`; everything that can be aggregated is aggregated in SQL.

- **Same files as `tables()`.** The summary joins visible data files with visible delete files exactly as `tables()` does, so the numbers match the tree.
- **Histogram** (`fileSizeBins`): integer comparisons (`size * 2^k >= largest`) put each file into one of eight bins that are halves of the largest file. No `/`, because integer division differs between engines.
- **Partitions** (`partitionBuckets`): one `LEFT JOIN ducklake_file_partition_value` per key; files are grouped by the current partitioning only (`partition_id`), others are counted apart (`otherPartitionFiles`). The reader sorts the buckets itself, because the engines order NULL differently.
- **Null shares**: two `SUM`s over the file statistics, `nulls / (nulls + values)`. A column for which some file has no counts (an `INTERVAL` column) gets no share. The same holds for fields below a nullable column, a list or a map.
- **Ranges.** At the latest snapshot `ducklake_table_column_stats` gives them. At an older snapshot `fileColumnRanges` returns each visible file's range and `foldRange` combines them in TypeScript by the type order, because the values are text.
- **Growth** (`growthDeltas`): a `UNION ALL` of what each snapshot added or removed, summed per snapshot and cumulated by the reader. A compaction leaves no file rows, so it has its own branch: snapshots whose `changes_made` has `merge_adjacent` for the table, confirmed by `parseChanges`.
- **Caps** (`statistics.ts`, `queries/statistics.ts`): 50 partitions named (10,000 read), 32 partition keys (`MAX_PARTITION_KEYS`), 50,000 statistics rows compared, 500 growth points. Each cap sets a flag in the result (`rest`, `partial`, `columnsPartial`, `growthMerged`, `keysLeftOut`) that the report shows.
- **Optional tables** (null counts, ranges, partition values) are read with `attempt`; a catalog without them gives columns without statistics. A `NULL` size or count counts as 0.
- **Cancel.** The `signal` goes to the driver with every statement; PostgreSQL and DuckDB stop a running statement, Quack gives it up, and the reader fails with `ABORTED`.

## Properties and storage

`properties()` returns the specification version, `created_by`, `data_path`, the `encrypted` flag, every row of `ducklake_metadata` (`key`, `value`, `scope`, `scopeId`; global entries first, then by key; a scoped row is an option of one table), the snapshot count and the time of the first and latest snapshot. After `expire_snapshots` these describe the snapshots that are left. `metadata()` and `snapshotCount()` read one part each, for callers that need no more. `globalValue(metadata, key)` in `model.ts` picks a global entry such as `data_path`.

`storage(snapshot)` returns the data path, the flag, count and size of the data and delete files visible at the snapshot, and what waits for cleanup: the number of rows in `ducklake_files_scheduled_for_deletion`, the oldest `schedule_start` and how the files split into **ready** and **waiting** (`split`). One query groups the rows by `schedule_start` (the files of one operation share it); the split is made in `src/catalog/scheduled.ts` against the clock of the reader, with the age of the global option `delete_older_than`, or `2 days` when the lake sets none. A file is ready when it was scheduled at least that age ago: that is what `ducklake_cleanup_old_files` without `older_than` deletes (checked on a real lake with DuckDB 2.0.0 and DuckLake 1.1, see [Maintenance scripts](maintenance.md)). `split.age` names the age and where it comes from, `split.nextReadyAt` is when the oldest waiting file becomes ready. An age of months or years has no fixed length, and an unreadable one gives `split: null`: only the count is shown then. That table has no size column, so there is no size for those files. `scheduledForDeletion(metadata?)` reads only that part; a caller that has read `metadata()` hands it over, so the options are not read twice. No file path and no encryption key leaves the reader. `storage()` also returns `expirableSnapshots`, the same split for snapshots: one query reads the time of every snapshot but the newest (`ducklake_snapshot`; the newest never expires), and the split is made in `src/catalog/expirable.ts` with the global option `expire_older_than`, or `30 days` (the age of aantje; DuckLake itself expires nothing without the option) when it is unset or empty. `expirableSnapshots(metadata?)` reads only that part and takes the metadata like `scheduledForDeletion`. See [Storage report](storage-report.md).

`smallFiles(snapshot)` returns tables with data files below 16 MiB, most small files first. `lakeGrowth(snapshot, limit = 500)` is the lake-wide version of the table growth: one statement over all files, the state summed after each snapshot, and a longer history merged by the same `growth()` helper. A point has the snapshot, its time (`null` once expired), files, bytes and `compaction`.

`growthChanges(first)` feeds the [Growth report](growth-report.md): what every snapshot did to the live rows, bytes and files of each table. One statement reads all files (`queries.growthChanges`), one the inlined tables (`queries.inlinedGrowthChanges`, at most 200 tables; `inlinedMore` and `inlinedFailed` say what was left out). Events are a `UNION ALL`: a data file adds rows, bytes and a file at `begin_snapshot` and removes them at `end_snapshot`; a delete file takes its `delete_count` rows off at its begin and gives them back when it or its data file ends; an inlined row lives from `_ducklake_begin_snapshot` to `_ducklake_end_snapshot`. A file whose `partial_max` is later counts in `partialFiles`, which marks those snapshots as not exact. Everything before `first` is summed into one entry per table (`snapshot: null`). Rows removed by an inlined delete (`ducklake_inlined_delete_<id>`) are not subtracted, as in `tables`.

## Partitioning, sort order, tags and macros

- **Partitioning.** The partitioning visible at the snapshot with its columns in key order: id, transform as stored (`identity`, `year`, `bucket(4)`, ...) and the name path down to a nested field. A reset partitioning gives `undefined`. A caller that has read `columns()` passes it so `ducklake_column` is not read again.
- **Sort order.** Expression text as DuckDB prints it, dialect, `ASC`/`DESC` and `NULLS_FIRST`/`NULLS_LAST` as stored.
- **Tags.** Tags of the table and of its columns (with the name path), without `comment`, sorted by key.
- **Macros.** Macros of a schema visible at the snapshot, by name, with kind (`scalar` or `table`) and per implementation the dialect, parameters (name, default, type) and body. A parameter has a type only when declared (DuckLake stores `unknown`, returned as `null`). The default is a SQL expression usable as is by the [DDL scripts](ddl.md#scripts-for-macros). A macro without a row in `ducklake_macro_impl` is not listed.

## Snapshot details and changes

`SnapshotInfo` has `author`, `commitMessage` and `commitExtraInfo` (raw text, usually JSON). They are `null` for a snapshot without commit metadata and for catalogs whose `ducklake_snapshot_changes` lacks those columns.

`parseChanges(changes)` in `src/catalog/changes.ts` structures `changes_made` and is the one place that knows the tokens and the quoting (`describeChanges` in `src/snapshot.ts` builds on it). Each `ChangeEntry` has `token`, `action` (`created`, `dropped`, `altered`, `inserted`, `deleted`, `inlined_insert`, ...), `object` (schema, table, view, macro, ...), `id`, `name` as a path and `raw`. Entries are separated by commas, but not inside a quoted name; a quote in a name is doubled. An entry that is not understood stays in place with `action: 'unknown'`.

`snapshotChanges(snapshotId)` adds names from the catalog. `ResolvedChange` has the action, object kind, `objectId`, `schemaName`, `name` and `raw`. Names are looked up without the visibility rule, because the snapshot may drop the object: for an id the newest version that began at or before the snapshot counts. A `created_*` entry carries a name; if its id has an earlier version, the entry is a rename (DuckLake writes `RENAME TO` as `created_table` with the same id) and the action is `renamed`. A snapshot without changes, or one that does not exist, gives an empty list. After `expire_snapshots` the changes stay recorded but rows of objects that ended before the oldest snapshot are gone: `objectId` stays, names are `null`.

`snapshotActivity(limit = 500, range?, signal?)` feeds the [Snapshot report](snapshot-report.md): `{ snapshots, more }` for the newest `limit` snapshots of `range` (`{ from?, to? }`, both included), with id, time, author, commit message and resolved changes. It resolves with a few statements instead of one per snapshot: per object kind, one for the versions of objects named by id (chunks of 500 ids) and one for objects that begin inside the range. The version in force is picked in memory. Missing optional tables leave entries named by their tokens only.

`lifetime(kind, id)` gives `{ begin, end }` over all versions of a table or view row: `begin` is the smallest `begin_snapshot`, `end` is `null` while open, else the largest `end_snapshot`. A rename starts a new version under the same id, so the lifetime runs through it. The result is `undefined` for an id without a row. [Time travel](time-travel.md) uses it.

`schemaHistory(tableId, limit = Infinity, signal?)` feeds [Schema History](schema-history.md): `{ versions, more }`, the newest `limit` versions, oldest first. A version exists for every snapshot at which the table's name or schema, a column or a column comment began or ended. It holds the snapshot's time, author and commit message (null once expired), the table name after it (null while the table does not exist) and the column tree as `columns()` reads it, built in memory from all versions of `ducklake_column` and `ducklake_column_tag`. It needs four statements however many versions there are. With `more`, the oldest version returned is only a starting point. An id that is not a table gives no versions.

## Schema differences

`src/catalog/schema-diff.ts` has two pure functions.

- `diffColumns(before, after)` compares two column trees. Columns are matched by `id`, which survives renames and type changes. Nested fields are columns of their own with a name path. Entries are `added`/`removed` (with `type`), `renamed` (`from`), `typeChanged`, `nullableChanged`, `defaultChanged`, `commentChanged` (`from`, `to`) and `moved`. The result lists the columns of `after` in table order, then the removed ones. `moved` is reported only for columns outside the longest run that kept its order, so an inserted or dropped column moves nobody. A column id under another parent counts as removed and added.
- `diffEntries(before, after)` compares two lists of tables and views, matched by kind and id: `added`, `dropped`, `renamed` (a move to another schema is a rename of the qualified name).

## Reads for the health check

These reads feed the [health check](health-check.md). All take the signal and follow the rule for optional tables.

- **`consistency(scope, snapshot, sampleLimit)`** runs one statement per entry of `CONSISTENCY_CHECKS` (15, SQL in `queries/maintenance.ts`): rows that contradict each other, such as a file of a table without a row, a delete file without data file, negative counts or overlapping row ids. Each returns the total count and the first `sampleLimit` offenders by id. With `scope.tableId` only that table is read, with `scope.schemaId` only the tables the schema has or had (a dropped table keeps its file rows until cleanup); the checks on views stay lake-wide and are not run for either. A check whose tables are missing is `unavailable`, not an error. The row-id check ignores merged files and files that flushed inlined rows of several snapshots.
- **`maintenanceFacts(scope, limit)`** takes the same scope (`HealthScopeRef`: none for the lake, `tableId`, or `schemaId`) and gives holes in the snapshot numbering (always the whole lake's), tables made of small files (at least `SMALL_FILES.minFiles` files, at least `SMALL_FILES.ratio` of them below `SMALL_FILE_BYTES`; the thresholds are in the statement, because `limit` cuts the list) and rows still valid in inlined tables. Inlined table names are checked against `INLINED_TABLE` before they enter a statement.
- **`deleteHeavyTables(scope, floor, threshold, limit)`** serves the [Maintenance Advisor](advisor.md): tables whose data files have a valid delete file that deletes at least `floor` of the rows, with how many reach `threshold` (what `ducklake_rewrite_data_files` rewrites). Shares are compared as whole basis points so all three engines agree.
- **`fileLocations(scope, dataPath, limit)`** gives every data and delete file of the scope (`directory` is the directory of the table, or of the schema for `scope.schemaId`), current or kept by older snapshots, with its expected place (rules in `src/catalog/locations.ts`, base `dataPath`), names, size, count, snapshots, encryption flag and format (`parquet`, or `puffin` for a deletion vector), plus files scheduled for deletion. `more` and `moreScheduled` say that `limit` cut the list.
- **`columnHistory(tableId)`** gives id and name of every top-level column the table ever had, so a renamed column is not taken for a stranger.

## Optional tables and older catalogs

Some tables and columns may be missing: the commit columns of `ducklake_snapshot_changes`, the partition, sort and macro tables, `ducklake_column_tag`, `ducklake_files_scheduled_for_deletion`. For these reads a `QUERY_FAILED` means "not there": the result is empty (no partitioning, no macros, nothing scheduled, `null` commit fields) and nothing is thrown. Other driver errors pass on. The price: a statement that fails for another reason, such as a permission, also looks empty.

## Normalised values

The helpers in `reader/rows.ts`, `reader/columns.ts` and `reader/core.ts` hide differences between engines.

- **Time.** `toIsoUtc` returns ISO 8601 UTC with milliseconds. SQLite returns the text DuckDB wrote, with the writer's offset; offsets are converted and a time without a zone is rejected.
- **Booleans.** `toBoolean` reads `0`/`1` (SQLite) and `true`/`false`; anything else fails.
- **Numbers.** `toNumber` accepts finite numbers only and fails loudly instead of rounding. Sums and counts are cast to `BIGINT` in SQL (PostgreSQL returns `NUMERIC`, DuckDB `HUGEINT`).
- **Defaults.** `ColumnInfo.defaultValue` is a SQL expression that can follow `DEFAULT` as is. The reader returns `null` for no default, the stored text for expressions and numeric or boolean literals, and quotes every other literal (including `nan`, `inf`, `-inf`).
- **View column names.** `column_aliases` is a list of quoted identifiers; the reader returns the names, or an empty list.

## Portable SQL

The statements in `queries/` run unchanged on SQLite, DuckDB and PostgreSQL, and through Quack:

- positional `?` placeholders only, none inside a string literal or a comment (the PostgreSQL driver rewrites `?` to `$n`, the Quack driver replaces each by its value as a literal);
- no engine-specific functions, only joins, `GROUP BY`, `COALESCE`, `CAST`, `MAX`, `SUM`, `COUNT`, `UNION ALL`, `LIKE`, constant `LIMIT` and correlated sub-selects;
- every aggregate cast to `BIGINT`;
- no column that exists only in a newer specification, except in statements that may answer "not there".

## Known limits

- Inlined rows are not counted.
- Rows and sizes are exact at the latest snapshot and from the largest `partial_max` of the visible files on. Before that, `TableStats.approximate` is `true`. A second DELETE or an UPDATE on the same data file already sets `partial_max`; compaction is not needed.
- Schemas nested in schemas (specification 1.1) are shown flat; `SchemaInfo` has no parent.
- DuckLake cannot set schema comments yet; the reader shows one once a `comment` tag exists.
- Names sort by the collation of the database, so mixed-case names can sort differently in PostgreSQL than in SQLite or DuckDB.

## Tests

Contract tests in `test/contract` run every read against SQLite, DuckDB and PostgreSQL catalogs with the same content (written by `test/fixtures/generate.py`), plus a specification 1.0 catalog and edited copies for cases the generator cannot write, and against a Quack server. PostgreSQL and Quack are opt-in because they start a container (`npm run test:full`).

```text
npx vitest run test/contract/reader.contract.test.ts
npx vitest run test/contract/history-reader.contract.test.ts
```
