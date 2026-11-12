# aantje documentation

aantje is an explorer and SQL editor for DuckLake catalogs in VS Code and code-server. The explorer is read-only; the SQL editor runs any SQL against the lake. These pages describe what it does and how to use it.

## Start here

| Page                            | Covers                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| [Features](features.md)         | Everything aantje does, and its known limits.                 |
| [Installation](installation.md) | Install the VSIX, platforms, connections for a whole machine. |

## Using aantje

| Page                                                          | Covers                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------- |
| [Connections](connections.md)                                 | Profiles, settings format, passwords, wizard, provisioning.         |
| [Azure DuckLake](azure-lake.md)                               | Create, import and delete a lake in Azure; Entra access to ADLS.    |
| [Tree](tree.md)                                               | Nodes, lifecycle, refresh, tooltips, errors.                        |
| [Snapshots, search and status bar](snapshot-search-status.md) | Snapshot selection, catalog search, status bar item.                |
| [Time travel](time-travel.md)                                 | Query at Snapshot, Compare Schema, Compare Snapshots, Show Changes. |
| [Data access](data-access.md)                                 | Select Top 1000 Rows: the private DuckDB, S3, views and trust.      |
| [Data grid](grid.md)                                          | The webview grid and its protocol.                                  |
| [Notebooks](notebooks.md)                                     | Create Notebook.                                                    |
| [SQL editor](sql-editor.md)                                   | Documents, connections, sessions, runs.                             |
| [SQL session](sql-session.md)                                 | The long-lived DuckDB session of the editor.                        |
| [SQL IntelliSense](sql-intellisense.md)                       | Completion, hover, signature help, syntax errors, unknown names.    |
| [DDL generation](ddl.md)                                      | Copy DDL, Script as SELECT / CREATE / ALTER / DROP.                 |
| [Maintenance scripts](maintenance.md)                         | The Maintenance submenu.                                            |
| [Logging](logging.md)                                         | The output channel and the secret filter.                           |

## Reports

| Page                                  | Covers                                                |
| ------------------------------------- | ----------------------------------------------------- |
| [Reports](reports.md)                 | The report family, the shared shell, Properties.      |
| [Statistics report](statistics.md)    | Files, sizes, columns, partitions, growth of a table. |
| [Storage report](storage-report.md)   | Storage of a lake, small files, files to delete.      |
| [Snapshot report](snapshot-report.md) | Swimlane chart of the newest snapshots.               |
| [Schema History](schema-history.md)   | Columns of a table against its snapshots.             |
| [Activity report](activity-report.md) | Commits, authors, most changed tables.                |
| [Growth report](growth-report.md)     | Rows, size and files over the snapshots.              |
| [Maintenance Advisor](advisor.md)     | Measured maintenance advice.                          |
| [Dependencies](dependencies.md)       | What uses and what is used, drop impact.              |
| [Health check](health-check.md)       | Checks of catalog, connection and object store.       |

## Security

[Security](security.md): threat model, read-only guarantee, credentials, code-server.

## Project files

[README](../../README.md), [Changelog](../../CHANGELOG.md), [Licence](../../LICENSE), [Third-party notices](../../THIRD-PARTY-NOTICES.md).
