# Time travel: Query at Snapshot, the comparisons and the changes

The tree shows the whole catalog at one snapshot ([Snapshots, search and status bar](snapshot-search-status.md)). Four commands work with snapshots that the tree does not show. They need a node, so the Command Palette hides them.

| Command                  | Id                        | Node                               | Result                                                                   |
| ------------------------ | ------------------------- | ---------------------------------- | ------------------------------------------------------------------------ |
| **Query at Snapshot...** | `aantje.queryAtSnapshot`  | table, view                        | A grid, a notebook or a SQL editor at a snapshot you choose              |
| **Compare Schema...**    | `aantje.compareSchema`    | table                              | A diff editor over the `CREATE TABLE` of two snapshots, and a summary    |
| **Compare Snapshots...** | `aantje.compareSnapshots` | connection (only while it is open) | A Markdown report of the tables, views and columns that differ           |
| **Show Changes...**      | `aantje.showChanges`      | table                              | A grid with the rows inserted, updated and deleted between two snapshots |

Query at Snapshot, Compare Schema and Show Changes are in the submenu **Time Travel** (`aantje.timeTravel`, group `2_travel`) of a table; a view has only Query at Snapshot. Compare Snapshots is in the context menu of an open connection. A fifth command, **Show Rows Changed** (`aantje.showSnapshotChanges`), is the entry of a change in the Snapshots folder, see [Show Rows Changed](#show-rows-changed).

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

## Compare Schema

The command asks for snapshot A, then for snapshot B, both from the snapshots at which the table exists. A starts at the snapshot of the tree, B at the newest other one, and B never offers A again. The older of the two is the left side.

- **A diff editor** (`vscode.diff`) over two read-only virtual documents holding `createTableDdl` of the columns at that snapshot, with the table named as it is then, so a rename shows in the first line. The title is `<schema.table>: @A ↔ @B`. The editor opens only when the two texts differ; a changed comment is not part of the DDL.
- **One information message** with the counts of `diffColumns` (added, removed, renamed, changed type, nullability, default or comment, moved, and whether the table was renamed). Nested fields count as columns.

```text
2 columns added, 1 renamed, 1 type changed between @26 and @34
No schema changes between @36 and @56
```

The documents use the scheme `aantje-schema`, served by `SchemaDocuments` in `src/compare.vscode.ts`. The address holds ids only (`/<table id>@<snapshot>.sql`, query = connection id), never names. A document holds DDL and no connection details.

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

The [Snapshot report](snapshot-report.md) starts the same commands from its chart. [Schema History](schema-history.md) starts Compare Schema and Query at Snapshot from a matrix cell. [Activity](activity-report.md) starts Compare Snapshots and Show Rows Changed through the plans and port of the Snapshot report.

## Known limits

- The lists hold the snapshots the catalog still has. After `expire_snapshots` a dropped table may have none.
- Comparisons read the catalog at both snapshots. Row counts and data are not compared.
- A change of the SQL of a view is not reported, only adding, dropping and renaming.
- Compare Snapshots compares up to 200 tables.
- The changes of a table show at most 1000 rows, without paging, sorting or filter.
- A range that starts before the table was created, or spans a rename, works, but the grid names the table as at the end. The end must be an existing snapshot. A start whose successor expired moves to the first later snapshot that exists. Rows of a snapshot that expired inside the range are still listed under it.
