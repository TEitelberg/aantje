# Test fixtures

DuckLake catalogs that DuckDB 2.0.0 and the DuckLake extension (specification 1.1) have written. The tests read them; nothing changes them.

| File                  | Content                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `ducklake.sqlite`     | The catalog in a SQLite database file.                                                                 |
| `ducklake.duckdb`     | The same catalog in a DuckDB database file.                                                            |
| `postgres.sql`        | The same catalog as the `pg_dump` (plain `INSERT` statements) of its PostgreSQL tables.                |
| `ducklake-1.0.sqlite` | The same statements written by DuckDB 1.5.6 (specification 1.0), for the reader and the browser specs. |
| `generate.py`         | Builds a catalog. Frozen: the snapshot ids in `test/support/expected.ts` depend on its statement list. |
| `regenerate.ps1`      | Runs `generate.py` in throw-away containers and writes `ducklake.sqlite`, `ducklake.duckdb` and `postgres.sql`. |

The files are checked in, so a test run needs no network, no DuckDB extension download and no generation. `postgres.sql` is loaded into a throw-away `postgres:17-alpine` container by `test/support/global-setup.ts`, but only for `npm run test:full` (`AANTJE_POSTGRES=1`).

## Snapshots

| Snapshot | Statement                                     |
| -------- | --------------------------------------------- |
| 0        | the default schema `main`                     |
| 1        | `CREATE SCHEMA sales`                         |
| 2        | `CREATE TABLE sales.orders (...)`             |
| 3        | `CREATE TABLE sales.tmp (a INTEGER)`          |
| 4        | `INSERT` of 3 rows into `sales.orders`        |
| 5        | `INSERT` of 1 row into `sales.tmp`            |
| 6        | `DELETE FROM sales.orders WHERE id = 2`       |
| 7        | `CREATE VIEW sales.big_orders`                |
| 8        | `COMMENT ON TABLE sales.orders`               |
| 9        | `COMMENT ON COLUMN sales.orders.amount`       |
| 10       | `COMMENT ON VIEW sales.big_orders`            |
| 11       | `DROP TABLE sales.tmp`                        |
| 12       | `CREATE TABLE main.plain (x BIGINT, y VARCHAR)` |
| 13       | `ALTER TABLE main.plain ADD COLUMN z DOUBLE`  |

Ids: schemas `main` 0 and `sales` 1; tables `orders` 2, `tmp` 3 and `plain` 5; view `big_orders` 4.

## Other fixtures

- `data/`: the same statements with Parquet data files, for the tests of the data engine (`data/README.md`).
- `history/`: a second, richer catalog with 57 snapshots (partitioning, sort orders, updates, data inlining, multi-table transactions, commit messages, schema evolution, macros, a compaction, an expired copy) and its Parquet files, as sqlite, duckdb and PostgreSQL dump. Frozen like this one; the snapshot table, the object ids and the regeneration are in `history/README.md`. Its Docker resources are named `aantje-test-histgen`, `aantje-test-histpg` and `aantje-test-histnet`.

## Regenerate

Needs Docker (Linux containers) and network access. Run it from the project root in PowerShell 7.3 or later:

```powershell
pwsh test/fixtures/regenerate.ps1
pwsh test/fixtures/regenerate.ps1 -Only postgres
pwsh test/fixtures/regenerate.ps1 -OutDir "$env:TEMP\fixtures-preview"
```

`-Only` takes `sqlite`, `duckdb` or `postgres`. `-OutDir` writes somewhere else (created if it does not exist) instead of replacing the checked-in files. UUIDs, commit times and the Parquet file names and sizes differ on every run; the tests do not depend on them. Run the whole test suite after a regeneration.

Docker resources of the script are named `aantje-test-net`, `aantje-test-pgfx` and `aantje-test-gen` and are removed at the end. The test containers are named `aantje-test-pg-<random>`, publish their port only on `127.0.0.1`, and are removed by the teardown; the next run also removes such containers that are older than 15 minutes. Details: `docs/en/test-fixtures.md`.

## The specification 1.0 catalog

`ducklake-1.0.sqlite` is the same statement list, written by `duckdb==1.5.6`, which writes DuckLake specification 1.0 (`ducklake_metadata.version` is `1.0`; the others say `1.1`). Only the Parquet file sizes differ. `test/contract/reader.contract.test.ts` compares it with `ducklake.sqlite`; the browser specs `files-errors` and `tree-features` open it in code-server. `regenerate.ps1` does not write it, because it needs another DuckDB version. Regenerate it by hand, from the project root in PowerShell, with the same `generate.py`:

```powershell
$out = "$env:TEMP\aantje-fx10"; New-Item -ItemType Directory -Force $out | Out-Null
docker run --rm --name aantje-test-fx10 -v "${PWD}\test\fixtures:/fx:ro" -v "${out}:/out" python:3.12-slim sh -c "pip install -q duckdb==1.5.6 && python -I /fx/generate.py sqlite --out /out"
Copy-Item "$out\ducklake.sqlite" test\fixtures\ducklake-1.0.sqlite
Remove-Item -Recurse -Force $out
```
