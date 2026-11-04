"""``oog-sql``: run SQL against the Oog lake from a terminal (the image has no DuckDB CLI).

    oog-sql "SELECT 42 AS answer"
    oog-sql -f query.sql [--csv]
    echo "SELECT 42" | oog-sql

The DuckLake is attached and selected (see ``oog.connect``), so tables need no catalog prefix.
Exit code: 0 ok, 1 SQL error, 2 configuration or usage error (invalid OOG_* settings, lake not
reachable, no SQL given). Credentials are scrubbed from every message.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from typing import Any

import duckdb

from oog.config import Settings
from oog.duck import connect, redact


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="oog-sql",
        description="Run SQL against the Oog DuckLake. Without SQL text or -f, SQL is read from stdin.",
    )
    parser.add_argument("sql", nargs="?", help="SQL text (several statements separated by ';')")
    parser.add_argument("-f", "--file", metavar="FILE", help="read SQL from FILE ('-' = stdin)")
    parser.add_argument("--csv", action="store_true", help="print results as CSV instead of a table")
    parser.add_argument(
        "--max-rows", type=int, default=1000, metavar="N", help="rows shown per table result (default 1000, 0 = all)"
    )
    args = parser.parse_args(argv)
    if args.sql is not None and args.file is not None:
        parser.error("give either SQL text or -f FILE, not both")

    try:
        sql = _read_sql(args.sql, args.file)
    except OSError as exc:
        return _fail(f"cannot read {args.file}: {exc.strerror}", 2)
    if not sql.strip():
        return _fail("no SQL given (pass SQL text, -f FILE, or pipe SQL to stdin)", 2)

    try:
        settings = Settings.from_env()
    except ValueError as exc:
        return _fail(f"invalid OOG_* settings - {exc}", 2)
    try:
        con = connect(settings)
    except Exception as exc:
        return _fail(redact(str(exc), settings), 2)
    try:
        return _run(con, sql, settings, as_csv=args.csv, max_rows=args.max_rows)
    except BrokenPipeError:  # e.g. `oog-sql ... | head`
        os.dup2(os.open(os.devnull, os.O_WRONLY), sys.stdout.fileno())
        return 0
    finally:
        con.close()


def _read_sql(text: str | None, path: str | None) -> str:
    if path is not None and path != "-":
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    if text is not None:
        return text
    if path is None and sys.stdin.isatty():
        return ""  # nothing piped in: do not wait for a terminal
    return sys.stdin.read()


def _fail(message: str, code: int) -> int:
    print(f"oog-sql: {message}", file=sys.stderr)
    return code


def _run(con: duckdb.DuckDBPyConnection, sql: str, settings: Settings, *, as_csv: bool, max_rows: int) -> int:
    try:
        statements = [(st.query, st.type) for st in con.extract_statements(sql)]
    except Exception as exc:
        return _fail(redact(str(exc), settings), 1)
    shown = 0
    for query, kind in statements:
        try:
            con.execute(query)
            if con.description is None:
                continue
            header = [col[0] for col in con.description]
            limit = 10000 if as_csv else max_rows + 1 if max_rows > 0 else None
            rows = con.fetchmany(limit) if limit else con.fetchall()
            if not rows and header in (["Success"], ["Count"]) and kind != duckdb.StatementType.SELECT:
                continue  # DDL and similar: nothing to show
            if as_csv:
                _print_csv(con, header, rows)
            else:
                if shown:
                    print()
                _print_table(header, rows, max_rows)
            shown += 1
        except BrokenPipeError:
            raise
        except Exception as exc:
            return _fail(redact(str(exc), settings), 1)
    sys.stdout.flush()
    return 0


def _text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


def _cell(value: Any) -> str:
    return "NULL" if value is None else _text(value).replace("\n", "\\n")


def _print_table(header: list[str], rows: list[tuple[Any, ...]], max_rows: int) -> None:
    more = max_rows > 0 and len(rows) > max_rows
    if more:
        rows = rows[:max_rows]
    cells = [[_cell(v) for v in row] for row in rows]
    widths = [max([len(name), *(len(row[i]) for row in cells)]) for i, name in enumerate(header)]
    rule = "+" + "+".join("-" * (w + 2) for w in widths) + "+"

    def line(values: list[str]) -> str:
        return "| " + " | ".join(v.ljust(w) for v, w in zip(values, widths, strict=True)) + " |"

    print(rule)
    print(line(header))
    print(rule)
    for row in cells:
        print(line(row))
    print(rule)
    note = ", more not shown; --max-rows 0 shows all" if more else ""
    print(f"({len(rows)} row{'s' if len(rows) != 1 else ''}{note})")


def _print_csv(con: duckdb.DuckDBPyConnection, header: list[str], rows: list[tuple[Any, ...]]) -> None:
    writer = csv.writer(sys.stdout, lineterminator="\n")
    writer.writerow(header)
    while rows:
        writer.writerows([["" if v is None else _text(v) for v in row] for row in rows])
        rows = con.fetchmany(10000)


if __name__ == "__main__":
    raise SystemExit(main())
