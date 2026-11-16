# Changelog

## [0.2.6] - 2026-11-16

AWS DuckLake, Sync to Apache Iceberg, an MCP server for AI assistants, Data Compare, and the files of a lake in the explorer.

- Create AWS DuckLake... deploys a lake with one CloudFormation stack: RDS for PostgreSQL as the catalog (TLS, reachable from your IPv4 address only), an S3 bucket for the data files and a VPC of its own, in the sizes Small and Medium. Names, quotas and permissions are checked, and a change set shows the resources and a cost note before anything is created; Finish Creating AWS DuckLake... completes an interrupted one. Delete AWS DuckLake... (with or without a final snapshot of the catalog), Allow My IP and Import AWS DuckLake... complete it. The catalog takes a password or AWS IAM database authentication. AWS credentials come from a profile in `~/.aws` or the environment; aantje stores none.
- A delete of an AWS lake that stops, for example when the network drops, is noted on the connection: a red icon, "delete unfinished" and a tooltip. Delete AWS DuckLake... again goes on where it stopped and does not ask for a snapshot of a database that is gone. Short outages during a delete are asked again.
- Sync to Iceberg... writes a lake, a schema or a table to an Apache Iceberg REST catalog (Polaris, for example), with the partitioning, the types Iceberg can hold and the origin of each table. A later sync brings the Iceberg tables up to date by appending, replacing or recreating them. Iceberg targets are defined once (Add Iceberg Target..., Remove Iceberg Target...). A row per target in the tree is green when every synced table has the state of the lake, its report lists every table, and a table that is behind says so.
- MCP server: an AI assistant in VS Code (GitHub Copilot, Claude Code) can list and describe the objects of the connected lakes with their dependencies, read table statistics and the Maintenance Advisor, explain, analyze and profile a statement that only reads, open SQL in an editor, read the state of the Iceberg syncs and ask you for a sync. It never writes by itself, and it returns sample rows only when `aantje.mcp.maxRows` allows them. **aantje: Add MCP Server to Claude Code** sets up Claude Code.
- Data Compare... compares the rows of two tables, in one schema, across schemas or across connections, at the snapshot each side shows, and writes Script as Update to make the target like the source.
- The folder Files below a connection browses the storage of the lake (S3, S3-compatible stores, Azure ADLS Gen2 or Blob, OneLake, a local disk) and writes scripts that import a CSV, Parquet, JSON or Excel file or a folder.
- Run to File... writes the result of a statement that only reads to a CSV or Parquet file; Export... does the same for a whole table or view; Script as INSERT with Data... writes a table or view with its rows as a script.
- After Statistics and Analysis, the tab Tips lists what would make a statement faster (sort order, storage and cache, memory, maintenance), with a script where one applies. The tab Treemap & Top Operators is gone.
- New Query is on every node below a connected lake: empty, or with the SELECT of a table or view. A connection that fails to connect has a red icon.
- Oog Docker stack: Polaris as an Iceberg REST catalog with the target "Oog Polaris", and the PostgreSQL extension, Claude Code and the AWS CLI in the workbench. The medallion notebooks also create the 13 views on views in `gold`.
- SQLite catalogs are read with sql.js 1.16.0. Built with TypeScript 7 and checked with oxlint.

## [0.2.5] - 2026-11-14

Storage per connection: where the data files of a lake live, and how aantje signs in there, is now part of the connection.

- A `postgres`, `sqlite` or `duckdb` profile can carry `storage`: AWS S3, an S3-compatible store (MinIO, RustFS, Cloudflare R2, Wasabi), Azure ADLS Gen2 or Blob, or Microsoft Fabric OneLake, each with its own sign-in (keys, credential chain, Entra ID, account key, SAS or service principal). The sign-in values live in the secret storage of that connection, never in the settings. A Quack profile has none, because the server reads the files.
- Add Connection and Edit Connection ask for the storage; Set Storage Sign-in... changes the values later; Test Connection checks the catalog and then the storage.
- Profiles without `storage` keep working: they use the `aantje.s3.*` settings and the global keys as before, and a legacy `azureAccount` is read as Azure with Entra ID.
- Create and Import Azure DuckLake write `storage` into the profile. A lake that was saved but never attached, and a deployment that was interrupted by closing the editor, are reported at the next start with a button to finish them.
- SQLite and DuckDB: when the file of a new connection does not exist, the wizard offers to create a DuckLake there.
- Notebooks for Azure lakes sign in with a device code and renew the storage secret with `refresh_storage_secret()`.
- The Oog Docker stack preconfigures the connection "Oog Lakehouse S3", which uses its own storage.

## [0.2.1] - 2026-11-04

The first release from this repository. Open VSX had 0.1.0 to 0.1.21 and 0.2.0 before; this release has everything they had and the fixes since.

- Connections to DuckLake catalogs in PostgreSQL, SQLite or DuckDB, with an Add Connection wizard. Passwords and S3 credentials stay in the VS Code secret storage.
- Read-only explorer: schemas, tables, views, macros, columns with nested types, partitioning, sort order and tags.
- Time travel: show the catalog at any snapshot, query a table as it was, compare schemas and snapshots, show the rows that changed.
- Script as SELECT, CREATE, ALTER and DROP on every node, and Script as INSERT on a table with a placeholder per column; maintenance scripts with a dry run first.
- Select Top 1000 Rows in a grid with sorting, filtering, copy and CSV export; Create Notebook... for a Jupyter notebook.
- SQL editor with completion, hover, signature help, cancel, result tabs and optional read-only sessions.
- SQL completion knows every function of DuckLake (`ducklake_snapshots('lake')`, the maintenance procedures with their named arguments), offers DuckLake statements as snippets, the snapshot times inside the quotes of `AT (TIMESTAMP => '...')`, and the objects of the newest snapshot, or of snapshot n inside a statement with `AT (VERSION => n)`. The hover of a table shows its partition and sort keys. It also completes DuckDB's own SQL (PIVOT and UNPIVOT, lambdas, `* EXCLUDE`/`REPLACE`, window frames, the options of COPY and `read_*`), the columns of CTEs, subqueries and VALUES from the SQL text and the columns of views once the connection's views are trusted, and warns of unknown tables, views and columns with a quick fix to the nearest name.
- Reports: Snapshot, Properties, Storage, Activity, Growth, Statistics, Schema History, Dependencies, Maintenance Advisor and Check Health, each with Open as Markdown.
- Safeguards for hostile catalogs: views run only after you trust the connection, views that call maintenance functions or reach other catalogs are refused, and data files on a server other than the data path or the S3 endpoint are refused before any request is sent.
- Create Azure DuckLake...: deploys a PostgreSQL flexible server (catalog) and an ADLS Gen2 storage account (data files) from a Bicep template, gives you Storage Blob Data Contributor on the account and adds the lake as a connection. Sign-in uses the Microsoft account of VS Code. Import Azure DuckLake... adds a lake from the output of the Deploy to Azure button; Delete Azure DuckLake... removes a lake that aantje created. Not yet run against a real Azure subscription, see the documentation.
- Allow My IP: replaces the firewall rule of an Azure lake with your current public IP, for lakes that aantje created and imported ones, and is offered after a connection that the firewall refused.
- Microsoft Entra sign-in to the PostgreSQL catalog of an Azure lake instead of a password: the template makes the deploying user Entra administrator, the token is renewed for every connect and in long SQL sessions, and no password is stored.
- The results of the SQL editor stay with their query: they open below it, follow it into another editor group, come forward with it and close with it. Hide Results in the editor title (`Ctrl+Alt+R`) gives the query the whole height; Show Results brings the last run back without running it again.
- DuckDB + Quack as a fourth catalog kind: a catalog served by a DuckDB server over Quack, with the token in the secret storage and the server certificate pinned after you confirm its fingerprint. The explorer stays connected while a SQL editor session writes; there is no read-only switch, because the server decides what the token may do. Quack is experimental in DuckDB 2.0.0.
- DuckLake specification 1.x, VS Code 1.140 or newer, desktop VS Code and code-server, Windows x64 and Linux x64. No telemetry.

[0.2.6]: https://github.com/TEitelberg/aantje/releases/tag/v0.2.6
[0.2.5]: https://github.com/TEitelberg/aantje/releases/tag/v0.2.5
[0.2.1]: https://github.com/TEitelberg/aantje/releases/tag/v0.2.1
