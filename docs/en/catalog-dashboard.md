# Catalog Dashboard

**Catalog Dashboard** (`aantje.showCatalogDashboard`) opens a panel about the database that holds the catalog of a lake: how large it is, which of its tables are large, how many rows the catalog keeps inline, and, for PostgreSQL, whether vacuum keeps up. A slow attach or slow catalog queries can be traced to the catalog before they hurt. It is a report on the [report shell](reports.md) with **Refresh** and **Open as Markdown**.

## Opening the report

- **Where.** The **Reports** submenu of an open connection. The command needs a node, so it is hidden from the Command Palette.
- **One panel per connection**, titled `Catalog Dashboard · <connection>`, as are the page and the Markdown document. The command again reveals it with fresh data.
- **Progress with Cancel.** `Reading the catalog database of "Lake"...` with a Cancel button.
- **The connection.** The report reads through the catalog connection of the explorer: the same PostgreSQL password, Entra or IAM token, the same file. A closed connection gives `Connect to a catalog first to show its catalog dashboard.`

## What it reads

Statistics views and pragmas only (`catalogDatabase` of the catalog reader, statements in `src/catalog/queries/database.ts`). Nothing is changed, no data file is read, and nothing runs without the user.

| Catalog    | What the report shows                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL | The size of the database (`pg_database_size`), the server version, whether the session uses SSL (`pg_stat_ssl`). Each `ducklake_*` table of the schema of the catalog with its row estimate (`reltuples`), its size with indexes and TOAST, the rows inserted and deleted since the statistics of the database were last reset (which tables grow and churn), its dead rows and the last vacuum, autovacuum, analyze and autoanalyze (`pg_stat_user_tables`). |
| SQLite     | The size of the file and its pages, the free pages, the SQLite version, the write-ahead log (the size of `-wal` and whether the header says WAL mode) and the exact rows of each catalog table. sql.js has no `dbstat`, so there is no size per table.                                                                                                                                                                                                        |
| DuckDB     | The size of the file, its used and free blocks (`pragma_database_size`), the `.wal` file and the rows DuckDB keeps for each table (`duckdb_tables`). DuckDB tells no size per table.                                                                                                                                                                                                                                                                          |
| Quack      | A Quack server answers queries on its tables but tells nothing about its database file: the report counts the rows of the catalog tables and says so in a note; size and free space are not shown.                                                                                                                                                                                                                                                            |

The **inlined data tables** (`ducklake_inlined_data_*`) are listed apart with their rows and the DuckLake table whose rows they hold (named as at the newest snapshot; a dropped table is named by its id), because those rows live in the catalog, not in Parquet files.

A part the server refuses (a missing privilege, a view the server lacks) is named in a note under the report with the server's message; the rest is shown.

For SQLite the explorer reads a copy of the file taken at connect: the pages and rows are those of the copy, while the size of the file and its log are read when the report is read. Refresh the connection to read a newer copy.

## The tables on the page

**Tables** lists the catalog tables, largest first, and **Inlined data** the inlined data tables, most rows first, each 50 rows to a page with **First**, **Previous**, **Next** and **Last**, the page and the count between them, and a **Filter** box (`pagedTable` of `src/shell/paged-table.ts`). The box finds a catalog table by its name, and an inlined data table by its name and the table whose rows it holds; typing goes back to the first page. A table that waits for a vacuum has the warning sign after its name. The name is a button that selects the table: its row is marked in both lists, as an inlined data table is in each. The box and the page of each list and the selected table stay for a hidden panel and a Refresh of the same connection.

## Findings

| Finding                  | When                                                                                                  | Action                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| Many dead rows (warning) | A PostgreSQL table has at least 1,000 dead rows and they are at least 20 % of its rows (`DEAD_ROWS`). | **Open VACUUM (ANALYZE) Script** |
| Free space (info)        | At least 25 % of a SQLite or DuckDB file is free pages or blocks (`FREE_SHARE`).                      | none                             |

The data file, delete file and inlined data tables churn with every write and compaction of the lake, so they are the usual candidates.

**The VACUUM script is for a PostgreSQL client.** **Open VACUUM (ANALYZE) Script** on a finding, or **VACUUM Script** in the header for all of them, opens an untitled SQL document with `VACUUM (ANALYZE) "schema"."table";` per table, names quoted. The document belongs to no connection: VACUUM runs in PostgreSQL, while the SQL editor of aantje runs DuckDB, and VACUUM cannot run inside a transaction block. Run it with psql or another PostgreSQL client, as a user that may vacuum these tables (their owner, or from PostgreSQL 17 a member of `pg_maintain`); the database decides. Opening the document runs nothing.

The page names an action and the index of a table, never SQL; the extension writes the script only for a table of its data that has many dead rows (`planDashboardAction` in `src/catalog-dashboard/actions.ts`).

## Open as Markdown

`dashboardMarkdown` (`src/catalog-dashboard/markdown.ts`) writes the key figures, the findings, the tables (at most 100), the inlined data and the notes. Names of tables and the schema are code; nothing of the catalog database renders as Markdown.

## Module

`src/catalog-dashboard/`: `model.ts` (data, thresholds, findings, cards, notes, the VACUUM script), `read.ts` (the read and the file facts of a SQLite or DuckDB catalog), `actions.ts`, `protocol.ts`, `kind.ts`, `markdown.ts`, `page.ts`, `style.ts`, `commands.vscode.ts`.

## Known limits

- SQLite and DuckDB tell no size per table; the tables are listed by their rows.
- The row estimate of PostgreSQL is that of the last analyze; a table that was never analyzed shows none.
- aantje records no history of the catalog database: the dashboard shows the state when it is read, and for PostgreSQL the rows inserted and deleted since its statistics were reset. SQLite, DuckDB and Quack count no such rows. The [Growth report](growth-report.md) shows the growth of the lake's files.
