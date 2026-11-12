# Activity report

**Activity** (`aantje.showActivity`) opens a webview that shows the newest snapshots of a catalog: who committed, when, and what. It shows commits per day, changes by kind, the authors with their latest message, the most changed tables, and a list of the snapshots with author, commit message and the tables they changed. It answers "who has been working on this lake, and where", and starts the actions that follow: open the Snapshot report, show the catalog at a snapshot, show the rows a snapshot changed, compare two snapshots. Everything comes from the DuckLake catalog through the explorer's read-only drivers; the charts are drawn by [Apache ECharts](https://echarts.apache.org/) in the shared report script ([Reports](reports.md)).

## Opening the report

- **Where.** In the **Reports** submenu of a connected connection and of a schema. The command is hidden from the Command Palette because it needs a node.
- **One panel per connection and scope**, titled `Activity · Lake` or `Activity · Lake · schema shop`. Opening it again reveals the panel with fresh data.
- **Progress and Cancel.** The snapshots are read under `Reading the activity of "Lake"...` with Cancel. A connection that is not open gives `Connect to a catalog first to show its activity.`
- **Refresh.** The report is a picture of the time it was read. **Refresh** reads the snapshots again and keeps the choices; an end of the range that sat at the oldest or newest snapshot stays there, an end the user moved is kept.
- **A hidden panel keeps its choices** (`getState`/`setState`), fitted to the data when the page is rebuilt (an author or table that is gone is dropped).
- A removed connection gives `The connection of this activity report was removed. Close the report.`; a closed one `The connection is closed. Connect again to use the activity report.`

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report lists the snapshots that changed the schema (the schema itself, or a table, view or macro in it) among the newest 500 of the lake, each with only its changes to the schema (`activityOfSchema` in `src/shell/schema-scope.ts`). Commits, authors, days and tables are counted from these. The note about older snapshots is the lake's: the 500 are the newest of the lake, not of the schema. The Markdown title reads `# Activity of <connection> · schema <schema>`.

## What the report shows

- **Key figures:** the snapshots in view (`of 57 read`), the authors, the tables the snapshots changed, the days with commits, the time of the latest commit.
- **Commits per day.** A bar per day (UTC) with a commit; days without one are not drawn. **Show the days as a table** lists the same numbers.
- **Changes by kind.** Each day's changes stacked by kind: insert, update, delete, schema change, maintenance. The classification is the [Snapshot report](snapshot-report.md)'s: a schema change wins over data in one table and snapshot, insert and delete together are an update. A snapshot that changed two tables counts as one commit and two changes.
- **Authors.** Commits per author with first and latest commit and the latest message, most commits first; at most 50 are listed.
- **Most changed tables.** A bar chart of the 20 tables with the most changes (a table keeps its bar across a rename and shows its newest name; a dropped table says `(dropped)`) and a table with the changes by kind. A click on a bar or table name filters the whole report to that table.
- **Snapshots.** The snapshots the filters leave, newest first: snapshot, time, author, message, changed tables. At most 200 are listed; a note counts the rest. The buttons, tables and list are the keyboard route for the charts, which are canvases.

Charts use the theme colours (`--vscode-charts-*`) with the contrast fallback of the other reports; in high contrast the bars get patterns. Kinds are named in the legend and tables, so colour is never the only carrier.

## Catalogs without authors

Most writers set no author and no commit message. Their snapshots show as **(no author)**, and the report says why in a note, not an error: a writer records them with `set_commit_message` inside the transaction that writes (a call outside a transaction sets nothing), using the name the lake is attached as:

```sql
BEGIN; CALL ducklake_set_commit_message('lake', 'me', 'Nightly import'); INSERT INTO ...; COMMIT;
```

A catalog of specification 1.0 has no commit columns at all, so every snapshot has no author. The note disappears when no snapshot in view lacks an author.

## Filters

All parts of the report follow the same filters.

- **Author:** the authors in the data, with **(no author)**.
- **Table:** a snapshot needs a change on that table, and only that table's changes are counted.
- **Message:** finds text in the commit message, ignoring case. Snapshots without a message do not match.
- **Kinds:** switches the five kinds on and off. A snapshot needs a change of a kind that is on, and only those are counted. A snapshot with no recorded change stays while nothing narrows kinds or table.
- **From / To:** limit the snapshots to the ids between two values (inclusive, inside the snapshots read).

## Actions

A snapshot button selects a snapshot. The detail pane shows its time, author, message, the tables with what it did to each, and the buttons. The extension carries an action out with the implementation of the command of the same name, with an explicit target.

| Button                        | What happens                                                                                                                       | Offered when                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Show catalog at @N            | The tree shows the catalog at snapshot N.                                                                                          | always                                                                     |
| Show Snapshot Report          | Opens the [Snapshot report](snapshot-report.md) of the connection.                                                                 | always                                                                     |
| Compare the catalog with ...  | The Markdown report of **Compare Snapshots** between N and the snapshot before it (`previous @P`) or the newest one (`latest @L`). | the other snapshot exists                                                  |
| Rows changed (for each table) | The grid of the changes of the table between snapshot N-1 and N, as **Show Rows Changed** in the tree.                             | the snapshot inserted or deleted rows of the table, did not drop it, N > 0 |

Which action the data offers is decided by the snapshot report (`planSnapshotReportAction`, `src/snapshot-report/actions.ts`), so the two panels cannot disagree.

## Open as Markdown

**Open as Markdown** opens an untitled document of the report as it is: the filters as text, the hint for missing authors, the commits per day, the authors, the most changed tables and the snapshots with their tables. `activityMarkdown` (`src/activity/markdown.ts`) builds it from the data and the view the page names; the extension fits the view to the data. Catalog text is code. The tables stop at 100 days, 50 authors, 20 tables and 200 snapshots (`… n more omitted (limit: m).`).

## Data and limits

`CatalogReader.snapshotActivity(500)` returns the newest 500 snapshots with time, author, message and resolved changes, and whether older ones exist; the report adds the newest snapshot of the catalog. It runs one statement for the snapshots and at most two per kind of object, not one per snapshot. The Snapshot report's model (`buildModel`) classifies the changes; this report counts them.

- **500 snapshots.** Older ones are not read, and a note says so. Filters work on what was read. The page holds all 500 with their changes.
- **Days are UTC days** of the commit time.
- **Expired snapshots** are not listed and their commits are not counted.

## Security

The page uses the shared policy (`default-src 'none'`, nonce for script and style), `localResourceRoots` is `dist`, and data arrives by `postMessage` after `ready` ([Reports](reports.md#the-shell)).

- Catalog text goes into the page with `textContent`; chart tooltips are HTML without `style` attributes and their text goes through `escapeHtml`.
- A request is `ready`, `refresh`, `markdown` with a view of the right shape, or one of four action ids with exactly the snapshot, table and choice it needs; a command id or free text cannot be part of it. The extension checks the numbers against the data it sent (`planActivityAction`) and logs a warning for what does not match.
- The page checks what it is sent (`isActivityMessage`). It makes no request; the extension reads only catalog tables, read-only.

## Known limits

- Only the newest 500 snapshots are read.
- Days without a commit are not drawn; the chart is not a calendar.
- The author and table filters take one choice, not several.
- The charts are canvases: their bars cannot be focused. The tables and the list are the keyboard route.
