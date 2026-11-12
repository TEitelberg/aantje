# Features

aantje adds a view to the Activity Bar that shows the structure of a DuckLake catalog and the first rows of its tables, plus a SQL editor that runs any SQL against the lake. This page lists what it does and where it stops.

The explorer is read-only. The tree reads the `ducklake_*` metadata tables with read-only SQL, so browsing needs no DuckLake extension. Reading data (grid, notebook, view columns) uses a private, read-only DuckDB with the DuckLake extension. The SQL editor has its own writable sessions ([Security](security.md)).

## Explorer

- **Connections** to DuckLake catalogs stored in PostgreSQL, SQLite or DuckDB, or served by a DuckDB server over Quack (token in the secret storage, TLS with a pinned certificate): add, edit, remove, test, connect, disconnect ([Connections](connections.md)).
- **Azure DuckLake**: **Create Azure DuckLake...** deploys a PostgreSQL server (catalog) and an ADLS Gen2 account (data files) from a Bicep template, gives you the storage role and adds the lake as a connection, signed in once with your Microsoft account. **Finish Creating Azure DuckLake...** picks up a deployment whose wait broke off, **Import Azure DuckLake...** adds a lake from the output of a portal deployment, **Delete Azure DuckLake...** removes one that aantje created ([Azure DuckLake](azure-lake.md)).
- **Tree** of schemas with the folders Tables, Views and Macros. A table has Columns (STRUCT, LIST and MAP expand into nested fields), Partitioning, Sort Order and Tags when present, and the leaves **Statistics** and **History** that open reports. The tree shows no counts; rows and size are in the tooltip and the statistics report ([Tree](tree.md)).
- **Snapshots** folder: the newest snapshots with time, author, commit message and changed objects. **Show Catalog at this Snapshot** and **Show Latest Snapshot** change what the whole tree shows ([Snapshots, search and status bar](snapshot-search-status.md)).
- **Columns of views.** DuckLake stores no columns for a view, so DuckDB resolves them. That runs the SQL stored in the catalog, so aantje asks once per connection whether you trust it. The SQL of a view is in its tooltip.
- **Tooltips**: rows, size and comment of a table, SQL of a view, type of a column.
- **Copy** the qualified name of a schema, table, view or column, and the DDL of a table or view.
- **Catalog search** for tables and views in all schemas, with a jump to the hit.
- **Status bar** item with the connection, DuckLake version and snapshot.

## Scripts

- **Script as** SELECT, CREATE, ALTER or DROP on every node that has a script, and INSERT on a table, opens it in a new SQL editor of the connection. Nothing runs until you run it. Scripts that create or alter contain the matching DROP as a comment ([DDL generation](ddl.md)).
- **Maintenance** on a connection and a table: Checkpoint, Merge Adjacent Files, Rewrite Data Files, Flush Inlined Data, Expire Snapshots, Clean Up Old Files, Delete Orphaned Files, Set Option. Each opens the DuckLake call; what destroys data starts with a dry run and the real call is commented out ([Maintenance scripts](maintenance.md)).

## Time travel

- **Query at Snapshot...** opens the first rows, a notebook or a SQL editor at any snapshot at which the table existed.
- **Compare Schema...** shows the `CREATE TABLE` of two snapshots in a diff editor. **Compare Snapshots...** writes a Markdown report of changed tables, views and columns.
- **Show Changes...** shows the rows inserted, updated and deleted between two snapshots in a grid. **Show Rows Changed** does so for one snapshot ([Time travel](time-travel.md)).

## Data

- **Select Top 1000 Rows** shows the first rows of a table or view in a grid: DuckDB types, NULL marked, sort by header, filter row, copy and CSV export, at the snapshot the tree shows ([Data access](data-access.md), [Data grid](grid.md)).
- **Create Notebook...** opens a self-contained Jupyter notebook that attaches the lake read-only at the same snapshot. It contains no password ([Notebooks](notebooks.md)).
- **S3 data.** Set `aantje.s3.endpoint` and the key with **Set S3 Credentials...** for Parquet files on S3 or MinIO.

## Reports

The **Reports** submenu opens panels with one look. All have **Open as Markdown**, and where data can change, **Refresh** ([Reports](reports.md)).

- **Statistics** (table): files, size, rows, small files, file size histogram, null share and range of columns, partition evenness, growth ([Statistics](statistics.md)).
- **Snapshot Report**: swimlane chart of the newest 500 snapshots, with filters and actions ([Snapshot report](snapshot-report.md)).
- **Schema History** (table): columns against the snapshots that changed them ([Schema History](schema-history.md)).
- **Growth**: rows, size or files over the snapshots, for the lake or a table ([Growth report](growth-report.md)).
- **Activity**: commits per day, authors, changes by kind, most changed tables ([Activity report](activity-report.md)).
- **Storage Report**: data path, largest tables, small files, files waiting for deletion ([Storage report](storage-report.md)).
- **Properties**: the facts of the catalog and every row of `ducklake_metadata`.
- **Maintenance Advisor**: what maintenance would do, measured with the DuckLake dry runs, ranked by impact, effort and risk. Nothing is executed ([Maintenance Advisor](advisor.md)).
- **Dependencies**: what uses an object and what it uses, and what a drop would break ([Dependencies](dependencies.md)).
- **Check Health** and **Check Table Health**: the catalog, the connection and the object store, with an optional deep check of Parquet footers. Nothing runs without your action ([Health check](health-check.md)).

## SQL editor

**New Query** on a connection, schema, table or view opens a SQL document bound to that connection. The editor completes names, shows hover and signature help, marks syntax errors and warns of the tables, views and columns that the lake does not have, with a quick fix to the nearest name ([SQL IntelliSense](sql-intellisense.md)). **Run Query** (`F5`), **Run Statement at Cursor** (`Ctrl+Enter`) and **Cancel Query** (`Shift+F5`) run it. Each editor has its own session, and results open in a panel below that stays with the editor: it follows it, comes forward with it and closes with it, and **Hide Results** (`Ctrl+Alt+R`) gives the query the whole height. The editor runs any SQL with the rights of the connection's credentials. A profile can open its sessions read-only (`readOnly`), and **Toggle Read-only Session** switches one editor; a Quack connection has no such switch, its server decides what the token may do. After a statement that changed the catalog, the tree reads the connection again ([SQL editor](sql-editor.md), [SQL session](sql-session.md)).

## Known limits

- Row counts cover data files only, minus deleted rows. Inlined rows are not counted. They are exact at the latest snapshot and can be off at an older one after compaction.
- A SQLite catalog is read from a copy taken at connect. Refresh to see newer commits. A catalog with an uncheckpointed write-ahead log is refused.
- A DuckDB file held open for writing by another process cannot be opened, and while aantje is connected the file is locked against writers. A writable SQL session locks it exclusively, so aantje disconnects the explorer first and leaves it disconnected. PostgreSQL and a Quack server suit several clients.
- Quack is experimental in DuckDB 2.0.0. A Quack catalog cannot be attached read-only, so the server must refuse writes; a server restart ends open SQL sessions (the explorer attaches again).
- Schemas nested in schemas (specification 1.1) are shown flat.
- **Copy DDL** and **Script as CREATE** write DuckDB syntax. A view stored in another dialect stays in that dialect.
- A view that DuckDB cannot bind (a dropped table) shows the error instead of columns.
- The grid shows at most 1000 rows of a table. Sorting and filtering work on those rows only. There is no paging.
- Reading data needs the data files. For S3, set the endpoint and credentials, or the `AWS_*` variables. A relative data path is found only if the extension host's working directory happens to be right.
- Nested values are shown as JSON text. BIGINT and DECIMAL are shown as exact text.
- **Export CSV**, **Copy row** and **Copy all** neutralise formulas (a leading `'` on text starting with `=`, `+`, `-`, `@`, tab or CR). **Copy cell** keeps the exact value. The CSV is UTF-8 without a byte order mark.
- An Azure lake is read with an Entra token that the DuckDB `azure` extension does not renew; a long SQL session replaces it every ten minutes. Nothing of the Azure feature has been run against a real subscription yet ([Azure DuckLake](azure-lake.md#what-is-verified-and-what-is-not)).
- A notebook is generated once; later changes do not reach an open notebook. The preview grid, and the connection and session of a SQL document, are not restored after a restart.
- The SQL editor keeps at most `aantje.sql.maxRows` rows of a result; sorting and filtering work on the loaded rows. A statement such as `WITH ... INSERT` does not count as a change, so use Refresh.
