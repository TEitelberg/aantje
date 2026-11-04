"""Builds the DuckLake catalog fixtures of the aantje tests with the real DuckDB + ducklake extension.

Run inside a container (see README.md), never on the host:

    python generate.py sqlite   --out /out
    python generate.py duckdb   --out /out
    python generate.py postgres --dsn "host=... port=... dbname=... user=... password=..."

The statement sequence is fixed, so the snapshot ids are the same for every backend (see expected.ts).
"""

import argparse
import os

import duckdb

DATA_PATH = "/tmp/aantje-fixture-data/"


def attach_sql(backend: str, out: str, dsn: str) -> str:
    options = f"(DATA_PATH '{DATA_PATH}', DATA_INLINING_ROW_LIMIT 0)"
    if backend == "sqlite":
        return f"ATTACH 'ducklake:sqlite:{out}/ducklake.sqlite' AS lake {options}"
    if backend == "duckdb":
        return f"ATTACH 'ducklake:{out}/ducklake.duckdb' AS lake {options}"
    return f"ATTACH 'ducklake:postgres:{dsn}' AS lake {options}"


def build(con: duckdb.DuckDBPyConnection) -> None:
    run = con.execute
    run("USE lake")
    run("CREATE SCHEMA sales")
    run(
        """CREATE TABLE sales.orders (
            id INTEGER NOT NULL,
            customer STRUCT(name VARCHAR, tags VARCHAR[]),
            attrs MAP(VARCHAR, INTEGER),
            amount DECIMAL(10,2) DEFAULT 0,
            created TIMESTAMP
        )"""
    )
    run("CREATE TABLE sales.tmp (a INTEGER)")
    run(
        """INSERT INTO sales.orders VALUES
            (1, {'name': 'a', 'tags': ['x']}, MAP {'k': 1}, 1.50, TIMESTAMP '2026-01-01 00:00:00'),
            (2, {'name': 'b', 'tags': []}, MAP {}, 2.50, TIMESTAMP '2026-01-02 00:00:00'),
            (3, NULL, NULL, 3.00, TIMESTAMP '2026-01-03 00:00:00')"""
    )
    run("INSERT INTO sales.tmp VALUES (1)")
    run("DELETE FROM sales.orders WHERE id = 2")
    run("CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE amount > 1")
    run("COMMENT ON TABLE sales.orders IS 'Customer orders'")
    run("COMMENT ON COLUMN sales.orders.amount IS 'Net amount in EUR'")
    run("COMMENT ON VIEW sales.big_orders IS 'Orders above 1'")
    run("DROP TABLE sales.tmp")
    run("CREATE TABLE main.plain (x BIGINT, y VARCHAR)")
    run("ALTER TABLE main.plain ADD COLUMN z DOUBLE")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend", choices=["sqlite", "duckdb", "postgres"])
    parser.add_argument("--out", default="/out")
    parser.add_argument("--dsn", default="")
    args = parser.parse_args()

    for name in ("ducklake.sqlite", "ducklake.duckdb"):
        path = os.path.join(args.out, name)
        if args.backend in name and os.path.exists(path):
            os.remove(path)

    con = duckdb.connect()
    print("duckdb", duckdb.__version__)
    extension = {"sqlite": "sqlite", "duckdb": None, "postgres": "postgres"}[args.backend]
    con.execute("INSTALL ducklake")
    con.execute("LOAD ducklake")
    if extension:
        con.execute(f"INSTALL {extension}")
        con.execute(f"LOAD {extension}")
    con.execute(attach_sql(args.backend, args.out, args.dsn))
    build(con)
    for row in con.execute("SELECT snapshot_id, changes_made FROM __ducklake_metadata_lake.ducklake_snapshot_changes ORDER BY 1").fetchall():
        print(row)
    con.close()


if __name__ == "__main__":
    main()
