# aantje documentation

aantje is an explorer and SQL editor for DuckLake catalogs in VS Code and code-server. The explorer is read-only; the SQL editor runs any SQL against the lake. These pages describe what it does and how to use it.

## Start here

| Page                            | Covers                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| [Features](features.md)         | Everything aantje does, and its known limits.                 |
| [Installation](installation.md) | Install the VSIX, platforms, connections for a whole machine. |

## Using aantje

| Page                                                          | Covers                                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Connections](connections.md)                                 | Profiles, settings format, passwords, wizard, provisioning.                               |
| [Azure DuckLake](azure-lake.md)                               | Create, import and delete a lake in Azure; Entra access to ADLS.                          |
| [AWS DuckLake](aws-lake.md)                                   | Create a lake in AWS: RDS for PostgreSQL and an S3 bucket in one CloudFormation stack.    |
| [Sync to Iceberg](iceberg.md)                                 | Targets, the copy of a lake to an Iceberg REST catalog, its green or red row and report.  |
| [Tree](tree.md)                                               | Nodes, lifecycle, refresh, tooltips, errors.                                              |
| [Files](files.md)                                             | The storage of a lake in the tree, and import scripts for CSV, Parquet, JSON, Excel.      |
| [Snapshots, search and status bar](snapshot-search-status.md) | Snapshot selection, catalog search, status bar item.                                      |
| [Time travel](time-travel.md)                                 | Query at Snapshot, Compare Table and Snapshots, Show Changes, both restore scripts.       |
| [Schema Compare and Data Compare](compare.md)                 | Two tables or two schemas, the rows of two tables, and Script as Update that aligns them. |
| [Data access](data-access.md)                                 | Select Top 1000 Rows: the private DuckDB, S3, views and trust.                            |
| [Data grid](grid.md)                                          | The webview grid and its protocol.                                                        |
| [Notebooks](notebooks.md)                                     | Create Notebook.                                                                          |
| [SQL editor](sql-editor.md)                                   | Documents, connections, sessions, runs.                                                   |
| [SQL session](sql-session.md)                                 | The long-lived DuckDB session of the editor.                                              |
| [Templates](templates.md)                                     | The store of SQL templates: search, Use, own, imported and folder templates, the format.  |
| [SQL IntelliSense](sql-intellisense.md)                       | Completion, hover, signature help, syntax errors, unknown names.                          |
| [DDL generation](ddl.md)                                      | Copy DDL, Script as SELECT / CREATE / ALTER / DROP, Generate Scripts.                     |
| [Maintenance scripts](maintenance.md)                         | The Maintenance submenu.                                                                  |
| [Logging](logging.md)                                         | The output channel and the secret filter.                                                 |
| [MCP server](mcp.md)                                          | How Copilot and Claude Code read the connected lakes: the tools, the log, the limits.     |

## Reports

| Page                                      | Covers                                                         |
| ----------------------------------------- | -------------------------------------------------------------- |
| [Reports](reports.md)                     | The report family, the shared shell, Properties.               |
| [Details](details.md)                     | The objects of a schema or lake in one sortable list.          |
| [Statistics report](statistics.md)        | Files, sizes, columns, partitions, growth of a table.          |
| [Storage report](storage-report.md)       | Storage of a lake, small files, files to delete.               |
| [Snapshot report](snapshot-report.md)     | Swimlane chart of the newest snapshots.                        |
| [Schema History](schema-history.md)       | Columns of a table against its snapshots.                      |
| [Activity report](activity-report.md)     | Commits, authors, most changed tables.                         |
| [Growth report](growth-report.md)         | Rows, size and files over the snapshots.                       |
| [Maintenance Advisor](advisor.md)         | Measured maintenance advice.                                   |
| [Dependencies](dependencies.md)           | What uses and what is used, as a list and a graph.             |
| [Health check](health-check.md)           | Checks of catalog, connection and object store.                |
| [Catalog Dashboard](catalog-dashboard.md) | Size, tables and vacuum state of the catalog database.         |
| [Parquet inspector](parquet-inspector.md) | Row groups, encodings and statistics of a Parquet file.        |
| [Suggest Partitioning](partitioning.md)   | Partition and bucket columns from the queries and the data.    |
| [Inactive Tables](inactive-tables.md)     | Tables without a change for a number of days, with their size. |

## Security

[Security](security.md): threat model, read-only guarantee, credentials, code-server.

## Project files

[README](../../README.md), [Changelog](../../CHANGELOG.md), [Licence](../../LICENSE), [Third-party notices](../../THIRD-PARTY-NOTICES.md).
