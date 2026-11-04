"""IPython extension: ``%load_ext oog`` provides ``con`` and the ``%sql`` / ``%%sql`` magics."""

from __future__ import annotations

import contextlib
import os
import sys
from typing import TYPE_CHECKING, Any

from oog.config import Settings
from oog.duck import connect, quote_ident

if TYPE_CHECKING:
    from IPython.core.interactiveshell import InteractiveShell

_SQL_CONNECTION_VAR = "_oog_sql_connection"


class _LakeCursors:
    """DB-API facade for jupysql.

    jupysql runs every query on ``connection.cursor()``. A DuckDB cursor is a new connection that
    starts in the default in-memory catalog, so each one first switches to the DuckLake (if given).
    Each cursor also scans all Python frames, so ``%sql ... FROM df`` finds notebook DataFrames:
    jupysql 0.11 enables that only for connections with ``.pl()``, which DuckDB 2.0 dropped.
    """

    def __init__(self, con: Any, catalog: str | None = None):
        self._con = con
        self._use = f"USE {quote_ident(catalog)}" if catalog else None

    def cursor(self) -> Any:
        cursor = self._con.cursor()
        if self._use:
            cursor.execute(self._use)
        cursor.execute("SET python_scan_all_frames=true")
        return cursor

    def __getattr__(self, name: str) -> Any:
        return getattr(self._con, name)


def load_ipython_extension(ip: InteractiveShell) -> None:
    try:
        settings = Settings.from_env()
    except ValueError as exc:
        _show_once(
            ip,
            f"oog: invalid OOG_* settings - {exc}\n"
            "    Fix the variable (e.g. %env OOG_PG_PORT=5432), then run: %reload_ext oog",
        )
        return
    notice = None
    con = sql_connection = None
    try:
        con = connect(settings)
        sql_connection = _LakeCursors(con, settings.ducklake_name)
    except Exception as exc:
        # Keep the kernel usable (con without lake) and tell the user once, in the first cell output.
        notice = (
            f"oog: DuckLake {settings.ducklake_name!r} is not attached - {str(exc).strip()}\n"
            "    Fix the cause, then run: %reload_ext oog"
        )
        try:
            con = connect(settings, attach=False)
            sql_connection = _LakeCursors(con)
        except Exception:
            pass  # e.g. extensions missing: the notice above names the cause

    if sql_connection is not None:
        # jupysql (ploomber-core) sends telemetry and checks PyPI for new versions unless told otherwise
        os.environ.setdefault("PLOOMBER_STATS_ENABLED", "false")
        os.environ.setdefault("PLOOMBER_VERSION_CHECK_DISABLED", "1")
        if "sql" not in ip.extension_manager.loaded:
            ip.run_line_magic("load_ext", "sql")
        ip.run_line_magic("config", "SqlMagic.displaycon = False")
        ip.user_ns[_SQL_CONNECTION_VAR] = sql_connection
        ip.run_line_magic("sql", f"{_SQL_CONNECTION_VAR} --alias oog")
        ip.user_ns["con"] = con
    if notice:
        _show_once(ip, notice)


def unload_ipython_extension(ip: InteractiveShell) -> None:
    # close only our own connection: the user may have rebound `con` to something else
    sql_connection = ip.user_ns.pop(_SQL_CONNECTION_VAR, None)
    own = getattr(sql_connection, "_con", sql_connection)
    if own is not None and ip.user_ns.get("con") is own:
        ip.user_ns.pop("con")
    if own is not None:
        with contextlib.suppress(Exception):
            own.close()


def _show_once(ip: InteractiveShell, message: str) -> None:
    def hook(result: Any = None) -> None:
        ip.events.unregister("post_run_cell", hook)
        print(message, file=sys.stderr)

    ip.events.register("post_run_cell", hook)
