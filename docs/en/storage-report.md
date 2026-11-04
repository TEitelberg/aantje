# Storage report

**Storage Report** (`aantje.showStorage`) opens a panel for a lake: where its files are, how much there is, which tables hold the most, which tables consist of many small files, how the lake grew over its snapshots and what waits for the cleanup of old files. It is a report on the [report shell](reports.md); its **Open as Markdown** gives the lake's document.

## Opening the report

- **Where.** The **Reports** submenu of an open connection (see [Reports](reports.md)), and as **Storage Report** in the [Properties](reports.md#the-properties-report) panel. The command needs a node, so it is hidden from the Command Palette.
- **Which snapshot.** The one the tree shows (pinned or latest) when the report is read. **Refresh** reads again at the snapshot the tree shows then.
- **One panel per connection**, titled `Storage · <connection>`. The command again reveals it with fresh data.
- **Progress with Cancel.** `Reading the storage of "Lake"...` with a Cancel button. Cancelling stops the statements the engine can stop (PostgreSQL, DuckDB) and ends with `The query was cancelled.`; no panel opens.
- **Closed connection.** `Connect to a catalog first to show its storage.` After the connection was removed, a refresh says `The connection of this storage report was removed. Close the report.`

## For one schema

**Storage Report** in the Reports submenu of a schema (`ReportScope` in `src/shell/scope.ts`, [Reports](reports.md#reports-for-one-schema)) opens `Storage · <connection> · schema <schema>` and `# Storage of <connection> · schema <schema>`. Tables, rows, small files, the data and delete file totals and the growth chart are those of the schema's tables: `storage(snapshot, { schemaId })` sums the files of its tables, `lakeGrowth(snapshot, limit, signal, { schemaId })` adds up their file changes (a snapshot is a compaction when it merged one of them), and only the tables of the schema are read. The data path, the encryption and the files scheduled for deletion are the lake's; their cards and rows say `(lake-wide)`. **Clean Up Old Files** and **Expire Snapshots** open the lake's scripts. The share of a table is its share of the schema.

## What the report shows

The header has **Clean Up Old Files**, **Expire Snapshots**, **Properties**, **Refresh** and **Open as Markdown**.

| Tab          | Content                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** | Seven key figures and **Files scheduled for deletion**.                                                                                                       |
| **Tables**   | A bar chart of the largest tables and a filterable, sortable list of all tables. Select a table by its bar or name to see its figures and actions.            |
| **Growth**   | A line chart of size and file count of the whole lake after each snapshot that added or removed files, compactions marked, and the last 20 points as a table. |

The key figures are the data path (`not set` without one), whether the catalog is encrypted, the shown snapshot, data files and delete files (count and bytes), the rows of all tables (`~` when any table's count is approximate) and the files scheduled for deletion. Rows kept inline in the catalog are not counted.

### Files scheduled for deletion

Expiring snapshots and compacting do not delete the files that become unnecessary. DuckLake lists them in `ducklake_files_scheduled_for_deletion` and deletes them when Clean Up Old Files runs. The report shows how many wait, split into the files that Clean Up Old Files deletes now and those that are too young (`5 files scheduled: 3 files ready to delete now, 2 files waiting until 2026-11-03 10:00:00 UTC.`; the date is when the oldest waiting file reaches the age), since when the oldest waits and for how long (`The oldest has waited since 2026-10-30 08:00:00 UTC (3 days).`), counted to the time of the read. The age is the option `delete_older_than` of the lake, or 2 days, which DuckLake uses when the option is not set. When no file is old enough, the report says so and that the script needs `cleanup_all => true` or a later `older_than` to delete them now. The figure card shows `n ready now, m waiting`. Without a readable age (months, years) only the count is shown. Past 7 days the key figure is a warning (border, sign and words). The threshold is `CLEANUP_OVERDUE_DAYS` in `src/catalog/thresholds.ts`, which the health check uses too. The catalog has no size for these files.

### Snapshots to expire

Next to the scheduled files the report says how many snapshots Expire Snapshots takes now and how many are younger (`100 snapshots expirable now, 20 younger than 30 days (the default of aantje; the lake sets no expire_older_than)`). The age is the option `expire_older_than` of the lake. DuckLake has no default: a call without `older_than` expires nothing while the option is not set, so the script of Expire Snapshots names an age of 30 days then (see [Maintenance scripts](maintenance.md#expire-snapshots-and-delete-orphaned-files-which-age-the-script-uses)), and the report counts with that age and says so. The newest snapshot is never counted. The key figure card reads `n` with `m younger than 30 days`; the Markdown has a row. Without a readable age (months, years) nothing is shown. The count comes from the catalog table `ducklake_snapshot`, read together with the options like the scheduled files.

### Tables

- **The chart** has a bar for each of the 30 largest tables by data and delete file size, largest on top, and one bar `N more tables` for the rest. A table with many small files has a warning-coloured bar and a label ending in ⚠. The selected table has the second series colour. A click selects.
- **The list** shows `schema.table`, files, size, share of the lake's size, rows (`~` when approximate) and small files. The filter box matches `schema.table` regardless of case. The headings sort (a button with `aria-sort`; again reverses; ties by name) and the focus stays on the heading. A table name is a button (`aria-pressed`) that selects it. The list shows the first 200 matches and says `200 of 250 tables are shown. Type in the filter box to find the others.`
- **Many small files.** The cell reads `5 of 9 (55.6 %)`, with `⚠ many small files` when the table has at least 5 data files and at least half below 16 MiB (`SMALL_FILES` in `src/catalog/thresholds.ts`, the [statistics report](statistics.md) rule). Words and sign carry the message, not colour. Counts come from `smallFiles(snapshot)` at the shown snapshot.
- **The selection** shows the table's figures and four buttons: **Show Statistics**, **Show in Tree**, **Merge Adjacent Files**, **Rewrite Data Files**.

### Growth

The chart draws the state after each snapshot that added or removed files, summed over all tables (`lakeGrowth` of the reader): size and file count as step lines, a compaction as a diamond. It is the statistics report's chart fed with the whole lake. The list below is the keyboard and screen reader alternative: the last 20 points, newest first, with snapshot, time (`time unknown (snapshot expired)`), size, files and `Compaction`. A snapshot is a compaction when its `changes_made` has a `merge_adjacent` entry, not when a table name only looks like one. More than 500 snapshots are merged into at most 500 points, each the state after the last snapshot of its run; the page says so.

## Actions

The page sends an action id and, for a table, its catalog id; never a command or text. The extension checks the request against the report guard (exactly these fields) and then against the data it sent; a table not in the data is ignored (`planStorageAction` in `src/storage-report/actions.ts`). Nothing runs on the lake; scripts open as documents.

| Action id        | Field   | What it does                                                                                                     |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| `showStatistics` | `table` | Opens the [statistics report](statistics.md) at the report's snapshot, also when the tree shows another one now. |
| `revealTable`    | `table` | Selects the table in the tree; says so when the tree's snapshot has no such table.                               |
| `scriptMerge`    | `table` | Opens the Merge Adjacent Files script of the table in an untitled SQL document of the connection.                |
| `scriptRewrite`  | `table` | The same for Rewrite Data Files.                                                                                 |
| `scriptCleanup`  |         | Opens the Clean Up Old Files script of the lake; dry run active, real call commented out.                        |
| `scriptExpire`   |         | The same for Expire Snapshots.                                                                                   |
| `showProperties` |         | Opens the [Properties](reports.md#the-properties-report) panel of the connection.                                |

The scripts are those of the Maintenance menu (`maintenanceOf` in `src/maintenance.ts`, see [Maintenance](maintenance.md)). The document belongs to the connection, so F5 runs it there; opening never runs it.

## Open as Markdown

The header button opens an untitled document built from the panel's data with the filter typed in the filter box (`storageMarkdown` in `src/storage-report/markdown.ts`; the page sends only `{ filter }`). Sections:

- `# Storage of Lake` with a Property / Value table: data path, encryption, snapshot, data files, delete files, rows and the scheduled files (ready and waiting). A sentence says so when the oldest has waited over 7 days.
- `## Largest tables`: `Table | Files | Size | Rows`, largest first, matching the filter, at most 50 rows, then `… 10 more omitted (limit: 50).` A lake with more tables than the report holds (1000) says `n smaller tables are not part of this report (limit: 1,000).`
- `## Tables with many small files` (when any match): `Table | Files | Small files`.
- `## Growth`: a summary and the last 20 points, then `… n more omitted (limit: 20).`

Catalog text goes through `code()` of `src/markdown.ts`, the connection name through `markdownText`.

## Reading the data

`readStorage(reader, connection, snapshot, now, signal, scope?)` in `src/storage-report/read.ts` reads in parallel `storage(snapshot)`, the tables of all schemas (four schemas at a time; one for a schema scope), `smallFiles(snapshot)` and `lakeGrowth(snapshot, 500)`. It sums the rows of all tables, keeps the 1000 largest and counts the others (`tableCount`), and stamps `readAt`, to which the age of the scheduled files is counted. The page checks the data with `isStorageMessage` before showing it.

Two [catalog reader](catalog-reader.md) methods serve it:

- `lakeGrowth(snapshot, limit?, signal?, scope?)` returns `{ growth, growthMerged? }`: the growth of the whole lake, or of the tables in `scope`, aggregated by one statement over all data and delete files, at most `limit` points.
- `smallFiles(snapshot, signal?)` returns tables with data files below 16 MiB at the snapshot, with their files and small files, most small files first.

## Modules

| Module                                                                    | Job                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/storage-report/model.ts`                                             | `StorageData`, cards, scheduled files, the small file rule, sorting, filter, bars. |
| `src/storage-report/read.ts`                                              | `readStorage`.                                                                     |
| `src/storage-report/markdown.ts`                                          | `storageMarkdown`.                                                                 |
| `src/storage-report/protocol.ts`, `actions.ts`                            | `isStorageMessage`, `isStorageAction`, `isStorageView`; `planStorageAction`.       |
| `src/storage-report/kind.ts`                                              | The `ReportKind`.                                                                  |
| `src/storage-report/page.ts`, `render.ts`, `chart-options.ts`, `style.ts` | The browser side.                                                                  |
| `src/storage-report/commands.vscode.ts`                                   | `createStorageReport`: panel, read, actions.                                       |
| `src/catalog/thresholds.ts`                                               | `SMALL_FILES`, `CLEANUP_OVERDUE_DAYS`.                                             |

`createStorageReport` is created in `src/extension.ts` before the Properties report, because each offers a button for the other.

## Security

The page loads from `dist` under a nonce CSP (see [Reports](reports.md#the-shell)). Catalog text (names, the data path) is set as text, never as markup, and chart tooltips escape it. A request is `ready`, `refresh`, `markdown` (with exactly `{ filter }`, or none) or one of the seven actions with exactly its fields; anything else is ignored, so the page cannot make the extension run a command, open text it wrote or touch a table it was not sent.

## Known limits

- Small file counts cover data files; delete files have no size class. A table whose files are all above 16 MiB is never called out, however many there are.
- A lake with more than 1000 tables lists the 1000 largest; the rest are counted and shown as one bar.
- Rows are those of the data files; inlined rows are not included.
- **Show in Tree** needs the table in the tree; a tree on an older snapshot may not have it.
- The growth chart follows the history the catalog still holds; after Expire Snapshots the files of dropped tables are gone from it.

## Tests

```text
npx vitest run test/unit/storage- test/contract/lake-growth.contract.test.ts
```

The contract test checks `lakeGrowth` and `smallFiles` on the history fixture (SQLite, DuckDB, PostgreSQL) and edited copies: the points equal the growth of all tables together and the storage totals, and compactions, expired snapshots and the 500 point cap behave. Unit tests cover `readStorage`, the model (7 days, small file rule, filter, sorting), the guards and action plans, the Markdown document and the page bundle against a DOM stand-in. The integration test runs in a real VS Code.
