# Test fixtures

The tests run against real DuckLake catalogs written by DuckDB and the ducklake extension, not hand-made imitations. This page covers the catalogs, how to regenerate them and how the throw-away PostgreSQL container is started and cleaned up. Why real catalogs: [Testing](testing.md).

## The catalogs

Three catalogs hold the same content: the same statements, ids and logical content, differing only in the metadata engine.

| Fixture                             | Engine     | Reached by                                                                        |
| ----------------------------------- | ---------- | --------------------------------------------------------------------------------- |
| `test/fixtures/ducklake.sqlite`     | SQLite     | The SQLite reader, directly.                                                      |
| `test/fixtures/ducklake.duckdb`     | DuckDB     | The DuckDB reader, read-only.                                                     |
| `test/fixtures/postgres.sql`        | PostgreSQL | A `pg_dump` of the metadata tables, loaded into a throw-away container.           |
| `test/fixtures/ducklake-1.0.sqlite` | SQLite     | The same statements written by DuckDB 1.5, which uses DuckLake specification 1.0. |

`test/support/sources` exports the first three as `catalogSources`; contract suites run against every source that is available. The 1.0 catalog proves that both specification 1.x versions are read, and the browser specs open it too.

The catalogs hold only metadata. The Parquet files they name were written to a path inside the generating container and do not exist elsewhere. `test/fixtures/data` is a separate pair of DuckLakes (SQLite and DuckDB metadata) with real Parquet and delete files: `sales.orders` with nested columns, three rows, one deleted. The data tests use it.

## How they are generated

`test/fixtures/generate.py` builds a catalog with DuckDB 2.0.0 and the ducklake extension (specification 1.1). It runs only in a throw-away `python:3.12-slim` container, never on the host. The catalog is attached with `DATA_INLINING_ROW_LIMIT 0`, so inserts create Parquet files and deletes create delete files; that makes row counts and file counts testable. The statement list is frozen: snapshot ids and `test/support/expected.ts` depend on it.

## The snapshot sequence

Every statement that changes the catalog creates one snapshot; the latest is 13.

| Snapshot | Statement                                                |
| -------- | -------------------------------------------------------- |
| 0        | the default schema `main` of a new catalog               |
| 1        | `CREATE SCHEMA sales`                                    |
| 2, 3     | `CREATE TABLE sales.orders` and `sales.tmp`              |
| 4, 5     | insert of 3 rows into `sales.orders`, 1 into `sales.tmp` |
| 6        | `DELETE` of one `sales.orders` row (a delete file)       |
| 7        | `CREATE VIEW sales.big_orders`                           |
| 8 to 10  | comments on the table, a column and the view             |
| 11       | `DROP TABLE sales.tmp`                                   |
| 12, 13   | `CREATE TABLE main.plain`, then `ADD COLUMN z`           |

`sales.orders` has nested columns (a struct with a list, a map), a column with a default and a `NOT NULL` column. UUIDs, commit times and Parquet file names and sizes differ between regenerations; no test depends on them.

## Regenerating

Docker with Linux containers and network access are needed.

```powershell
pwsh test/fixtures/regenerate.ps1
pwsh test/fixtures/regenerate.ps1 -Only postgres
pwsh test/fixtures/regenerate.ps1 -OutDir "$env:TEMP\fixtures-preview"
```

Without parameters the script replaces the checked-in files. `-Only` takes `sqlite`, `duckdb` or `postgres`; `-OutDir` writes elsewhere, which is the way to try it. The script runs the generator in throw-away containers (for PostgreSQL on a private network), checks that the snapshot ids are 0 to 13, dumps only the `ducklake_*` metadata tables with `pg_dump --column-inserts`, strips the random `\restrict` lines so dumps do not differ, and removes its containers and network, also on failure. Run the tests afterwards.

`regenerate.ps1` does not write `ducklake-1.0.sqlite`, because it needs DuckDB 1.5.6. Run `generate.py sqlite` in a `python:3.12-slim` container after `pip install duckdb==1.5.6`, and copy the resulting `ducklake.sqlite` under the new name.

## The history fixture

Features that work on the history of a lake need a richer catalog. `test/fixtures/history` holds one with 57 snapshots (0 to 56), written by the same DuckDB and extension, with Parquet files, frozen like the others. It exists as SQLite, DuckDB and a PostgreSQL dump, plus an expired copy that keeps only snapshots 0, 55 and 56.

It covers a changing partitioning, a changing sort order, inserts, updates and deletes in `table_changes`, data inlining, multi-table transactions and commit messages, schema evolution (add, rename, drop, type change, struct fields), comments, dropped tables and views, scalar and table macros, and a merge of adjacent files. The README next to the fixture has one row per snapshot and all ids. A few facts matter for features built on it:

- Column ids are stable: a rename or type change keeps the `column_id`, a dropped column keeps its id, and a struct field added later is a new column with the struct as parent. A renamed table keeps its `table_id`, but its snapshot says `created_table`.
- The only tags are comments; DuckDB 2.0.0 has no SQL to write others.
- Delete files are cumulative, so "rows minus the delete count of the visible delete file" is wrong at some snapshots. The data engine returns the exact rows.
- `table_changes` resolves the table in the current schema: use `USE lake.shop` or `lake.shop.table_changes('customers', 15, 18)`.

Regenerate it with `pwsh test/fixtures/history/regenerate-history.ps1` (`-Only files` or `-Only postgres`, `-OutDir`), in PowerShell 7.3 or later with Docker and network access.

## Why the fixtures are checked in

- A test run works offline and does not depend on the version of an extension that a server offers that day.
- The files exist after a clone and open in milliseconds. The PostgreSQL variant is plain SQL, so its container needs no DuckDB.
- `postgres.sql` is text, so a regeneration shows as a reviewable diff.

## Running the PostgreSQL tests

These tests start a container, so they are opt-in: `npm run test:full` sets `AANTJE_POSTGRES=1`. Without it, `npm test` starts nothing and the PostgreSQL source reports a skip reason. With the variable set but without working Docker, the global setup prints one warning and the same suites are skipped.

The global setup (`test/support/global-setup.ts`) once per run: checks that Docker answers and removes stale containers, starts `postgres:17-alpine` as `aantje-test-pg-<8 hex digits>` with a random password, the database `ducklake` and the role `aantje` (port published as `127.0.0.1::5432`, data in a `tmpfs`), waits for the server, loads `postgres.sql`, hands the connection data to the tests with `project.provide('postgres', ...)` and removes the container in `teardown`. The browser specs do not use this setup; `test/e2e/pg.ps1` loads the same dump into a container of its own ([End-to-end tests](e2e-tests.md#postgresql-for-specs)).

## Running the Quack tests

The Quack source runs with the same switch: with `AANTJE_POSTGRES=1` and Docker, the global setup also calls `startQuack` of `test/support/quack-fixture.ts`. It builds the image of `docker/images/quack` once as `aantje-test-quack:local` (delete the image to build it again) and starts four containers `aantje-test-quack-<8 hex digits>`, each with port 9494 published as `127.0.0.1::9494` and one random token for the run:

| Fixture        | Catalog                                                                                                     | Server                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `quack`        | `ducklake.duckdb`, for the contract suites                                                                  | `test/support/quack-serve.py`, no TLS                                     |
| `quackHistory` | `history/history.duckdb`, for the history suites                                                            | `test/support/quack-serve.py`, no TLS                                     |
| `quackData`    | `data/data-catalog.duckdb`, its `data_path` rewritten to a copy of `duckdb-files/` in a temporary directory | `test/support/quack-serve.py`, no TLS                                     |
| `quackTls`     | `ducklake.duckdb`                                                                                           | the stock `serve.py` of the image: TLS with a certificate it makes itself |

A catalog is copied into the created container with `docker cp` before the start, and the server copies it to its own volume, where it may write; nothing of the checkout is mounted. The setup waits until the log says the server is serving. `test/support/sources/quack.ts` opens the explorer driver on `quack` and `quackHistory` over plain HTTP, `data-quack.test.ts` uses `quackData` and `quackTls`. A connection attempt to a port where nothing listens takes about 13 s on Windows, so a server that is not up shows as a slow failure, not a fast one.

## Containers and cleanup

- Every Docker resource of the tests is named `aantje-test-...`. The browser specs use `aantje-test-e2e-*`, the Quack servers `aantje-test-quack-*` and the image `aantje-test-quack:local`.
- Ports are published only as `127.0.0.1::<port>`.
- The PostgreSQL data directory is a `tmpfs`, so no anonymous volume is left behind.
- Passwords and the Quack token are random per run and passed to Docker by variable name, so they do not show in the process list.
- Nothing is removed in bulk and there is no `prune`. The setup removes a container only when its name starts with `aantje-test-pg-` or `aantje-test-quack-` and it is more than 15 minutes old, the leftover of a killed run. `teardown` removes the containers of the run by name and the temporary copy of the data files.
- If a container stays behind, look at it, then remove it by name:

```powershell
docker ps -a --filter "name=aantje-test-"
docker rm -f aantje-test-pg-<random> aantje-test-quack-<random>
```
