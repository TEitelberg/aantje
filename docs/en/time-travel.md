# Time travel: Query at Snapshot, the comparisons, the changes and the restore scripts

The tree shows the whole catalog at one snapshot ([Snapshots, search and status bar](snapshot-search-status.md)). Six commands work with snapshots that the tree does not show. They need a node, so the Command Palette hides them.

| Command                               | Id                              | Node                               | Result                                                                   |
| ------------------------------------- | ------------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| **Query at Snapshot...**              | `aantje.queryAtSnapshot`        | table, view                        | A grid, a notebook or a SQL editor at a snapshot you choose              |
| **Compare Table at Two Snapshots...** | `aantje.compareSchema`          | table                              | A diff editor over the `CREATE TABLE` of two snapshots, and a summary    |
| **Compare Snapshots...**              | `aantje.compareSnapshots`       | connection (only while it is open) | A Markdown report of the tables, views and columns that differ           |
| **Show Changes...**                   | `aantje.showChanges`            | table                              | A grid with the rows inserted, updated and deleted between two snapshots |
| **Restore Table to Snapshot...**      | `aantje.restoreTableToSnapshot` | table                              | A SQL script that gives the table the rows of a snapshot back            |
| **Restore Dropped Object...**         | `aantje.restoreDroppedObject`   | schema                             | A SQL script that creates a dropped table, view or macro again           |

Query at Snapshot, Compare Table at Two Snapshots, Show Changes and Restore Table to Snapshot are in the submenu **Time Travel** (`aantje.timeTravel`, group `2_travel`) of a table; a view has only Query at Snapshot. Compare Snapshots is in the context menu of an open connection, Restore Dropped Object in the one of a schema. A seventh command, **Show Rows Changed** (`aantje.showSnapshotChanges`), is the entry of a change in the Snapshots folder, see [Show Rows Changed](#show-rows-changed).

Two different tables or two schemas, also of two connections, are compared by **Schema Compare...** ([Schema Compare](compare.md)), which also writes a script that aligns them.

## Which snapshots a table has

A table or view exists from its `begin_snapshot` up to, but not including, its `end_snapshot`, over all versions of its row. A rename ends one version and starts the next under the same id. `CatalogReader.lifetime(kind, id)` returns that range. It is `undefined` for an id without a row, also for a dropped table after `expire_snapshots`; the commands then say that the object exists at no snapshot the catalog still has.

`snapshotChoices` in `src/snapshot.ts` turns the snapshots into picker rows. It keeps those inside the lifetime, sorts newest first and marks the snapshot of the tree as picked. The rows look like those of **Show Catalog at Snapshot...**: `@<id>`, the time in UTC, the changes in words and the commit message.

## Query at Snapshot

1. A picker lists the snapshots at which the table or view exists, newest first.
2. A second picker offers **Top 1000 Rows**, **Create Notebook** and **Open as SQL**. Cancelling either picker does nothing.
3. The command runs the code of **Select Top 1000 Rows** and **Create Notebook...** with the chosen snapshot. The grid key and title contain it, so snapshot 5 and snapshot 13 of one table are two panels. The notebook sets `SNAPSHOT = 5` and says "pinned to snapshot 5".

Decisions:

- **The name is the name at the chosen snapshot.** A renamed table has another name then, and the engine knows only that one. `chooseQuery` in `src/time-travel.ts` looks the relation up in `entries(snapshot)` by kind and id.
- **The pickers come before the trust question.** For a view the confirmation of [Data access](data-access.md#views-and-trust) applies, but it is asked after the pickers, because trusting reloads the tree and a cancelled picker should ask nothing.
- **A closed connection** is an error: `The connection is closed. Connect again to query at a snapshot.`
- A node that is not a table or a view, and a call without a node, do nothing.

## Open as SQL

The third choice opens an untitled SQL document with the text of **Script as SELECT** ([DDL generation](ddl.md#the-script-as-submenu)) for the chosen snapshot, and runs nothing:

```sql
-- Time travel to snapshot 5
SELECT
  "id",
  "customer",
  "amount"
FROM "sales"."orders" AT (VERSION => 5)
LIMIT 1000;
```

- Names and columns are those of the chosen snapshot (`selectAtSnapshot` in `src/script.ts`). A view is `SELECT *`, because the catalog has no typed columns for a view; DuckLake runs the view as it was at that snapshot over the tables as they were then.
- The document belongs to the connection of the node, like every script ([SQL editor](sql-editor.md)). F5 runs it there, in a read-only session when the connection is read-only.
- No trust question is asked. The statement only names the relation; the user decides when running it.
- The [Snapshot report](snapshot-report.md) offers the same choice in its **Query** action.

## Compare Table at Two Snapshots

The command compares one table with itself at two snapshots. Its columns match by id, so a renamed column shows as renamed. Two different tables or schemas, which match by name, are the job of **Schema Compare...** ([Schema Compare](compare.md)).

The command asks for snapshot A, then for snapshot B, both from the snapshots at which the table exists. A starts at the snapshot of the tree, B at the newest other one, and B never offers A again. The older of the two is the left side.

- **A diff editor** (`vscode.diff`) over two read-only virtual documents holding `createTableDdl` of the columns at that snapshot, with the table named as it is then, so a rename shows in the first line. The title is `<schema.table>: @A ↔ @B`. The editor opens only when the two texts differ; a changed comment is not part of the DDL.
- **One information message** with the counts of `diffColumns` (added, removed, renamed, changed type, nullability, default or comment, moved, and whether the table was renamed). Nested fields count as columns.

```text
2 columns added, 1 renamed, 1 type changed between @26 and @34
No schema changes between @36 and @56
```

The documents use the scheme `aantje-schema`, served by `SchemaDocuments` in `src/compare.vscode.ts`. The address holds ids only (`/<table id>@<snapshot>.sql`, query = connection id), never names; Schema Compare adds `.full` before `.sql`, because its documents hold the partitioning, the sort order and the comments too. A document holds DDL and no connection details.

## Compare Snapshots

The command asks for A and B among all snapshots and opens an untitled Markdown document with a progress notification while it reads. The report lists:

- tables and views that were added, dropped or renamed (`diffEntries`), at most 100 per section;
- the column changes (`diffColumns`) of tables that exist at both snapshots, matched by table id, so a renamed table is compared with itself. At most 200 tables are compared (four at a time, each at both snapshots) and 50 changes per table are listed. Every cut says how many entries it left out.

Every name, type and default is inline code, so a hostile name cannot become a heading, link, list or table cell.

```text
# Lake: @30 to @35

## Tables and views

### Renamed (1)

- table `main.evolving` is now `main.evolved`

## Columns

### `main.evolved`

- added `flag` (`boolean`)
- removed `extra` (`float64`)
```

## Show Changes

**Show Changes...** shows the rows a table gained, lost or changed between two snapshots in the grid ([Data grid](grid.md)). The rows come from DuckLake's `table_changes` ([Data access](data-access.md#changes-between-snapshots)). Only tables have a change feed, so views do not get the entry.

1. The first picker asks for snapshot A, the one to compare against. It lists the snapshots at which the table exists and the one before the first of them, so the rows of the creating snapshot can be shown. The newest snapshot is not offered.
2. The second picker asks for snapshot B, the last one to include. It lists only snapshots after A.
3. The grid opens with the changes made after A up to and including B. What A itself changed is not part of the result; the range starts at the first snapshot after A that still exists.

The grid draws inserts, deletes and the two rows of an update differently and marks the cells an update changed ([Data grid](grid.md#the-changes-of-a-table)). A summary line counts the changes over all rows of the range, with an update as one change:

```text
shop.customers changes @15 → @18 · Lake
4 inserted, 1 updated, 1 deleted (6 changes) after @15 until @18 · @16 +4 · @17 ~1 · @18 −1
```

The summary names the first eight snapshots that changed rows and counts the rest. A cut grid adds `showing the first 1000 of 1523 rows`.

Decisions:

- **The columns and the name are those at B.** A column added after a change shows NULL (or its default) for it; a column dropped before B does not show.
- **Rows are cut at 1000, counts are not.** A cut never separates an update from its pre-image, so the grid can hold 999 rows. The counts come from a second read of the range. There is no other limit; `aantje.queryTimeoutSeconds` and the **Cancel** button end a slow read.
- **One panel per range.** The key holds table, A and B.
- **The latest snapshot is attached**, because B may be newer than the tree's snapshot.
- **Errors say what is wrong**, for example `Snapshot @99 does not exist in this catalog: it is newer than the latest snapshot or it expired.`
- A closed connection gives `The connection is closed. Connect again to show its changes.` Other nodes do nothing.

### Show Rows Changed

A snapshot of the **Snapshots** folder lists what it changed ([Tree](tree.md#snapshots)). The entry of a changed table has the menu entry **Show Rows Changed**. It opens, without a question, the grid for A = `snapshot - 1` and B = the snapshot, the same panel as **Show Changes** for that range. Entries of other objects and entries that only maintain files (compaction, merging, rewriting, flushing inlined data) have no menu, because they change no rows.

- The table is named as at that snapshot.
- Snapshot `@0` has no predecessor: the command says so and shows nothing.
- A table that does not exist at the snapshot (it was dropped there) gets a message and reads nothing.

The [Snapshot report](snapshot-report.md) starts the same commands from its chart. [Schema History](schema-history.md) starts Compare Table at Two Snapshots and Query at Snapshot from a matrix cell. [Activity](activity-report.md) starts Compare Snapshots and Show Rows Changed through the plans and port of the Snapshot report.

## Restore Table to Snapshot

**Restore Table to Snapshot...** writes the script that gives a table the rows of an earlier snapshot back. It opens a new, unsaved SQL document bound to the connection of the node, like every script ([SQL editor](sql-editor.md)). Nothing runs: read the script and run it (**F5**) in a read/write session.

1. A picker lists the snapshots at which the table existed, as in Query at Snapshot, newest first. The description holds the time and the author, the detail the commit message and the changes. The newest snapshot of the catalog is not offered: the table already has its rows. A pinned tree preselects its snapshot.
2. The script opens. Cancelling the picker does nothing.

```sql
-- Restores "sales"."orders" to snapshot 42 (2026-11-10 08:12:00 UTC). Nothing has run: read the statements and run them in a read/write SQL session.
-- Rows inserted, changed or deleted since then are replaced. The snapshots in between stay readable.
-- The table keeps its id, so its History, Schema History and Show Changes go on across the restore.

BEGIN TRANSACTION;
-- Warning: this deletes every row of the table; the INSERT below writes the rows of snapshot 42.
DELETE FROM "sales"."orders";
INSERT INTO "sales"."orders" ("id", "customer", "amount")
SELECT "id", "customer", "amount" FROM "sales"."orders" AT (VERSION => 42);
COMMIT;
```

Decisions:

- **The table keeps its id.** `DELETE` and `INSERT ... AT (VERSION => n)` in one transaction keep it, so History, Schema History and Show Changes go on across the restore. `CREATE OR REPLACE TABLE ... AS` would give the table a new id.
- **The statements act on the newest state.** The table is named as it is now; the `FROM` names it as it was at the snapshot, because `AT (VERSION => n)` resolves the name at that snapshot. When the tree shows a chosen snapshot, a comment says so.
- **A table that was dropped since** gets a hint to use Restore Dropped Object instead, and no script.
- **The rows of the snapshot come from DuckLake**, also rows that were inlined in the catalog then.

### When the structure changed

The script restores the data only. The columns match by their column id, as in Compare Table at Two Snapshots:

- A renamed column is restored too: the `SELECT` reads it under its old name, `"customer" AS "client"`.
- A column added since then is left out of both lists and gets its default. A comment names it, and one more the columns that are `NOT NULL` without a default, for which the `INSERT` fails.
- A column that the snapshot has and the table no longer has stands commented at the end of both column lists.
- A type that changed is cast by the `INSERT`. A value that does not cast fails the run, and the transaction rolls back. A comment names the columns.
- A struct casts by field name. When a field was renamed, a warning says that its values come back empty, and that the `INSERT` fails when no field name matches.
- When the partitioning or the sort order changed, the rows are written with the layout of today, and a comment says so.

Above the transaction stand the steps that would restore the structure, all commented out. They are Script as Update ([Schema Compare](compare.md#script-as-update)) with the table at the snapshot as the source and the table now as the target, its columns named as today: re-add a column, change a type back, `NOT NULL` and defaults, partitioning, sort order, drop a column added since, and the comments. Each step that can lose data has a warning, also a type change back: DuckLake changes a type only to a wider one, so that step stays a comment under its note as well. Running the steps and removing the `-- ` in front of the commented columns brings the values of a dropped column back too.

The renames come last, after `COMMIT`, also as comments: the `INSERT` names the columns as they are now. Running them gives the columns their old names again.

```sql
-- The structure changed since snapshot 5: this script restores the data only.
-- The steps below are Script as Update with the table at snapshot 5 as the source. To restore the structure as well, run them first (remove the "-- " in front of them), then remove the "-- " in front of the columns that they add back, in both column lists of the INSERT.
-- ALTER TABLE "sales"."orders" ADD COLUMN "note" VARCHAR;
-- Warning: this drops a column and the data in it.
-- ALTER TABLE "sales"."orders" DROP COLUMN "region";

BEGIN TRANSACTION;
-- Warning: this deletes every row of the table; the INSERT below writes the rows of snapshot 5.
DELETE FROM "sales"."orders";
INSERT INTO "sales"."orders" (
  "id",
  "client",
  "amount"
  -- , "note"
)
SELECT
  "id",
  "customer" AS "client",
  "amount"
  -- , "note"
FROM "sales"."orders" AT (VERSION => 5);
COMMIT;

-- To give the columns their names of snapshot 5 again, run these after the restore:
-- ALTER TABLE "sales"."orders" RENAME COLUMN "client" TO "customer";
```

## Restore Dropped Object

**Restore Dropped Object...** is in the context menu of a schema. It writes the script that creates a dropped table, view or macro of the schema again. The script opens unsaved and bound to the connection; nothing runs.

1. A picker lists the tables, views and macros that were dropped from the schema and can still be read: the newest snapshot at which they existed has not expired (`droppedObjects` of the [Catalog reader](catalog-reader.md)). The label is the name, the description the kind and `dropped <time> · snapshot <n>`, newest drop first. A name dropped twice gives two entries. Without any, a message says so.
2. The script reads the object at snapshot `n`, the last one at which it existed.

- **A table** is the DDL of Script as CREATE at that snapshot: columns, defaults, `NOT NULL` and its options. Its partitioning, sort order and comments follow as live statements, then `INSERT INTO ... SELECT ... FROM "<schema>"."<name>" AT (VERSION => n)`. All of it is one transaction. A dropped table reads at a snapshot where it existed, also when a newer table has taken its name.
- **A view** is `CREATE VIEW` with the SQL that the catalog stored and its column names, then its comment. DuckDB checks a view when it is created, so a view over a table that is gone fails, and the transaction rolls back.
- **A macro** is `CREATE MACRO` with every overload. It is not `CREATE OR REPLACE`: a macro of the name that was made meanwhile stays. DuckLake keeps no comment of a macro.
- **A view or macro in another SQL dialect** keeps the SQL as stored, as in Generate Scripts, under a comment that says so.
- **The name is taken now:** the script creates `<name>_restored` (`_restored_2` and so on) and says so in a comment. Tables and views share their names; a scalar and a table macro do not.
- **The object comes back with a new id.** Its History before the drop is not joined to it, and a comment says so. The dropped object stays dropped, so the picker still offers it.

```sql
-- Restores the table "sales"."tmp", dropped at snapshot 20 (2026-11-13 08:12:45 UTC), with its rows of snapshot 19. Nothing has run: read the statements and run them in a read/write SQL session.
-- The name is taken now, so this creates "sales"."tmp_restored"; rename it once you have checked it.
-- It comes back with a new id: its History before the drop is not joined to it.

BEGIN TRANSACTION;
CREATE TABLE "sales"."tmp_restored" (
  "id" INTEGER,
  "kind" VARCHAR
);
ALTER TABLE "sales"."tmp_restored" SET PARTITIONED BY ("kind");
-- The sort expressions come from the catalog: read them before running.
ALTER TABLE "sales"."tmp_restored" SET SORTED BY (id DESC NULLS LAST);
COMMENT ON TABLE "sales"."tmp_restored" IS 'Scratch';
INSERT INTO "sales"."tmp_restored" ("id", "kind")
SELECT "id", "kind" FROM "sales"."tmp" AT (VERSION => 19);
COMMIT;
```

```sql
-- Restores the view "sales"."big", dropped at snapshot 21 (2026-11-13 08:12:45 UTC), as it was at snapshot 20. Nothing has run: read the statements and run them in a read/write SQL session.
-- It comes back with a new id: its History before the drop is not joined to it.

BEGIN TRANSACTION;
CREATE VIEW "sales"."big" AS SELECT * FROM sales.orders WHERE (amount > 10);
COMMENT ON VIEW "sales"."big" IS 'Big orders';
COMMIT;
```

A dropped schema is not restored.

### Safety of the restore scripts

- Every name is quoted, and every text value is a string literal.
- A comment line holds fixed text or a name in its quoted form on one line (`commentName`). A commented column or step with a line break in a name is commented on every line.
- A step that can lose data has a warning above it: the `DELETE` of the rows of today, and the commented steps that drop a column or change a type.
- A statement that copies catalog text (the SQL of a view or macro, a type, a default, a sort expression) goes through the check of Script as Update: with `;`, `--` or `/*` in it, or when DuckDB's tokenizer finds that the text leaves a string, a quoted name or a comment open, it is commented out under a note. A statement that needs it, such as the comment of a view or the `INSERT` of a table, is commented out too. The tokenizer only reads; nothing is attached.
- Each restore is one transaction. Nothing runs before the user runs the document.

### What DuckDB 2.0 does

Checked with DuckDB 2.0.0 and its ducklake extension; `test/unit/restore-lake.test.ts` runs the scripts on a lake with SQLite metadata.

- `DELETE` and `INSERT ... AT (VERSION => n)` in one transaction keep the table id and give exactly the rows of the snapshot, inlined rows included.
- `AT (VERSION => n)` resolves the name at that snapshot: a renamed table needs its old name, and a name that a newer table took over reads the old table.
- A dropped table reads with `AT (VERSION => n)` at a snapshot where it existed.
- `CREATE TABLE`, `SET PARTITIONED BY`, `SET SORTED BY`, `COMMENT ON` and the `INSERT` run in one transaction.
- `ducklake_expire_snapshots` removes the snapshots and the rows of objects that no snapshot left can see. A snapshot that is left stays readable. The files of a dropped table are scheduled for deletion only when its last snapshot expires, so `ducklake_cleanup_old_files` keeps them while it can still be restored. The pickers offer only snapshots that are left.
- A script that reads a snapshot that expired, or whose files are gone, fails with the error of DuckLake in the results, and the transaction rolls back.
- DuckLake changes a column type only to a wider one, so a type change back is refused. `COMMENT ON MACRO` is not supported.
- A struct casts to another struct by field name; with no field name in common the cast fails.

## Known limits

- The lists hold the snapshots the catalog still has. After `expire_snapshots` a dropped table may have none.
- Comparisons read the catalog at both snapshots. Row counts and data are not compared.
- A change of the SQL of a view is not reported, only adding, dropping and renaming.
- The restore scripts bring back a table, view or macro, not a dropped schema. A restored table gets the layout of today for its rows, and a dropped object comes back with a new id.
- Compare Snapshots compares up to 200 tables.
- The changes of a table show at most 1000 rows, without paging, sorting or filter.
- A range that starts before the table was created, or spans a rename, works, but the grid names the table as at the end. The end must be an existing snapshot. A start whose successor expired moves to the first later snapshot that exists. Rows of a snapshot that expired inside the range are still listed under it.
