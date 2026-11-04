# Data fixtures

DuckLakes WITH their Parquet data files, for the tests of `src/data` (and the real-execution test of the notebook). The metadata-only catalogs one directory up have no data files.

| Path                  | Content                                                                          |
| --------------------- | -------------------------------------------------------------------------------- |
| `data-catalog.sqlite` | The DuckLake with SQLite metadata.                                               |
| `data-catalog.duckdb` | The same DuckLake with DuckDB metadata.                                          |
| `sqlite-files/`       | Parquet data and delete files of `data-catalog.sqlite` (`sales/orders/...`).     |
| `duckdb-files/`       | Parquet data and delete files of `data-catalog.duckdb`.                          |
| `generate-data.py`    | Builds both. It replays the statement list of `../generate.py`, so the snapshot ids and table ids are those of `test/support/expected.ts`: `sales.orders` has 3 rows at snapshots 4 and 5 and 2 rows from snapshot 6 on (order 2 is deleted). `sales.tmp` has 1 row. |
| `regenerate-data.ps1` | Runs `generate-data.py` in a throw-away `python:3.12-slim` container named `aantje-test-datagen` (DuckDB 2.0.0) and copies the result here. |

The catalogs were written with `DATA_INLINING_ROW_LIMIT 0`, so inserts and deletes create Parquet files.

## The data path is relative

The `data_path` stored in the metadata is `sqlite-files/` and `duckdb-files/`. DuckLake resolves a relative data path against the working directory of the process that reads the catalog, not against the catalog file. A reader started from another directory does not find the files. The checked-in fixture therefore cannot be attached in place from everywhere. Two ways to use it:

- Run the reader with this directory as working directory (what a notebook run in a container can do: mount this directory and `cd` into it).
- Copy the fixture and rewrite the row in the copy, which is what the unit tests do (`copyDataFixture` in `test/unit/data-support.ts`):

```sql
UPDATE ducklake_metadata SET value = '/absolute/path/to/copy/sqlite-files/' WHERE key = 'data_path';
```

The path must end with `/`, also on Windows (use forward slashes).

## Regenerate

Needs Docker and network access. From the project root, in PowerShell 7.3 or later:

```powershell
pwsh test/fixtures/data/regenerate-data.ps1
pwsh test/fixtures/data/regenerate-data.ps1 -OutDir "$env:TEMP\data-fixtures-preview"
```

The UUIDs in the Parquet file names, the commit times and the file sizes differ on every run; the tests do not depend on them. Run `npx vitest run test/unit/data-` after a regeneration.
