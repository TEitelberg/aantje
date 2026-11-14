# Changelog

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

[0.2.5]: https://github.com/TEitelberg/aantje/releases/tag/v0.2.5
[0.2.1]: https://github.com/TEitelberg/aantje/releases/tag/v0.2.1
