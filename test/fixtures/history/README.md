# History fixture

A DuckLake with a long history, written by DuckDB 2.0.0 and the DuckLake extension (specification 1.1, `ducklake_metadata.version` is `1.1`). It covers what the other fixtures lack: partitioning, sort orders, updates, data inlining, multi-table transactions, commit messages, schema evolution, macros, dropped objects, a compaction and expired snapshots. It has Parquet data files, so the data engine can read it.

**The fixture is frozen.** Tests pin its snapshot ids and object ids (`test/support/expected-history.ts`). The statement list in `generate-history.py` must not change; a regeneration only changes UUIDs, times, file names and file sizes.

| Path                     | Content                                                                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `history.sqlite`         | The catalog with SQLite metadata.                                                                                                                                                               |
| `history.duckdb`         | The same catalog with DuckDB metadata.                                                                                                                                                          |
| `history.postgres.sql`   | The same catalog as the `pg_dump` (plain `INSERT` statements) of its PostgreSQL tables, in the conventions of `../postgres.sql`. Metadata only: the data path is `/tmp/aantje-fixture-data/`.    |
| `history-expired.sqlite` | A copy of `history.sqlite` after `ducklake_expire_snapshots` for the snapshots 1 to 54. Metadata only; its data path is the one of `history.sqlite`.                                            |
| `sqlite-files/`          | Parquet data and delete files of `history.sqlite` and `history-expired.sqlite`.                                                                                                                 |
| `duckdb-files/`          | Parquet data and delete files of `history.duckdb`.                                                                                                                                              |
| `generate-history.py`    | Builds one backend. The statement list is below.                                                                                                                                                |
| `regenerate-history.ps1` | Runs `generate-history.py` in throw-away containers and writes all files above.                                                                                                                 |

All inserts and deletes create Parquet files (`DATA_INLINING_ROW_LIMIT 0`), except for the table `shop.notes`, which has data inlining (limit 10, set per table).

## Snapshots

Latest snapshot: 56. The column `changes_made` is `ducklake_snapshot_changes.changes_made`. "Exercises" says why the statement is in the list.

| Id  | Statement                                                                    | `changes_made`                                         | Exercises                                                                                           |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 0   | the default schema `main`                                                    | `created_schema:"main"`                                |                                                                                                     |
| 1   | `CREATE SCHEMA shop`                                                         | `created_schema:"shop"`                                |                                                                                                     |
| 2   | `CREATE SCHEMA scratch`                                                      | `created_schema:"scratch"`                             | a schema that is dropped again                                                                      |
| 3   | `DROP SCHEMA scratch`                                                        | `dropped_schema:2`                                     | `dropped_schema` token, schema `end_snapshot`                                                       |
| 4   | `CREATE TABLE shop.events (id NOT NULL, kind, ts, amount DECIMAL(10,2))`     | `created_table:"shop"."events"`                        |                                                                                                     |
| 5   | `ALTER TABLE shop.events SET PARTITIONED BY (kind, year(ts))`                | `altered_table:3`                                      | first partitioning (partition id 4)                                                                 |
| 6   | `INSERT` of 6 rows into `shop.events`                                        | `inserted_into_table:3`                                | 3 files (3, 1 and 2 rows), one per partition                                                       |
| 7   | `INSERT` of 1 row into `shop.events`                                         | `inserted_into_table:3`                                | a file of 1 row                                                                                     |
| 8   | `INSERT` of 40 rows into `shop.events`                                       | `inserted_into_table:3`                                | a large file (40 rows) in the partition `(click, 2025)` that already has a file                     |
| 9   | `ALTER TABLE shop.events SET PARTITIONED BY (kind, month(ts))`               | `altered_table:3`                                      | the partitioning changes: partition 4 ends, partition 5 starts                                      |
| 10  | `INSERT` of 4 rows into `shop.events`                                        | `inserted_into_table:3`                                | 3 files in the new partitioning                                                                     |
| 11  | `CREATE TABLE shop.readings (sensor, taken_at, value DOUBLE)`                | `created_table:"shop"."readings"`                      |                                                                                                     |
| 12  | `ALTER TABLE shop.readings SET SORTED BY (sensor ASC, taken_at DESC)`        | `altered_table:6`                                      | first sort order (sort id 7)                                                                        |
| 13  | `INSERT` of 4 rows into `shop.readings`                                      | `inserted_into_table:6`                                |                                                                                                     |
| 14  | `ALTER TABLE shop.readings SET SORTED BY (value DESC NULLS FIRST)`           | `altered_table:6`                                      | the sort order changes: sort 7 ends, sort 8 starts                                                  |
| 15  | `CREATE TABLE shop.customers (id NOT NULL, name, tier)`                      | `created_table:"shop"."customers"`                     |                                                                                                     |
| 16  | `INSERT` of 4 rows into `shop.customers`                                     | `inserted_into_table:9`                                | `insert` in `table_changes`                                                                         |
| 17  | `UPDATE shop.customers SET tier = 'gold' WHERE id = 2`                       | `inserted_into_table:9,deleted_from_table:9`           | an update is an insert and a delete: `update_preimage` and `update_postimage`                       |
| 18  | `DELETE FROM shop.customers WHERE id = 4`                                    | `deleted_from_table:9`                                 | `delete` in `table_changes`; the delete file of 17 is replaced                                      |
| 19  | `CREATE TABLE shop.notes (id, body)` and the option `data_inlining_row_limit` 10 | `created_table:"shop"."notes"`                     | the option itself takes no snapshot (row in `ducklake_metadata` with scope `table`)                 |
| 20  | `INSERT` of 3 rows into `shop.notes`                                         | `inlined_insert:10`                                    | `inlined_insert` token, no Parquet file                                                             |
| 21  | `UPDATE shop.notes SET body = 'changed' WHERE id = 1`                        | `inlined_insert:10,inlined_delete:10`                  | both inlined tokens in one snapshot                                                                 |
| 22  | `DELETE FROM shop.notes WHERE id = 3`                                        | `inlined_delete:10`                                    | `inlined_delete` token                                                                              |
| 23  | `BEGIN; INSERT INTO shop.customers ...; INSERT INTO shop.events ...; COMMIT` | `inserted_into_table:3,inserted_into_table:9`          | ONE snapshot that changes two tables                                                                |
| 24  | `BEGIN; CREATE TABLE shop.audit ...; INSERT INTO shop.audit ...; COMMIT`     | `created_table:"shop"."audit",inserted_into_table:11`  | a table created and filled in one snapshot                                                          |
| 25  | `BEGIN; CALL lake.set_commit_message(...); INSERT INTO shop.customers ...; COMMIT` | `inserted_into_table:9`                          | author `tillmann`, message `Nightly import`, extra info `{"source":"nightly","rows":1}`             |
| 26  | `CREATE TABLE main.evolving (id, name, info STRUCT(a, b), n INTEGER)`        | `created_table:"main"."evolving"`                      | start of the schema evolution                                                                       |
| 27  | `INSERT` of 1 row into `main.evolving`                                       | `inserted_into_table:12`                               |                                                                                                     |
| 28  | `ADD COLUMN extra DOUBLE`                                                    | `altered_table:12`                                     | column id 7                                                                                         |
| 29  | `RENAME COLUMN name TO title`                                                | `altered_table:12`                                     | rename: same column id 2                                                                            |
| 30  | `ALTER COLUMN n TYPE BIGINT`                                                 | `altered_table:12`                                     | type promotion: same column id 6                                                                    |
| 31  | `DROP COLUMN extra`                                                          | `altered_table:12`                                     | dropped column, its id 7 is not reused                                                              |
| 32  | `ADD COLUMN info.c DOUBLE`                                                   | `altered_table:12`                                     | a field added to a struct: new column id 8, parent column 3                                         |
| 33  | `ADD COLUMN flag BOOLEAN DEFAULT false`                                      | `altered_table:12`                                     | a column default, column id 9                                                                       |
| 34  | `ALTER COLUMN flag SET DEFAULT true`                                         | `altered_table:12`                                     | the default changes: same column id 9                                                               |
| 35  | `ALTER TABLE main.evolving RENAME TO evolved`                                | `created_table:"main"."evolved"`                       | a table rename is a `created_table` token; the table keeps its id 12                                |
| 36  | `INSERT` of 1 row into `main.evolved`                                        | `inserted_into_table:12`                               |                                                                                                     |
| 37  | `COMMENT ON TABLE shop.customers`                                            | `altered_table:9`                                      | a table comment                                                                                     |
| 38  | `COMMENT ON COLUMN shop.customers.tier`                                      | `altered_table:9`                                      | a column comment (`ducklake_column_tag`)                                                            |
| 39  | `CREATE VIEW shop.big_events AS SELECT ...`                                  | `created_view:"shop"."big_events"`                     | a view                                                                                              |
| 40  | `COMMENT ON VIEW shop.big_events`                                            | `altered_view:13`                                      | a view comment                                                                                      |
| 41  | `CREATE VIEW shop.tmp_view AS SELECT 1 AS x`                                 | `created_view:"shop"."tmp_view"`                       |                                                                                                     |
| 42  | `DROP VIEW shop.tmp_view`                                                    | `dropped_view:14`                                      | `dropped_view` token, view `end_snapshot`                                                           |
| 43  | `CREATE TABLE shop.old_stuff (x INTEGER)`                                    | `created_table:"shop"."old_stuff"`                     |                                                                                                     |
| 44  | `INSERT` of 2 rows into `shop.old_stuff`                                     | `inserted_into_table:15`                               |                                                                                                     |
| 45  | `DROP TABLE shop.old_stuff`                                                  | `dropped_table:15`                                     | `dropped_table` token; the data file ends with the table                                            |
| 46  | `CREATE MACRO shop.gross(net, rate := 1.19) AS net * rate`                   | `created_scalar_macro:"shop"."gross"`                  | scalar macro with a default parameter                                                               |
| 47  | `CREATE MACRO shop.recent_events(n) AS TABLE SELECT ...`                     | `created_table_macro:"shop"."recent_events"`           | table macro                                                                                         |
| 48  | `CREATE MACRO shop.legacy_fee(x) AS x + 1`                                   | `created_scalar_macro:"shop"."legacy_fee"`             |                                                                                                     |
| 49  | `DROP MACRO shop.legacy_fee`                                                 | `dropped_scalar_macro:18`                              | `dropped_scalar_macro` token, macro `end_snapshot`                                                  |
| 50  | `CREATE TABLE shop.log (id, msg)`                                            | `created_table:"shop"."log"`                           |                                                                                                     |
| 51  | `INSERT` of 1 row into `shop.log`                                            | `inserted_into_table:19`                               | four small files                                                                                    |
| 52  | `INSERT` of 1 row into `shop.log`                                            | `inserted_into_table:19`                               |                                                                                                     |
| 53  | `INSERT` of 1 row into `shop.log`                                            | `inserted_into_table:19`                               |                                                                                                     |
| 54  | `INSERT` of 1 row into `shop.log`                                            | `inserted_into_table:19`                               |                                                                                                     |
| 55  | `CALL ducklake_merge_adjacent_files('lake', 'log', schema => 'shop')`        | `merge_adjacent:19`                                    | compaction: four files become one; the four old files are scheduled for deletion                    |
| 56  | `INSERT` of 1 row into `shop.log`                                            | `inserted_into_table:19`                               | a file after the compaction                                                                         |

## Object ids

Schemas, tables, views, macros, partitionings and sort orders share one counter (`next_catalog_id`), which is why the ids of the tables are not consecutive.

| Id  | Object                                        | Id  | Object                                                  |
| --- | --------------------------------------------- | --- | ------------------------------------------------------- |
| 0   | schema `main`                                 | 10  | table `shop.notes` (inlined)                            |
| 1   | schema `shop`                                 | 11  | table `shop.audit`                                      |
| 2   | schema `scratch` (dropped at 3)               | 12  | table `main.evolving`, `main.evolved` from snapshot 35  |
| 3   | table `shop.events`                           | 13  | view `shop.big_events`                                  |
| 4   | partitioning `(kind, year(ts))`, 5 to 8       | 14  | view `shop.tmp_view` (dropped at 42)                    |
| 5   | partitioning `(kind, month(ts))`, from 9 on   | 15  | table `shop.old_stuff` (dropped at 45)                  |
| 6   | table `shop.readings`                         | 16  | macro `shop.gross` (scalar)                             |
| 7   | sort order `(sensor, taken_at DESC)`, 12 to 13 | 17 | macro `shop.recent_events` (table)                      |
| 8   | sort order `(value DESC NULLS FIRST)`, from 14 | 18 | macro `shop.legacy_fee` (dropped at 49)                 |
| 9   | table `shop.customers`                        | 19  | table `shop.log`                                        |

## Facts that the tests and later features rely on

- **Column ids are stable.** A rename (snapshot 29) and a type change (snapshot 30) keep the `column_id`: the old `ducklake_column` row gets an `end_snapshot` and a new row with the same `column_id` starts at that snapshot. A schema diff can therefore match renamed columns by `column_id`. A dropped column keeps its id forever (7 is never reused); a field added to a struct is a new column (id 8) with `parent_column` 3. Quirk: that struct field has `nulls_allowed` 0, although the others are nullable.
- **A table rename keeps the `table_id`** (12): the old `ducklake_table` row ends at snapshot 35, a new row with the new name starts there. The snapshot says `created_table:"main"."evolved"`, not `altered_table`.
- **Tags:** DuckDB 2.0.0 with the DuckLake extension has no SQL to write tags other than comments. `ducklake_tag` and `ducklake_column_tag` only have the key `comment`. The fixture does not add rows by hand.
- **Sort orders are supported:** `ALTER TABLE ... SET SORTED BY (...)` writes `ducklake_sort_info` and `ducklake_sort_expression`. The expression is stored as DuckDB prints it, so the keyword `value` is `"value"`.
- **Partition values** (`ducklake_file_partition_value`) are text: the `kind`, and the year (`2025`) or the month number (`3`). Files of the first partitioning have `partition_id` 4, files of the second 5; earlier files keep theirs.
- **Commit metadata** is set inside a transaction, as the fixture does: `CALL lake.set_commit_message(author, message, extra_info => ...)` between `BEGIN` and `COMMIT`. The columns `author`, `commit_message` and `commit_extra_info` are `NULL` for every other snapshot.
- **Data inlining:** the rows of `shop.notes` are in the catalog table `ducklake_inlined_data_10_12` (table id 10, schema version 12) with `_ducklake_begin_snapshot` and `_ducklake_end_snapshot`. In the PostgreSQL dump the `VARCHAR` column of that table is `bytea`. The directory `shop/notes` in the Parquet folders is empty.
- **Compaction (snapshot 55):** the merged file (id 26) has `begin_snapshot` 51, the snapshot of the first merged file, and `partial_max` 54; it was written in snapshot 55 and still answers time travel to 51..54. The four replaced files (ids 22 to 25) are in `ducklake_files_scheduled_for_deletion` together with delete file 11 (column `data_file_id` there holds the id of either kind of file). `lake.table_changes` still reports the four inserts at their original snapshots 51 to 54; the compaction itself is no change.
- **Delete files are cumulative.** `shop.customers` has ONE delete file (id 12) for both deletes (snapshot 17 and 18): `begin_snapshot` 17, `partial_max` 18, `delete_count` 2. At snapshot 17 the table has 4 rows, but "rows minus `delete_count` of the visible delete file" says 3 (5 file rows minus 2). Use the data engine for exact rows at a snapshot.
- **Expired copy:** `history-expired.sqlite` has only the snapshots 0, 55 and 56 in `ducklake_snapshot`, but `ducklake_snapshot_changes` still has all 57 rows. The file of the dropped table `shop.old_stuff` (id 21) joins the files scheduled for deletion; the Parquet files themselves are not deleted.
- **`lake.table_changes`** resolves the table name in the current schema: use `USE lake.shop` or `lake.shop.table_changes('customers', 15, 18)`. A qualified name as argument (`'shop.customers'`) fails.
- **Row counts at a snapshot** (`HISTORY_ROWS` in `expected-history.ts`): `shop.events` 6, 7, 47, 47, 51, 52 at snapshots 6, 7, 8, 9, 10, 23; `shop.customers` 4, 4, 3 at 16, 17, 18; `shop.notes` 3, 3, 2 at 20, 21, 22; `shop.log` 4, 4, 5 at 54, 55, 56.

## The data path is relative

The `data_path` in the metadata is `sqlite-files/` and `duckdb-files/`, which DuckLake resolves against the working directory of the reader. Tests copy the fixture and rewrite the row, like for `../data/` (see `../data/README.md`). `copyHistoryFixture` in `test/unit/history-support.ts` does it.

## Use in tests

- `test/support/expected-history.ts`: snapshot ids by statement, the `changes_made` of every snapshot, object ids, files of `shop.events`, row counts.
- `test/support/sources/history.ts`: `historyFixture` (paths) and `historySources` (`sqlite`, `duckdb`, `postgres` with `skipReason()` and `open()`, like `catalogSources`). The PostgreSQL variant is loaded by `test/support/global-setup.ts` into a second database, `history`, of the same container, only with `AANTJE_POSTGRES=1`.
- `test/unit/history-support.ts`: `copyHistoryFixture(kind)`.
- `test/contract/history-fixture.test.ts` proves the facts above with plain SQL; `test/unit/history-data.test.ts` proves that the Parquet files are usable (snapshots, `table_changes`).

## Regenerate

Needs Docker and network access. From the project root, in PowerShell 7.3 or later:

```powershell
pwsh test/fixtures/history/regenerate-history.ps1
pwsh test/fixtures/history/regenerate-history.ps1 -Only files
pwsh test/fixtures/history/regenerate-history.ps1 -OutDir "$env:TEMP\history-preview"
```

`-Only` takes `files` (SQLite, DuckDB, the expired copy and the Parquet files) or `postgres`. The containers and the network are named `aantje-test-histgen`, `aantje-test-histpg` and `aantje-test-histnet` and are removed at the end. The script checks the snapshot ids of the PostgreSQL variant; the generator checks them for the others. Run `npx vitest run test/contract/history-fixture.test.ts test/unit/history-data.test.ts` afterwards.
