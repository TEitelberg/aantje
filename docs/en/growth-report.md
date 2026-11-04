# Growth report

**Growth** (`aantje.showGrowth`) opens a webview that shows how the amount of data in a lake or in one table grew and shrank over the snapshots: a line chart of the live rows, the data size or the number of data files after every snapshot, key figures, a list of the snapshots with the change of each, and the actions that follow from a snapshot. It answers "when did this table grow, when did it shrink, and by how much". Everything comes from the DuckLake catalog (`ducklake_*` tables) through the read-only drivers of the explorer; the chart is drawn by [Apache ECharts](https://echarts.apache.org/) in the shared report script ([Reports](reports.md)).

## Opening the report

- **Where.** **Growth** is in the **Reports** submenu of a connected connection (the whole lake), of a schema and of a table. The command is hidden from the Command Palette because it needs a node.
- **One panel per connection, schema and table.** Titles: `Growth · Lake`, `Growth · Lake · schema shop` and `Growth of shop.events · Lake`. Opening the same one again reveals the panel with fresh data.
- Opened from a table, the report starts with that table chosen; the **Table** choice still offers **All tables** and every other table.
- **Progress and Cancel.** The history is read under the notification `Reading the growth of "Lake"...` (or `... of shop.events...`) with Cancel. A connection that is not open gives `Connect to a catalog first to show its growth.`

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report reads the same newest 500 snapshots and keeps those that changed the schema, with only their changes to it (`activityOfSchema` in `src/shell/schema-scope.ts`). The tables of the choice are the schema's, with its dropped tables that the snapshots name, and the changes are those of these tables. **All tables** then means all tables of the schema. A snapshot that changed only other schemas is not listed, so the steps are the commits that touched the schema. The title and the Markdown say `schema <schema>`.

## What the report shows

- **Filters.** **Table** (`All tables`, the tables of the newest snapshot and the dropped tables the snapshots name, as `schema.table (dropped)`), **Show** (Live rows, Data size, Data files) and **X axis** (Snapshots, Time).
- **Key figures** for the chosen table and value: the value now, the highest value with its snapshot, the largest increase and largest decrease with their snapshots (`none` where there is none), and the number of snapshots read and how many of them changed the selection.
- **The line chart.** One line with the value after every snapshot, oldest to newest. A circle marks every snapshot that changed the selection; it is hollow where the value is not exact. The x axis is the snapshots (`@N`) or their time. A zoom bar reaches a part of a long history. The tooltip names the snapshot, its time, author and message, the value and its change since the snapshot before. A click on a mark selects the snapshot.
- **The list.** The snapshots, newest first: snapshot, time (UTC), value, change, author, message. It is the keyboard route for the chart, which is a canvas. At most 200 are listed; a note counts the rest, and the chart has all of them.
- **The detail pane** of the selected snapshot: time, author, message, value with change, and the buttons (see Actions).

The chart uses the theme colours (`--vscode-charts-*`) with the contrast fallback of the other reports; in high contrast the marks are larger and outlined. The value is also in the key figures, list and tooltip, so colour is never the only carrier.

## How the values are computed

- **Live rows** are the rows in the data files minus the rows that delete files removed, plus the rows DuckLake keeps inlined in the catalog (`ducklake_inlined_data_*`). The file rule is the one of the row counts in the tree and in Statistics, applied to every snapshot: a data file counts from its `begin_snapshot` to its `end_snapshot`; a delete file takes its deleted rows off until a newer one replaces it or its data file ends. An inlined row counts from its begin to its end snapshot. DuckLake leaves the inlined rows of a dropped table without an end snapshot, so they end with the table.
- **Data size** is the size of the data files plus the visible delete files, as in the [Storage report](storage-report.md). **Data files** is the number of data files.
- **One statement.** The reader asks once for what every snapshot added and removed per table (`growthChanges`, one statement over the file tables and one over the inlined tables, [Catalog reader](catalog-reader.md)); the page adds the changes up in snapshot order. The state after a snapshot is the sum of the changes up to it, so switching table or value reads nothing again.
- **Values marked `~`.** A data file merged from several snapshots, a file written from inlined rows, and a delete file that collects the deletes of several snapshots hold one row count for more than one snapshot (`partial_max`). The rows are then too high or low at the snapshots before the last one it covers; the report marks them `~` in the list and key figures and with a hollow circle, with a note. Sizes and file counts are always those of the files.
- **The change** of a snapshot is its value minus that of the snapshot before; for the oldest snapshot read it is its value minus the state before it.

## The history and its limits

- **The newest 500 snapshots** are read; a note says so. The first value includes everything older snapshots did.
- **Expired snapshots are gone** (`ducklake_expire_snapshots`), so the history starts later or has gaps. What an expired snapshot changed shows at the next snapshot left, and the report says so.
- **Inlined rows** are counted as far as the catalog still has them. After `ducklake_flush_inlined_data` the file counts all its rows from its first snapshot, so snapshots before the last one it covers are `~`. At most 200 inlined tables are read; with more, a note says their rows are not counted. If the statement that reads the inlined rows fails, a note says none are counted and the numbers can be too low.
- **Inlined deletes are not subtracted.** A delete of up to `data_inlining_row_limit` rows is kept in `ducklake_inlined_delete_<table id>`, not in a delete file. Neither the tree nor the report subtracts these until they are written to a delete file; the tables cannot be listed with SQL that runs on SQLite, DuckDB and PostgreSQL.
- The report counts rows from the catalog and never reads a data file; a catalog changed by hand shows what it says.

## Actions

A snapshot button in the list, or a click on a mark, selects a snapshot. The detail pane shows the buttons; the extension carries an action out with the implementation of the command of the same name, with an explicit target.

| Button          | What happens                                                                                                                              | Offered when                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Show catalog at | The tree shows the catalog at the snapshot.                                                                                               | always                              |
| Query at        | Asks what to open (the first rows, a notebook or a SQL document) and opens the table as it was at the snapshot, as **Query at Snapshot**. | one table is chosen, not all tables |

The page asks for an action by its id and numbers; the extension checks the snapshot and table against what it sent (`planGrowthAction`) and ignores and logs what does not match. A table that did not exist at the snapshot gives the message of the [Snapshot report](snapshot-report.md) instead of an empty result. A closed connection gives `The connection is closed. Connect again to ...`.

## Open as Markdown

**Open as Markdown** opens an untitled document for the chosen table and value: the properties, a notice for older, expired or inexact snapshots, a summary (first and last value, highest value, largest increase and decrease) and a table of the snapshots, newest first, with time, value, change, whether the snapshot changed the selection, author and message. `growthMarkdown` (`src/growth/markdown.ts`) builds it from the data and the view the page names; a table not in the data becomes all tables. Catalog text is code. The list stops at 200 (`… n more omitted (limit: m).`).

## Data and limits

`readGrowth` (`src/growth/read.ts`) reads the newest 500 snapshots with their changes (`snapshotActivity`, [Catalog reader](catalog-reader.md#snapshot-details-and-changes)), the tables of the newest snapshot and `growthChanges` from the oldest snapshot read on (the changes of earlier snapshots come as one entry per table). A lake with many tables that change in every snapshot sends correspondingly more.

- **500 snapshots**, **200 inlined tables**, **200 rows** in the list.
- The tables of the choice are those of the newest snapshot and the dropped ones the snapshots name; a dropped table no snapshot names is only part of **All tables**.
- Times are UTC, as stored.

## Security

The page uses the shared policy (`default-src 'none'`, nonce for script and style), `localResourceRoots` is `dist`, and data arrives by `postMessage` after `ready` ([Reports](reports.md#the-shell)).

- Catalog text (table names, authors, messages, the connection name) goes into the page with `textContent`; the chart tooltip is HTML without `style` attributes and its text goes through `escapeHtml`.
- A request is `ready`, `refresh`, `markdown` with a view of the right shape, or one of the two action ids with exactly the snapshot and table it needs; a command id or free text cannot be part of it. The page checks what it is sent (`isGrowthMessage`) as the extension checks what comes out of it.
- The page makes no request; the extension reads only catalog tables, read-only.

## Modules

| File                                                | Job                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/growth/model.ts`                               | `GrowthData`, `seriesOf`, `summarizeGrowth`, key figures, notes, table choices. Pure.            |
| `src/growth/actions.ts`                             | Action ids and `planGrowthAction`. Pure.                                                         |
| `src/growth/protocol.ts`                            | Messages and guards (`isGrowthAction`, `isGrowthView`, `isGrowthMessage`). Pure.                 |
| `src/growth/state.ts`                               | The choices the page keeps for a hidden panel or a refresh. Pure.                                |
| `src/growth/chart-options.ts`                       | The ECharts option of the line chart. Pure.                                                      |
| `src/growth/markdown.ts`                            | `growthMarkdown`. Pure.                                                                          |
| `src/growth/kind.ts`, `style.ts`                    | `growthKind`: view type, stylesheet, messages, guards, `toMarkdown`.                             |
| `src/growth/page.ts`, `render.ts`                   | The browser side: state and events; DOM builders for chart pane, list, detail pane and filters.  |
| `src/growth/read.ts`                                | `readGrowth`. Without `vscode`.                                                                  |
| `src/growth/commands.vscode.ts`                     | `registerGrowthCommand`: command, progress, one panel per connection and table, the action port. |
| `src/catalog/queries/growth.ts`, `reader/growth.ts` | `growthChanges`, `inlinedGrowthChanges` and `CatalogReader.growthChanges`.                       |

## Testing

```bash
npx vitest run test/unit/growth-model.test.ts test/unit/growth-client.test.ts test/contract/growth-changes.contract.test.ts
```

The contract test checks on SQLite, DuckDB and PostgreSQL that the changes add up to what the tree reads at every snapshot. `growth-lake.test.ts` writes lakes with the real DuckDB and compares the rows with `count(*) AT (VERSION => n)` at every snapshot (flush, merge, expiry, inlined rows). Further unit tests cover the model, the action plan, the guards, the Markdown, the chart options and the real browser bundle against a DOM stand-in; `test/integration/growth-report.test.ts` and the end-to-end spec `test/e2e/specs/growth.mjs` run it in a real VS Code and browser. The canvas itself is only checked in the browser.

## Known limits

- Older than the newest 500 snapshots are not reached; their changes are summed into the first value.
- Inlined deletes are not subtracted; values before a flush or a merge carry `~`.
- The chart is a line from snapshot to snapshot, not a step chart, and has no bars for the change per snapshot (the list has it).
- **Table** takes one table or all tables, not several.
- The chart is a canvas: its marks cannot be focused. The list is the keyboard route.
