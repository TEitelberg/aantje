# Inactive Tables

**Inactive Tables** (`aantje.showInactiveTables`) opens a panel with the tables of a lake or a schema that have not changed for a number of days, with their size: tables to archive, drop or move, or at least to know. The criterion is a change, which the catalog records; DuckLake records no reads, so the last read is only a hint from your own Query History. It is a report on the [report shell](reports.md) with **Refresh** and **Open as Markdown**.

## Opening the report

- **Where.** The **Reports** submenu of an open connection and of a schema. The command needs a node, so it is hidden from the Command Palette.
- **One panel per connection and scope**, titled `Inactive Tables · Lake` or, for a schema, `Inactive Tables: shop · Lake`; the page heading is `Inactive Tables` or `Inactive Tables: shop`. The command again reveals it with fresh data.
- **The days.** The page lists the tables without a change for 30, 90, 180 or 365 days (the buttons **No change for**) or for a whole number of days from 1 to 36,500 (the field **Days**). Changing them reads the tables again. The report opens with the days chosen last, on any connection, and with 90 days the first time; aantje keeps them in its global state. **Refresh** reads the tables again with the days the panel shows.
- **Progress with Cancel.** `Reading the tables of "Lake" without a change for 90 days...` with a Cancel button. A closed connection gives `Connect to a catalog first to show its inactive tables.`
- A removed connection gives `The connection of this inactive tables report was removed. Close the report.`

## What counts as a change

The catalog tells when a table changed, at catalog cost only (`lastTableChanges` of the catalog reader, statements in `src/catalog/queries/activity.ts`): the newest of the snapshots of its versions (created, renamed), its columns (added, changed, dropped), its comments, partitioning and sort order, the rows still inlined in the catalog, and its files: a data file by the newest snapshot of its rows (`partial_max` of a merged or flushed file), a delete file, and the end of either.

A snapshot whose `changes_made` holds only maintenance (merge, rewrite, flush, expire: no insert, delete, inlined change, create, alter or drop) is no change, so a table that is only maintained shows as inactive. DuckLake does not tell maintenance and logical changes apart (discussion duckdb/ducklake #1822), so aantje decides by the change kinds of the snapshot; a flush that DuckLake records with `deleted_from_table` counts as a change.

When the snapshot of the last change has expired, its time is gone: the row says `before <time> (@n expired)`, the time of the next snapshot that is left, and the table counts as inactive only when that time is older than the days.

## What is not known: reads

DuckLake records no reads, and the catalog database sees only metadata queries. The column **Last read (local)** is a hint from your own [Query History](sql-editor.md#query-history) of the connection, on this machine: the newest query that ran without an error and names the table. DuckDB's parser reads each statement with `json_serialize_sql` on the DuckDB of `src/sql/parser-engine.ts`; a statement that writes is no read, and an unqualified name is a table of `main`, as in the SQL editor. It is `never` when the history holds no such query, which says nothing about other users and clients.

## The tables

The tables of the scope at the newest snapshot without a change for the days, the longest unchanged first: schema and name, the last change (time and snapshot), its author and message, rows, size, files, comment and the last read. The subtitle counts them against all tables of the scope. On a schema node the report lists the tables of that schema; the Query History is the one of the connection.

The list shows 50 tables to a page with **First**, **Previous**, **Next** and **Last**, the page and the count between them, and a **Filter** box that finds a table by its name, the author and message of its last change and its comment (`pagedTable` of `src/shell/paged-table.ts`); typing goes back to the first page. The name of a table is a button that selects it and marks its row. The box, the page and the selected table stay for a hidden panel and a Refresh; with other days the box stays and the list starts again on its first page, or on the page of the selected table when it is still listed.

Each row has three icons next to the name of its table; the name of an icon is its tooltip and what a screen reader hears, with the table:

| Icon                | What happens                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Show in Tree**    | Selects the table in the tree.                                                       |
| **Show Statistics** | Opens its [Statistics report](statistics.md) at the snapshot the report was read at. |
| **Dependencies**    | Opens its [Dependencies](dependencies.md): the views and macros that use it.         |

The icons are those of the same actions on the [Dependencies](dependencies.md) page. **Dependencies** runs the command of the table's node at the snapshot the tree shows; a table the tree does not show there gets a message.

## Open as Markdown

`inactiveMarkdown` (`src/inactive-tables/markdown.ts`) writes the days and how many tables of the scope have no change for them, and the tables of the page, at most 200 (`… n more omitted (limit: 200).`). Names, authors, messages and comments from the catalog are code; nothing of the catalog renders as Markdown.

## Security

The page uses the shared policy (`default-src 'none'`, nonce for script and style), `localResourceRoots` is `dist`, and data arrives by `postMessage` after `ready` ([Reports](reports.md#the-shell)).

- Catalog text goes into the page with `textContent`.
- A request is `ready`, `refresh`, `markdown`, one of three table actions with exactly a table id, or `days` with exactly a number; a command id or free text cannot be part of it. The extension acts only on a table the report lists and on days from 1 to 36,500 (`planInactiveAction` in `src/inactive-tables/actions.ts`) and logs a warning for anything else.
- The report reads only: the catalog tables through the explorer's read-only drivers, and the Query History on this machine, which does not leave it.

## Module

`src/inactive-tables/`: `model.ts` (data, the days, the filter, texts), `read.ts` (the tables of the scope, their last change and the last reads in the Query History), `actions.ts`, `protocol.ts`, `kind.ts`, `markdown.ts`, `page.ts`, `style.ts`, `commands.vscode.ts` (the command, the actions and the days chosen last).

## Known limits

- Reads are not recorded by DuckLake: the last read covers your own queries in the SQL editor of aantje on this machine, as far as the Query History keeps them (`aantje.queryHistory.size`).
- Maintenance and logical changes are told apart by the change kinds of a snapshot, not by DuckLake.
- The tables are read at the newest snapshot, whatever snapshot the tree shows.
