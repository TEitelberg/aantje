"""Builds the DuckLake data fixtures of the aantje tests: catalogs WITH their Parquet data files.

Run inside a container (see README.md), never on the host:

    python generate-data.py --out /out

It replays the statement list of ../generate.py, so the snapshot ids and ids of tables are those of the metadata-only
fixtures (see test/support/expected.ts). Writes into --out:

    data-catalog.sqlite   DuckLake with SQLite metadata
    data-catalog.duckdb   DuckLake with DuckDB metadata
    sqlite-files/         Parquet files of data-catalog.sqlite
    duckdb-files/         Parquet files of data-catalog.duckdb

The data path in the metadata is RELATIVE (`sqlite-files/`, `duckdb-files/`). DuckLake resolves it against the working
directory of the reader, not against the catalog, so the tests copy the fixture to a temporary directory and rewrite
the `data_path` row there (test/unit/data-support.ts).
"""

import argparse
import os
import shutil
import sys

import duckdb

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from generate import build  # noqa: E402

CATALOGS = {
    "sqlite": ("data-catalog.sqlite", "ducklake:sqlite:data-catalog.sqlite", "sqlite-files/"),
    "duckdb": ("data-catalog.duckdb", "ducklake:data-catalog.duckdb", "duckdb-files/"),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/out")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.chdir(args.out)
    print("duckdb", duckdb.__version__)
    for backend, (catalog, target, files) in CATALOGS.items():
        for leftover in (catalog, files.rstrip("/")):
            if os.path.isdir(leftover):
                shutil.rmtree(leftover)
            elif os.path.exists(leftover):
                os.remove(leftover)
        con = duckdb.connect()
        con.execute("INSTALL ducklake")
        con.execute("LOAD ducklake")
        if backend == "sqlite":
            con.execute("INSTALL sqlite")
            con.execute("LOAD sqlite")
        con.execute(f"ATTACH '{target}' AS lake (DATA_PATH '{files}', DATA_INLINING_ROW_LIMIT 0)")
        build(con)
        snapshots = con.execute(
            "SELECT string_agg(snapshot_id::VARCHAR, ',' ORDER BY snapshot_id) "
            "FROM __ducklake_metadata_lake.ducklake_snapshot"
        ).fetchone()[0]
        assert snapshots == ",".join(str(i) for i in range(14)), snapshots
        con.close()
    for root, _, names in os.walk("."):
        for name in sorted(names):
            path = os.path.join(root, name)
            print(path, os.path.getsize(path))


if __name__ == "__main__":
    main()
