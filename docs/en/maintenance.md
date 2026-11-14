# Maintenance scripts

DuckLake has no `VACUUM` or `OPTIMIZE` for a lake. Functions called with `CALL`, and `CHECKPOINT`, do that work. The **Maintenance** submenu opens a SQL document with the call, written for the node you clicked, and the user runs it (F5). Opening a document never runs it. The module is `src/maintenance/scripts.ts` (`maintenanceOf`): pure functions, no I/O, no `vscode` import, like the [Script as](ddl.md#the-script-as-submenu) texts.

## What replaces VACUUM and OPTIMIZE

Signatures checked with DuckDB 2.0.0 and DuckLake (`duckdb_functions()`):

| Purpose                                        | Call                                                                                     | Parameters                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| All of the following, in the recommended order | `CHECKPOINT lake;`                                                                       |                                                                                     |
| Merge small files (OPTIMIZE)                   | `CALL ducklake_merge_adjacent_files('lake' [, 'table', schema => 's'])`                  | `min_file_size`, `max_file_size`, `max_compacted_files`, `newer_than`, `older_than` |
| Rewrite files with many deleted rows           | `CALL ducklake_rewrite_data_files('lake' [, 'table', schema => 's'])`                    | `delete_threshold`, `max_compacted_files`                                           |
| Write inlined rows to files                    | `CALL ducklake_flush_inlined_data('lake' [, schema_name => 's', table_name => 't'])`     | `schema_name`, `table_name`                                                         |
| Expire old snapshots                           | `CALL ducklake_expire_snapshots('lake', ...)`                                            | `older_than`, `versions`, `dry_run`                                                 |
| Delete files nothing needs (VACUUM)            | `CALL ducklake_cleanup_old_files('lake', ...)`                                           | `older_than`, `cleanup_all`, `dry_run`                                              |
| Delete files the catalog does not know         | `CALL ducklake_delete_orphaned_files('lake', ...)`                                       | `older_than`, `cleanup_all`, `dry_run`                                              |
| Set an option for the lake or a table          | `CALL ducklake_set_option('lake', 'name', 'value' [, table_name => 't', schema => 's'])` |                                                                                     |

`OPTIMIZE` is a syntax error in DuckDB. `VACUUM` is for DuckDB database files and fails on a lake.

## The Maintenance submenu

The submenu is in the context menu of an open connection, a schema and a table (group `2_script_maintenance`, between **Script as** and **Time Travel**). Its eight commands (`aantje.maintenanceCheckpoint`, `Merge`, `Rewrite`, `Flush`, `Expire`, `Cleanup`, `Orphans`, `Option`) are hidden from the Command Palette because they need a node. Each opens an untitled SQL document of the node's connection, so F5 runs it there (see [SQL editor](sql-editor.md)). In a read-only connection, calls that commit to the catalog are refused; **Clean Up Old Files** and **Delete Orphaned Files** delete files anyway (see [SQL session](sql-session.md)), and their scripts say so.

| Entry                     | Connection | Schema                    | Table | Script                                                          |
| ------------------------- | ---------- | ------------------------- | ----- | --------------------------------------------------------------- |
| **Checkpoint**            | yes        | no                        | no    | `CHECKPOINT lake;`                                              |
| **Merge Adjacent Files**  | all tables | one call per table        | yes   | `ducklake_merge_adjacent_files`, with `'table', schema => 's'`  |
| **Rewrite Data Files**    | all tables | one call per table        | yes   | `ducklake_rewrite_data_files`, with `'table', schema => 's'`    |
| **Flush Inlined Data**    | all tables | one call, `schema_name`   | yes   | `ducklake_flush_inlined_data`, with `schema_name`, `table_name` |
| **Expire Snapshots**      | yes        | no                        | no    | dry run first                                                   |
| **Clean Up Old Files**    | yes        | no                        | no    | dry run first                                                   |
| **Delete Orphaned Files** | yes        | no                        | no    | dry run first                                                   |
| **Set Option**            | the lake   | the options of the schema | yes   | a template in which every statement is a comment                |

- **The lake is named `lake`.** The SQL editor attaches it as `lake` and makes it the default catalog; every script uses that name, not the connection name.
- **Table names are string literals**, never identifiers: schema and table go into `'...'` with single quotes doubled, always together (a bare table name is looked up in `main`). Names never appear in a comment, so quotes, line breaks, `--` and `;` stay inside the literal.
- **When the tree shows an older snapshot**, a table script notes that it acts on the newest state.
- Merge, rewrite and flush change files, not table content. DuckLake keeps the old files until a cleanup removes them.
- Merge and rewrite take the table as the second positional argument and the schema as the named parameter `schema`; `table_name` is not valid there. Flush names both (`schema_name => 's', table_name => 't'`). A file with a delete file is not merged with others; **Rewrite Data Files** removes delete files when the deleted share reaches `rewrite_delete_threshold`. So the Merge script rewrites small files with deleted rows first, see [below](#merge-adjacent-files-small-files-with-deleted-rows).

## Merge Adjacent Files: small files with deleted rows

`ducklake_merge_adjacent_files` skips every data file that has a delete file. `ducklake_rewrite_data_files` rewrites a file only from `delete_threshold` of its rows deleted (the lake option `rewrite_delete_threshold`, else 0.95). A table that loses a few rows after each insert keeps all its small files: neither call touches them. Checked with DuckDB 2.0.0 on a test lake with 6 small files, each with a delete file: the merge left 6 files, the rewrite with the default threshold 6, and the rewrite with `delete_threshold => 0` wrote 1 file without deletes.

So the Merge script of a table, a schema and the lake reads, at the newest state, which of its tables have small files (below 16 MiB) with a delete file. Before the merge of each such table it puts:

```sql
-- 29 of the small files of this table have deleted rows, and the merge leaves such files alone.
-- This rewrite drops the deleted rows and writes the files anew: it rewrites every file of the table with a deleted row (29 files, 623 KB).
CALL ducklake_rewrite_data_files('lake', 'fact_payment', schema => 'gold', delete_threshold => 0);
```

- `delete_threshold => 0` rewrites every file of the table that has a deleted row, large ones too. The comment says how many files that is and how large they are, so a table of large files is not rewritten blindly. A lower threshold for all tables would be wrong: a table of large files would rewrite a file for a single deleted row.
- Tables without small files with deleted rows keep the plain merge. In the script of the lake the rewrites come before the one merge call, by schema and table name.
- One statement reads it for the whole script (`deletedSmallFiles` of the catalog reader), the same on SQLite, DuckDB, PostgreSQL and Quack catalogs. It counts a delete file only through a data file that is valid at the newest state. A size below 1 byte adds nothing to the size in the comment.
- The read takes at most 1000 tables, by table id. When more tables have such files, the script of the lake lists 1000 rewrites, and the script of a schema can miss the rewrite of a table it lists. Both scripts then say so: run the script, then make it again for the others.
- When the read fails or the explorer is not connected (for example while a read/write session holds a DuckDB file), the script says that it could not tell which files have deleted rows, and the merge stays plain.
- `maintenanceScript` reads it; `maintenanceOf` takes it as the argument `deleted`, so the texts stay testable without a catalog. A report that counted the files already passes its counts to `maintenanceScript`, which then reads nothing. `src/maintenance/deletes.ts` writes the lines. `test/unit/maintenance-lake.test.ts` and `test/unit/maintenance-schema-lake.test.ts` run the scripts on real lakes: the table ends with one file and no delete file.

## Scripts for a schema

On a schema node, **Merge Adjacent Files**, **Rewrite Data Files**, **Flush Inlined Data** and **Set Option** write one script for all tables of the schema (`schemaScript` in `src/maintenance/scripts.ts`). Checkpoint and the three destructive scripts act on the whole lake and are not offered there.

- **Merge and rewrite: one call per table.** Checked with DuckDB 2.0.0 and DuckLake 1.1 (`duckdb_functions()` and a real lake): the `schema` parameter exists only in the overload that has `table_name`, so `ducklake_merge_adjacent_files('lake', schema => 's')` and `ducklake_rewrite_data_files('lake', schema => 's')` fail with `Invalid named parameter "schema"`, and `schema_name` is no parameter of either. The script lists `CALL ducklake_merge_adjacent_files('lake', 'events', schema => 's');` for each table the schema has at the newest snapshot, in the order of the tree. A schema with more than 1000 tables lists the first 1000 and says how many are left out; a schema without tables says so.
- **Flush: one call.** `ducklake_flush_inlined_data('lake', schema_name => 's')` flushes every table of the schema and no other.
- **Set Option** lists the options that DuckLake accepts for a schema, each as `set_option('name', value, schema => 's')` in a comment: all but `expire_older_than`, `delete_older_than` and `require_commit_message` (global only) and `skip_stats_columns` (table only). An option of the schema overrides the lake's for its tables, and one of a table overrides both. Each call runs on a real lake in `test/unit/maintenance-schema-lake.test.ts`, which also shows that the other schema keeps its files, delete files, inlined rows and options.
- **The table list is read when the script opens** (`maintenanceScript` reads `tables` of the catalog at the newest snapshot; a tree that shows an older snapshot says in the script that it acts on the newest state). The merge also reads the tables with small files with deleted rows and rewrites them first, [as above](#merge-adjacent-files-small-files-with-deleted-rows). `maintenanceOf` alone takes the names as an argument, so the texts stay testable without a catalog. Names appear only in string literals.

## Destructive scripts: the dry run is the active one

**Expire Snapshots**, **Clean Up Old Files** and **Delete Orphaned Files** destroy what cannot be restored. Their scripts start with a dry run (`dry_run => true`) that only lists what would be affected. The real call is commented out below it, with a warning (Clean Up Old Files has a second commented call, see below):

- Expired snapshots can no longer be read; there is no way back.
- Cleanup deletes data files for good.
- Orphan deletion removes files the catalog does not know. A running writer, such as Sail, may have uploaded files it has not committed; deleting them breaks its commit. Keep the age longer than its longest write.

The age of the dry run follows the lake, see [Expire Snapshots and Delete Orphaned Files](#expire-snapshots-and-delete-orphaned-files-which-age-the-script-uses) below. **Checkpoint** has no dry run and is just as destructive: it follows the lake's options, so with `expire_older_than` set it expires snapshots, and it deletes files nothing needs and orphaned files. Its script says so and points to the three dry runs. It also says what it does with `expire_older_than`, `delete_older_than`, `rewrite_delete_threshold`, `target_file_size` and `auto_compact`, and that the DuckDB setting `ducklake_target_file_size`, when it is set, overrides `target_file_size` for `CHECKPOINT`.

**The header lists the current option values.** The scripts of Expire Snapshots, Clean Up Old Files, Delete Orphaned Files and Checkpoint start with the global values of those five options as the lake has them when the script is made (`not set` for an option without a value; they show as the lake stores them, for example `512000000` for a size). The commands read them once from the catalog (`maintenanceScript`, which wraps `maintenanceOf` and passes `src/maintenance/header.ts` the rows of `ducklake_metadata`); `maintenanceOf` alone writes no values, so scripts stay testable without `vscode`. When the catalog cannot be read (a closed connection), the header says that the values are not available. A value that is not plain words and numbers is shown as `set (not shown)`, because the value comes from the catalog and a comment never holds catalog text.

## Clean Up Old Files: what the script deletes

The script of **Clean Up Old Files** has no age of its own. Its three calls are:

```sql
CALL ducklake_cleanup_old_files('lake', dry_run => true);
-- CALL ducklake_cleanup_old_files('lake');
-- CALL ducklake_cleanup_old_files('lake', cleanup_all => true);
```

The first is active: a dry run that lists what would be deleted and deletes nothing. The second is the real call; the third deletes every scheduled file at once, however recent. Without `older_than` the function takes the age from the option `delete_older_than` of the lake, so the script follows the option without reading it (`older_than => now() - INTERVAL 7 DAY` in a call overrides it). The header of the script says what is active and what to uncomment.

What DuckLake does, checked on a real lake with DuckDB 2.0.0 and DuckLake 1.1 (`test/unit/maintenance-scheduled.test.ts`):

- A scheduled file is **ready** when it was scheduled at least the age ago, and **waiting** before. Only ready files are listed by the dry run and deleted by the real call; the real call also removes their rows from `ducklake_files_scheduled_for_deletion`. Waiting files stay and are listed again later. `cleanup_all => true` ignores the age.
- With `delete_older_than` unset the age is 2 days: a file scheduled 47 hours ago is spared, one scheduled 48 hours ago goes. With the option set to `1 day` the age is one day. An empty option makes the call fail (`either cleanup_all OR older_than must be specified`).
- A freshly merged or expired lake has only waiting files, so the script as generated changes nothing for two days. That is not an error: the pages of aantje say how many files are ready now and how many wait (and until when), see [Storage report](storage-report.md#files-scheduled-for-deletion), and tell what the script needs when nothing is old enough. The script itself has no numbers: it is made from the state of the tree, which has no read of the scheduled files, so no catalog read is added when a script opens.

## Expire Snapshots and Delete Orphaned Files: which age the script uses

Both scripts have the same shape: a dry run that is active, the real call commented out, and, when the dry run follows the lake, a third, commented call with an age of its own (`older_than => now() - INTERVAL 7 DAY`). The header says what is active and what to uncomment. What the two functions do without `older_than` was checked on a real lake with DuckDB 2.0.0 and DuckLake 1.1 (`test/unit/maintenance-expire.test.ts`):

| Call without `older_than`        | Option not set                                                       | Option set (`1 day`, `4 days`, ...)   | Option empty                                                    |
| -------------------------------- | -------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `ducklake_expire_snapshots`      | expires **nothing**, however old the snapshots are, and says nothing | takes the snapshots at least that old | expires nothing, like not set                                   |
| `ducklake_delete_orphaned_files` | takes 2 days: a file younger than that is spared                     | takes the files at least that old     | **fails**: `either cleanup_all OR older_than must be specified` |

The newest snapshot never expires. `expire_older_than` and `delete_older_than` are global options only.

So the active dry run of the scripts is:

- **Expire Snapshots, option set:** `CALL ducklake_expire_snapshots('lake', dry_run => true);`. It follows the option; the header lists its value. The real call is the second statement, the explicit age the third.
- **Expire Snapshots, option not set or empty:** the active call names an age, `older_than => now() - INTERVAL 30 DAY`, the default of aantje (the age the [Maintenance Advisor](advisor.md) measures with), because the call without an age would list nothing and the script would look like a lake with nothing to do. The header says that and that the age is to be edited. The real call has the same age; there is no third call.
- **Delete Orphaned Files, option set or not set:** `CALL ducklake_delete_orphaned_files('lake', dry_run => true);`. DuckLake takes the option, or 2 days.
- **Delete Orphaned Files, option empty:** the active call names `INTERVAL 2 DAY` (what DuckLake uses when the option is not set), because the call without an age fails.

The scripts of the Maintenance menu and the SQL editor read the option values from the catalog when they are made (`maintenanceScript`). A script made without them (`maintenanceOf` alone, and the scripts of the [Health Check](health-check.md)) takes the option as not set: Expire Snapshots then names the age of 30 days, and its header says that the lake set none "or it could not be read".

The pages show what such a script takes: the [Storage report](storage-report.md#snapshots-to-expire) and the [Maintenance Advisor](advisor.md) tell how many snapshots are expirable now and how many are younger than the age.

## Set Option

**Set Option** writes a template in which every statement is a comment, so running it changes nothing. The user removes the `-- ` before the options they want and edits the values. `SELECT * FROM ducklake_options('lake')` shows the current values. The scripts call the functions with the lake's name as their first argument: `lake.set_option()` and `lake.options()` are looked up in the schema `main`, which a lake can lack.

The template lists every option that DuckLake documents as settable, one comment with the default above each statement (`src/maintenance/options.ts`). The read-only ones (`created_by`, `data_path`, `encrypted`, `version`) are not offered.

- **The lake only:** `expire_older_than` (example `30 days`), `delete_older_than` (`7 days`), `require_commit_message` (`true`).
- **A table only:** `skip_stats_columns`.
- **The lake, a schema or a table:** `target_file_size` (`512MB`), `data_inlining_row_limit` (`10`), `parquet_compression` (`zstd`), `rewrite_delete_threshold` (`0.5`), `auto_compact` (`false`), `hive_file_pattern`, `parquet_compression_level`, `parquet_row_group_size`, `parquet_row_group_size_bytes`, `parquet_version`, `per_thread_output`, `sort_on_insert`, `write_deletion_vectors` (experimental).

The same options can be set as statements: see [Table options](ddl.md#table-options).

The table template has every option that can be set for a table (all but the three that are global only), each with `table_name => 't', schema => 's'`. The `<column>` of `skip_stats_columns` is a placeholder. DuckLake stores a size as bytes (`512MB` becomes `512000000`) and `parquet_version` as `V2`; `skip_stats_columns` is stored as column ids. `delete_older_than` has no default on one page of the DuckLake documentation and 2 days on another; the script names 2 days, and on a real lake files that became obsolete today are spared without the option. `auto_compact = false` for a table makes `CHECKPOINT` and the merge, rewrite and flush calls skip it even when it is named; a global `false` also disables `ducklake_delete_orphaned_files`. DuckLake accepts `require_commit_message` for a schema as well, but the documentation lists it as global, so the script offers it only for the lake.

## Other places that open these scripts

The [Storage report](storage-report.md) opens **Merge Adjacent Files** and **Rewrite Data Files** for the selected table and **Clean Up Old Files** and **Expire Snapshots** from its header. The [Maintenance Advisor](advisor.md) and the [Health check](health-check.md) open the script that fits a recommendation or finding; the Health check can also write [one script for all findings](health-check.md#the-maintenance-script-for-all-findings), and the Advisor [one for all recommendations](advisor.md#the-maintenance-script-for-all-recommendations). All are built by `maintenanceOf`, start destructive ones with a dry run and run nothing when the document opens. The Advisor also runs the dry runs itself in a read-only session. The merge of a table that the Advisor opens, the one in its script for all recommendations and the one in the script of a Health finding about small files rewrite the small files with deleted rows first too, from the counts those reports read. When the Health check could not read those counts, the script of its finding says so.

## Limits

- The scripts are text. aantje asks no confirmation and shows no summary; dry-run results appear in the SQL editor's results panel.
- The parameters are in comments; the example age is not a recommendation.
- `ducklake_add_data_files` has no entry. There is no entry for a view or a closed connection.
