# Snapshot report

**Snapshot Report** (`aantje.showSnapshotReport`) opens a webview report of the newest snapshots of a catalog: a swimlane chart with one lane per table and one mark for every snapshot that changed the table. It answers "what happened to my lake, and when", and starts the follow-up actions: show the catalog at a snapshot, show the rows a snapshot changed, compare two snapshots, query a table as it was. Everything comes from the `ducklake_*` tables through the read-only drivers of the explorer. Only the actions that read table data use the DuckDB engine, as in the tree. The chart is drawn by [Apache ECharts](https://echarts.apache.org/) (Canvas) with the theme code of the [Statistics report](statistics.md).

## Opening the report

- **Where.** In the **Reports** submenu of the context menu of a connected connection ([Reports](reports.md)). The command is hidden from the Command Palette. The **History** leaf of a table opens [Schema History](schema-history.md), not this report.
- **One panel per connection.** Calling the command again reveals the panel and sends fresh data. The title is `Snapshot Report · Lake`. Data of the same connection keeps the user's choices; another connection starts over.
- **Progress and Cancel.** The read runs under a notification with a Cancel button, which stops the statements the engine can stop (PostgreSQL, DuckDB). A connection that is not open gives a hint to connect first.
- **Refresh** reads the snapshots again and keeps the choices. The report is a picture of the time it was read.
- **Open as Markdown** in the header opens an untitled document of the report as filtered: what was read, the chosen tables, kinds and range, and one row per remaining snapshot, newest first, with time, author, message and tables (`snapshotReportMarkdown`). The list stops at 200 snapshots and counts the rest. The page names the lanes, kinds and range; the extension fits them to its data and builds the text. Catalog text is code formatted.
- **A hidden panel keeps its choices** (tables, kinds, range, axis, selection, second snapshot) with the webview `getState`/`setState`, fitted to the data: lanes and snapshots that are gone are dropped. The axis zoom and scroll position are not kept.
- A removed or closed connection gives a message on Refresh and on every action.

## What the chart shows

- **Lanes.** One lane per table that a snapshot in view changed, busiest first (ties by name). A table keeps its lane across a rename and is labelled with its newest name; a dropped table gets `(dropped)`. The last lane, `Schema / views / macros`, holds changes that belong to no table. At most **30 table lanes** are drawn; a note says how many were left out, and the table filter reaches them.
- **Marks.** One mark per snapshot and table. The shape carries the meaning, the colour repeats it:

| Kind          | Shape    | Colour     | Actions                                                                          |
| ------------- | -------- | ---------- | -------------------------------------------------------------------------------- |
| Insert        | circle   | blue       | `inserted`, `inlined_insert`                                                     |
| Update        | pin      | green      | inserts and deletes of one table in one snapshot (how DuckLake writes an update) |
| Delete        | triangle | purple     | `deleted`, `inlined_delete`                                                      |
| Schema change | diamond  | yellow     | `created`, `dropped`, `altered`, `renamed`, entries aantje does not understand   |
| Maintenance   | square   | foreground | `flushed_inlined`, `compacted`, `merged`, `rewritten`, `expired`                 |

A schema change wins over data in one mark; tooltip and detail pane name both.

- **Transactions.** A snapshot that changed several lanes draws a thin vertical line through them.
- **The x axis** is the order of the snapshots, or with **Time** their real time (gaps show pauses). The zoom bar and the mouse wheel zoom without dropping marks. A change of kinds, range, axis, table filter or theme redraws the chart and resets the zoom; selecting a snapshot does not.
- **Selection** is a solid vertical line; a second snapshot for comparisons is dashed.
- **The tooltip** names the snapshot, its UTC time, author and message, and what it did to each table (the first eight, then a count).

## Reading and selecting

A click on the chart selects the snapshot of the nearest column. **Ctrl-click** (Cmd on a Mac) picks a second snapshot for comparisons; Ctrl-click again or **Clear** releases it.

The **Snapshots** list under the chart shows the same information as a table, newest first. It is the keyboard route, because the chart is a canvas: Tab moves between its buttons, Enter selects, **Ctrl+Enter** picks the second snapshot. It follows the same filters and shares the selection. The **detail pane** shows the selected snapshot: time, author, commit message, the tables with what the snapshot did to each, other changes in words, and the action buttons.

## Filters

- **Tables.** A multi-select grouped by schema. Nothing chosen means all. The lane of other objects is a choice of its own. A dropped table is listed with `(dropped)`.
- **Kinds.** The five kinds of mark can be switched off, maintenance included. A snapshot with only switched-off marks drops out of chart and list.
- **Range.** **From** and **To** limit the snapshots (both included). Lanes, their order and the 30-lane limit are computed for the range.
- **X axis.** **Order** or **Time**.
- **Show latest snapshot** makes the tree follow the newest snapshot again.

A note says when the data is cut: `The 500 newest snapshots are shown. Older ones are not read.`

## Actions

The buttons of the detail pane send an action to the extension, which carries it out with the implementations of the commands of the same name ([Time travel](time-travel.md)) and an explicit target instead of a tree node.

| Button                                  | What happens                                                                                | Offered when                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Show catalog at @N                      | The tree shows the catalog at snapshot N                                                    | always                                                                     |
| Show latest snapshot (toolbar)          | The tree follows the latest snapshot again                                                  | always                                                                     |
| Rows changed                            | The grid of the changes between N-1 and N, as **Show Rows Changed**                         | the snapshot inserted or deleted rows of the table, did not drop it, N > 0 |
| Query...                                | Top 1000 Rows, Create Notebook or Open as SQL for the table at N, under its name then       | the table exists at N                                                      |
| Schema vs previous / latest / @M        | Diff editor over the `CREATE TABLE` at two snapshots and the summary, as **Compare Schema** | the table exists at N and at the other snapshot                            |
| Compare the catalog with previous / ... | The Markdown report of **Compare Snapshots**                                                | the other snapshot exists                                                  |

The other snapshot is `previous` (the next older snapshot that exists, not always N-1; not for the oldest), the latest one (not for itself) or the second snapshot picked with Ctrl-click. The page offers a schema comparison only where the snapshots it read show that the table exists at both. For what they cannot show (a table created before the oldest snapshot read and gone at the other one), the command says that the table does not exist at that snapshot and opens nothing.

## Data and limits

`CatalogReader.snapshotActivity(limit, range, signal)` returns the newest `limit` snapshots with time, author, message and resolved changes, and whether older ones exist ([Catalog reader](catalog-reader.md#snapshot-details-and-changes)). The report asks for 500; 500 snapshots and 30 lanes are limits of the report, not of the reader.

- Only snapshots that still exist are listed. A table that only expired snapshots changed has no lane. An object whose rows expiry removed shows by id (`table #15`).
- Catalogs of specification 1.0 have no author or message. A catalog without macro tables names a macro only as far as the change names it.
- The page holds all 500 snapshots with their changes; a snapshot with thousands of changes makes the message larger.

## Theme and accessibility

Colours come from `--vscode-charts-*` through `readPalette` and `chartTheme` of the statistics report, with the contrast fallback. In high-contrast themes the chart adds patterns (`aria.decal`), outlined larger marks and solid lines. A theme change redraws the chart and keeps the selection. Colour is never the only carrier: shape, legend, tooltip, the `(dropped)` suffix and the list say the same. The chart has one text for assistive technology, and everything it does can be done in the list and the detail pane by keyboard.

## Security

The page uses the policy of the grid and the statistics report (`default-src 'none'`, nonces for style and script, `base-uri 'none'`, `form-action 'none'`), `localResourceRoots` is `dist`, and data arrives by `postMessage` after the page says `ready`.

- Catalog text is put into the page with `textContent`. Tooltips are HTML without `style` attributes and their text goes through `escapeHtml`.
- The page asks for an action by id and numbers only: `ready`, `refresh` or one of the six action ids with exactly the fields it needs (`isSnapshotReportAction`). No command id or free text can be part of it; an extra field is rejected. The extension checks the numbers against the data it sent (`planSnapshotReportAction`): the snapshot, the table and the second snapshot must have been sent, and the detail pane must offer the action. A mismatch is ignored and logged as a warning.
- The page checks what it receives (`isSnapshotReportMessage`) as the extension checks what it sends.
- The page makes no request. Actions that read table data are the tree's, with their own safeguards (view confirmation, S3 credentials).

## Modules

| File                                              | Job                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/catalog/reader/history.ts`                   | `snapshotActivity` (statements in `src/catalog/queries/history.ts`)                                                   |
| `src/guards.ts`                                   | Building blocks of the message guards, shared with the statistics report                                              |
| `src/snapshot-report/model.ts`                    | Lanes, points, transactions, filters, the 30-lane limit, table choices, snapshot detail. Pure.                        |
| `src/snapshot-report/actions.ts`                  | Action ids, compare targets, `planSnapshotReportAction`. Pure.                                                        |
| `src/snapshot-report/protocol.ts`                 | Messages and their guards. Pure.                                                                                      |
| `src/snapshot-report/read.ts`                     | `readSnapshotReport`. No `vscode`.                                                                                    |
| `src/snapshot-report/state.ts`                    | The choices kept for a hidden panel or a refresh. Pure.                                                               |
| `src/snapshot-report/chart-options.ts`            | The ECharts option of the swimlane chart and its tooltip. Pure.                                                       |
| `src/snapshot-report/page.ts`, `render.ts`        | Browser side: state, chart and event wiring; DOM builders for list, detail pane and toolbar                           |
| `src/snapshot-report/style.ts`                    | `SNAPSHOT_REPORT_CSS`                                                                                                 |
| `src/snapshot-report/kind.ts`, `markdown.ts`      | `snapshotReportKind` (view type, stylesheet, guards, `toMarkdown`); `snapshotReportMarkdown`. Pure.                   |
| `src/snapshot-report/execute.ts`                  | `performSnapshotReportAction`: carries out a plan through the `ReportPort` (`src/shell/report-port.ts`). No `vscode`. |
| `src/snapshot-report/commands.vscode.ts`          | The command, progress, panel and the port that maps actions to tree, grid, diff editor and documents                  |
| `src/shell/panels.ts`, `src/shell/host.vscode.ts` | `ReportPanels`: one webview panel per key and the handshake, for every report ([Reports](reports.md))                 |
| `src/shell/charts.ts`                             | The only module that imports ECharts                                                                                  |
| `src/shell/client.ts`                             | The browser entry of all report pages; the first message decides which page is built                                  |

`dist/report-client.js` serves all report pages. A second entry would bundle ECharts again, and the webview policy allows only one nonce script, so the script cannot be split into a shared chunk.

## Tests

Unit tests cover the model, actions, protocol guards, chart options, Markdown, execution with a recording port, and the browser bundle against a DOM and ECharts stand-in. A contract test runs `snapshotActivity` on SQLite, DuckDB and PostgreSQL. An integration test runs the panel and the actions in VS Code. The canvas itself is checked in a real browser by the end-to-end suite.

```text
npx vitest run test/unit/snapshot-report-model.test.ts test/unit/snapshot-report-client.test.ts test/contract/history-reader.contract.test.ts
```

## Known limits

- The report reads the newest 500 snapshots.
- Marks of tables outside the 30 busiest lanes are not drawn until the table filter names them.
- The chart is a canvas: marks cannot be focused. The list is the keyboard route.
- DuckLake has no schema rename, so a table keeps the schema name of its newest version.
