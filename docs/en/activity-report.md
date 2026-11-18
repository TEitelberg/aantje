# Activity report

**Activity** (`aantje.showActivity`) opens a webview that sums up the newest snapshots of a catalog: who committed, when, and where. Key figures sit above five tabs: the commits per day, the changes by kind, the authors with their latest message, the most changed tables as a chart, and the changes of each table by kind. It answers "who has been working on this lake, and where". It lists no snapshot one by one: that is the [Snapshot report](snapshot-report.md)'s, which **Show Snapshot Report** in the header opens. Everything comes from the DuckLake catalog through the explorer's read-only drivers; the charts are drawn by [Apache ECharts](https://echarts.apache.org/) in the shared report script ([Reports](reports.md)).

## Opening the report

- **Where.** In the **Reports** submenu of a connected connection and of a schema. The command is hidden from the Command Palette because it needs a node.
- **One panel per connection and scope**, titled `Activity · Lake` or `Activity: shop · Lake`. Opening it again reveals the panel with fresh data.
- **Progress and Cancel.** The snapshots are read under `Reading the activity of "Lake"...` with Cancel. A connection that is not open gives `Connect to a catalog first to show its activity.`
- **Refresh.** The report is a picture of the time it was read. **Refresh** reads the snapshots again and keeps the tab and the choices; an end of the range that sat at the oldest or newest snapshot stays there, an end the user moved is kept.
- **A hidden panel keeps its tab and its choices** (`getState`/`setState`), fitted to the data when the page is rebuilt (an author or table that is gone is dropped).
- A removed connection gives `The connection of this activity report was removed. Close the report.`; a closed one `The connection is closed. Connect again to use the activity report.`

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report counts the snapshots that changed the schema (the schema itself, or a table, view or macro in it) among the newest 500 of the lake, each with only its changes to the schema (`activityOfSchema` in `src/shell/schema-scope.ts`). Commits, authors, days and tables are counted from these. The note about older snapshots is the lake's: the 500 are the newest of the lake, not of the schema. **Show Snapshot Report** opens the Snapshot report of the lake. The page heading reads `Activity: <schema>` and the Markdown title `# Activity: <schema> · <connection>`.

## What the report shows

- **Key figures:** the snapshots in view (`of 57 read`), the authors, the tables the snapshots changed, the days with commits, the time of the latest commit. When the catalog has older snapshots than those read, a note above the figures says so.
- **Tabs**, a little further below the figures than the usual section gap. They follow the WAI-ARIA pattern of the other reports with tabs (the Storage report, the Statistics report): only the selected tab is in the tab order, the arrow keys, Home and End move between them. Only the tab shown has a chart, drawn once the tab is in the page, so that it takes the width of the page.
  - **Commits per day.** A bar per day (UTC) with a commit; days without one are not drawn. **Show the days as a table** lists the commits and changes of each day.
  - **Changes by kind.** The changes of each kind in total, and each day's changes stacked by kind: insert, update, delete, schema change, maintenance. The classification is the [Snapshot report](snapshot-report.md)'s: a schema change wins over data in one table and snapshot, insert and delete together are an update. A snapshot that changed two tables counts as one commit and two changes. **Show the days as a table** is here too.
  - **Authors.** Commits per author with first and latest commit and the latest message, most commits first; at most 50 are listed, and a note counts the others.
  - **Most changed tables.** A bar chart of the 20 tables with the most changes (a table keeps its bar across a rename and shows its newest name; a dropped table says `(dropped)`). A click on a bar filters the whole report to that table.
  - **Table changes.** The same 20 tables with their changes in total and by kind. A click on a table name filters the whole report to that table. In this tab and the one before, a note counts the tables left out.

Charts use the colours of aantje ([Reports](reports.md#colours)): the commits and the tables in navy, the kinds of change navy, orange, slate and teal, maintenance muted; in high contrast the theme's colours, and the bars get patterns. Kinds are named in the legend and tables, so colour is never the only carrier.

## Catalogs without authors

Most writers set no author and no commit message. Their snapshots show as **(no author)** in the tab Authors and in the filter; that is the usual case, not an error, and the report says nothing more about it. A writer records them with `set_commit_message` inside the transaction that writes (a call outside a transaction sets nothing), using the name the lake is attached as:

```sql
BEGIN; CALL ducklake_set_commit_message('lake', 'me', 'Nightly import'); INSERT INTO ...; COMMIT;
```

The SQL editor of aantje asks for a message when a run commits a change and sets it this way ([Commit messages](sql-editor.md#commit-messages)).

A catalog of specification 1.0 has no commit columns at all, so every snapshot has no author.

## Filters

The key figures and all tabs follow the same filters.

- **Author:** the authors in the data, with **(no author)**.
- **Table:** a snapshot needs a change on that table, and only that table's changes are counted.
- **Message:** finds text in the commit message, ignoring case. Snapshots without a message do not match.
- **Kinds:** switches the five kinds on and off. A snapshot needs a change of a kind that is on, and only those are counted. A snapshot with no recorded change stays while nothing narrows kinds or table.
- **From / To:** limit the snapshots to the ids between two values (inclusive, inside the snapshots read).

## Show Snapshot Report

The header has one action besides **Refresh** and **Open as Markdown**: **Show Snapshot Report** opens the [Snapshot report](snapshot-report.md) of the connection, as its command does on the connection node. There a snapshot is selected, with what it changed and what can be done with it: show the catalog at it, compare it with another snapshot, show the rows it changed. The Activity page names no snapshot and no table to the extension.

## Open as Markdown

**Open as Markdown** opens an untitled document of the report as it is: the filters as text, the note about older snapshots, the commits per day with the changes by kind, the authors, and the most changed tables with their changes by kind. Like the page, it lists no snapshot one by one. `activityMarkdown` (`src/activity/markdown.ts`) builds it from the data and the view the page names; the extension fits the view to the data. Catalog text is code. The tables stop at 100 days, 50 authors and 20 tables (`… n more omitted (limit: m).` for the days, a note for the others).

## Data and limits

`CatalogReader.snapshotActivity(500)` returns the newest 500 snapshots with time, author, message and resolved changes, and whether older ones exist; the report adds the newest snapshot of the catalog. It runs one statement for the snapshots and at most two per kind of object, not one per snapshot. The Snapshot report's model (`buildModel`) classifies the changes; this report counts them.

- **500 snapshots.** Older ones are not read, and a note says so. Filters work on what was read. The page holds all 500 with their changes.
- **Days are UTC days** of the commit time.
- **Expired snapshots** are not read and their commits are not counted.

## Security

The page uses the shared policy (`default-src 'none'`, nonce for script and style), `localResourceRoots` is `dist` and `media` (the logo of the header), and data arrives by `postMessage` after `ready` ([Reports](reports.md#the-shell)).

- Catalog text goes into the page with `textContent`; chart tooltips are HTML without `style` attributes and their text goes through `escapeHtml`.
- A request is `ready`, `refresh`, `markdown` with a view of the right shape, or the action id `showSnapshotReport` with no other field (`isActivityAction`). Anything else is ignored: a command id, free text, a snapshot or a table, and the actions on a single snapshot, which the Snapshot report has.
- The page checks what it is sent (`isActivityMessage`). It makes no request; the extension reads only catalog tables, read-only.

## Known limits

- Only the newest 500 snapshots are read.
- Days without a commit are not drawn; the chart is not a calendar.
- The author and table filters take one choice, not several.
- The charts are canvases: their bars cannot be focused. **Show the days as a table** under the charts of the days and the tab **Table changes** are the keyboard route.
