# aantje documentation

aantje is an explorer and SQL editor for DuckLake catalogs in VS Code and code-server. The explorer is read-only; the SQL editor runs any SQL against the lake. These pages describe how it works, how it is built and tested, and how it is delivered.

## Start here

| Page                            | Covers                                                        |
| ------------------------------- | ------------------------------------------------------------- |
| [Features](features.md)         | Everything aantje does, and its known limits.                 |
| [Installation](installation.md) | Install the VSIX, platforms, connections for a whole machine. |
| [Architecture](architecture.md) | Scope, runtime, module map, data flows, key decisions.        |
| [Development](development.md)   | Set up, build, run, code rules, recipes, debugging.           |

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

## Design

| Page                                    | Covers                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------- |
| [Catalog reader](catalog-reader.md)     | How the `ducklake_*` tables become the model.                           |
| [SQLite driver](driver-sqlite.md)       | Reading a catalog from SQLite with `sql.js`.                            |
| [DuckDB driver](driver-duckdb.md)       | The native binding, read-only access, locks.                            |
| [PostgreSQL driver](driver-postgres.md) | TLS, timeouts, cancellation, errors.                                    |
| [Quack driver](driver-quack.md)         | A catalog served over Quack: the locked instance, TLS pins, reconnects. |
| [Security](security.md)                 | Threat model, read-only guarantee, credentials, code-server.            |
| [Branding](branding.md)                 | Logo, icons, licence, changelog.                                        |

## Engineering and delivery

| Page                                         | Covers                                                |
| -------------------------------------------- | ----------------------------------------------------- |
| [Testing](testing.md)                        | The test layers and how to run them.                  |
| [Extension-host tests](integration-tests.md) | aantje inside a real VS Code.                         |
| [End-to-end tests](e2e-tests.md)             | aantje in code-server, replayed in Docker.            |
| [Test fixtures](test-fixtures.md)            | The fixture catalogs and their generators.            |
| [Packaging](packaging.md)                    | One VSIX per platform: build, contents, verification. |

## Project files

[README](../../README.md), [Changelog](../../CHANGELOG.md), [Licence](../../LICENSE), [Third-party notices](../../THIRD-PARTY-NOTICES.md).
