"""Builds the DuckLake history fixture of the aantje tests with the real DuckDB + ducklake extension.

Run inside a container (see README.md), never on the host:

    python generate-history.py sqlite   --out /out
    python generate-history.py duckdb   --out /out
    python generate-history.py postgres --dsn "host=... port=... dbname=... user=... password=..."

The statement list is fixed, so the snapshot ids and object ids are the same for every backend (see
test/support/expected-history.ts). `sqlite` and `duckdb` write the catalog and its Parquet files (relative data path
`sqlite-files/` / `duckdb-files/`, resolved against the working directory of the reader). `sqlite` also writes
`history-expired.sqlite`: a copy of the catalog after `ducklake_expire_snapshots`. `postgres` writes metadata only.
"""

import argparse
import os
import shutil

import duckdb

SNAPSHOTS = 57
EXPIRE_UNTIL = 55  # snapshots 1..54 are expired; the compaction of shop.log (55) and the insert after it stay


def attach_sql(backend: str, dsn: str) -> str:
    options = "DATA_INLINING_ROW_LIMIT 0"
    if backend == "sqlite":
        return f"ATTACH 'ducklake:sqlite:history.sqlite' AS lake (DATA_PATH 'sqlite-files/', {options})"
    if backend == "duckdb":
        return f"ATTACH 'ducklake:history.duckdb' AS lake (DATA_PATH 'duckdb-files/', {options})"
    return f"ATTACH 'ducklake:postgres:{dsn}' AS lake (DATA_PATH '/tmp/aantje-fixture-data/', {options})"


def build(con: duckdb.DuckDBPyConnection) -> None:
    run = con.execute

    def transaction(*statements: str) -> None:
        run("BEGIN")
        for statement in statements:
            run(statement)
        run("COMMIT")

    run("USE lake")

    # Schemas: shop is kept, scratch is created and dropped again.
    run("CREATE SCHEMA shop")
    run("CREATE SCHEMA scratch")
    run("DROP SCHEMA scratch")

    # shop.events: partitioned, the partitioning changes once, files of uneven size.
    run(
        """CREATE TABLE shop.events (
            id INTEGER NOT NULL, kind VARCHAR, ts TIMESTAMP, amount DECIMAL(10,2)
        )"""
    )
    run("ALTER TABLE shop.events SET PARTITIONED BY (kind, year(ts))")
    run(
        """INSERT INTO shop.events VALUES
            (1, 'click', TIMESTAMP '2025-03-01 10:00:00', 1.50),
            (2, 'click', TIMESTAMP '2025-03-02 10:00:00', 2.50),
            (3, 'click', TIMESTAMP '2025-03-03 10:00:00', 3.50),
            (4, 'view',  TIMESTAMP '2025-04-01 10:00:00', 4.50),
            (5, 'view',  TIMESTAMP '2025-04-02 10:00:00', 5.50),
            (6, 'click', TIMESTAMP '2026-01-05 10:00:00', 6.50)"""
    )
    run("INSERT INTO shop.events VALUES (7, 'view', TIMESTAMP '2026-01-06 10:00:00', 7.50)")
    run(
        """INSERT INTO shop.events
           SELECT 100 + i, 'click', TIMESTAMP '2025-06-01 00:00:00' + to_hours(i), CAST(i * 1.5 AS DECIMAL(10,2))
           FROM range(40) t(i)"""
    )
    run("ALTER TABLE shop.events SET PARTITIONED BY (kind, month(ts))")
    run(
        """INSERT INTO shop.events VALUES
            (8,  'click', TIMESTAMP '2026-03-05 10:00:00', 8.50),
            (9,  'click', TIMESTAMP '2026-03-06 10:00:00', 9.50),
            (10, 'view',  TIMESTAMP '2026-03-07 10:00:00', 10.50),
            (11, 'click', TIMESTAMP '2026-04-01 10:00:00', 11.50)"""
    )

    # shop.readings: a sort order that changes once.
    run("CREATE TABLE shop.readings (sensor VARCHAR, taken_at TIMESTAMP, value DOUBLE)")
    run("ALTER TABLE shop.readings SET SORTED BY (sensor ASC, taken_at DESC)")
    run(
        """INSERT INTO shop.readings VALUES
            ('b', TIMESTAMP '2026-02-01 00:00:00', 2.5),
            ('a', TIMESTAMP '2026-02-01 00:00:00', 1.5),
            ('a', TIMESTAMP '2026-02-02 00:00:00', 3.5),
            ('b', TIMESTAMP '2026-02-02 00:00:00', 0.5)"""
    )
    run("ALTER TABLE shop.readings SET SORTED BY (value DESC NULLS FIRST)")

    # shop.customers: real data files with insert, update and delete.
    run("CREATE TABLE shop.customers (id INTEGER NOT NULL, name VARCHAR, tier VARCHAR)")
    run(
        """INSERT INTO shop.customers VALUES
            (1, 'ada', 'bronze'), (2, 'bob', 'bronze'), (3, 'cy', 'silver'), (4, 'di', 'silver')"""
    )
    run("UPDATE shop.customers SET tier = 'gold' WHERE id = 2")
    run("DELETE FROM shop.customers WHERE id = 4")

    # shop.notes: the only table with data inlining (rows stay in the catalog). The option takes no snapshot.
    run("CREATE TABLE shop.notes (id INTEGER, body VARCHAR)")
    run("CALL lake.set_option('data_inlining_row_limit', 10, schema => 'shop', table_name => 'notes')")
    run("INSERT INTO shop.notes VALUES (1, 'first'), (2, 'second'), (3, 'third')")
    run("UPDATE shop.notes SET body = 'changed' WHERE id = 1")
    run("DELETE FROM shop.notes WHERE id = 3")

    # Transactions: two tables in one snapshot; a table that is created and filled in one snapshot.
    transaction(
        "INSERT INTO shop.customers VALUES (5, 'eve', 'silver')",
        "INSERT INTO shop.events VALUES (12, 'view', TIMESTAMP '2026-04-02 10:00:00', 12.50)",
    )
    transaction(
        "CREATE TABLE shop.audit (id INTEGER, note VARCHAR)",
        "INSERT INTO shop.audit VALUES (1, 'created together with its first row')",
    )

    # Commit metadata.
    transaction(
        "CALL lake.set_commit_message('tillmann', 'Nightly import', extra_info => '{\"source\":\"nightly\",\"rows\":1}')",
        "INSERT INTO shop.customers VALUES (6, 'flo', 'bronze')",
    )

    # main.evolving: schema evolution, the table is renamed at the end.
    run("CREATE TABLE main.evolving (id INTEGER, name VARCHAR, info STRUCT(a INTEGER, b VARCHAR), n INTEGER)")
    run("INSERT INTO main.evolving VALUES (1, 'one', {'a': 1, 'b': 'x'}, 10)")
    run("ALTER TABLE main.evolving ADD COLUMN extra DOUBLE")
    run("ALTER TABLE main.evolving RENAME COLUMN name TO title")
    run("ALTER TABLE main.evolving ALTER COLUMN n TYPE BIGINT")
    run("ALTER TABLE main.evolving DROP COLUMN extra")
    run("ALTER TABLE main.evolving ADD COLUMN info.c DOUBLE")
    run("ALTER TABLE main.evolving ADD COLUMN flag BOOLEAN DEFAULT false")
    run("ALTER TABLE main.evolving ALTER COLUMN flag SET DEFAULT true")
    run("ALTER TABLE main.evolving RENAME TO evolved")
    run("INSERT INTO main.evolved VALUES (2, 'two', {'a': 2, 'b': 'y', 'c': 2.5}, 20, false)")

    # Comments (DuckLake has no other way to write tags), views.
    run("COMMENT ON TABLE shop.customers IS 'Customers of the shop'")
    run("COMMENT ON COLUMN shop.customers.tier IS 'bronze, silver or gold'")
    run("CREATE VIEW shop.big_events AS SELECT * FROM shop.events WHERE amount > 10")
    run("COMMENT ON VIEW shop.big_events IS 'Events above 10'")
    run("CREATE VIEW shop.tmp_view AS SELECT 1 AS x")
    run("DROP VIEW shop.tmp_view")

    # A dropped table that had data.
    run("CREATE TABLE shop.old_stuff (x INTEGER)")
    run("INSERT INTO shop.old_stuff VALUES (1), (2)")
    run("DROP TABLE shop.old_stuff")

    # Macros: scalar with a default parameter, table macro, and a scalar macro that is dropped again.
    run("CREATE MACRO shop.gross(net, rate := 1.19) AS net * rate")
    run("CREATE MACRO shop.recent_events(n) AS TABLE SELECT * FROM shop.events ORDER BY ts DESC LIMIT n")
    run("CREATE MACRO shop.legacy_fee(x) AS x + 1")
    run("DROP MACRO shop.legacy_fee")

    # shop.log: four small files that the compaction merges into one (the four old files are scheduled for deletion).
    run("CREATE TABLE shop.log (id INTEGER, msg VARCHAR)")
    for i in range(1, 5):
        run(f"INSERT INTO shop.log VALUES ({i}, 'line {i}')")
    run("CALL ducklake_merge_adjacent_files('lake', 'log', schema => 'shop')")
    run("INSERT INTO shop.log VALUES (5, 'line 5')")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("backend", choices=["sqlite", "duckdb", "postgres"])
    parser.add_argument("--out", default="/out")
    parser.add_argument("--dsn", default="")
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)
    os.chdir(args.out)
    print("duckdb", duckdb.__version__)
    if args.backend != "postgres":
        for leftover in (f"history.{args.backend}", f"{args.backend}-files"):
            if os.path.isdir(leftover):
                shutil.rmtree(leftover)
            elif os.path.exists(leftover):
                os.remove(leftover)

    extension = {"sqlite": "sqlite", "duckdb": None, "postgres": "postgres"}[args.backend]
    con = duckdb.connect()
    con.execute("INSTALL ducklake")
    con.execute("LOAD ducklake")
    if extension:
        con.execute(f"INSTALL {extension}")
        con.execute(f"LOAD {extension}")
    con.execute(attach_sql(args.backend, args.dsn))
    build(con)
    rows = con.execute(
        "SELECT snapshot_id, changes_made, author, commit_message, commit_extra_info "
        "FROM __ducklake_metadata_lake.ducklake_snapshot_changes ORDER BY 1"
    ).fetchall()
    for row in rows:
        print(row)
    assert [row[0] for row in rows] == list(range(SNAPSHOTS)), [row[0] for row in rows]
    con.close()

    if args.backend == "sqlite":
        shutil.copy("history.sqlite", "history-expired.sqlite")
        con = duckdb.connect()
        for statement in ("INSTALL ducklake", "LOAD ducklake", "INSTALL sqlite", "LOAD sqlite"):
            con.execute(statement)
        con.execute("ATTACH 'ducklake:sqlite:history-expired.sqlite' AS lake")
        versions = ",".join(str(i) for i in range(1, EXPIRE_UNTIL))
        con.execute(f"CALL ducklake_expire_snapshots('lake', versions => [{versions}])")
        con.close()

    for root, _, names in os.walk("."):
        for name in sorted(names):
            path = os.path.join(root, name)
            print(path, os.path.getsize(path))


if __name__ == "__main__":
    main()
