"""DuckDB connection with the DuckLake catalog attached (Postgres metadata, Parquet files on RustFS)."""

from __future__ import annotations

import os
import tempfile
import warnings
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from oog.config import Settings

if TYPE_CHECKING:
    from collections.abc import Callable

    import duckdb

EXTENSIONS = ("httpfs", "postgres", "ducklake", "quack")
EXTENSION_DIR_VAR = "OOG_DUCKDB_EXTENSION_DIR"
S3_SECRET = "oog_s3"
PG_SECRET = "oog_pg"
QUACK_SECRET = "oog_quack"


def extension_dir() -> str | None:
    """Directory holding the pre-installed DuckDB extensions (``$OOG_DUCKDB_EXTENSION_DIR``), if set."""
    return os.environ.get(EXTENSION_DIR_VAR, "").strip() or None


def connect(settings: Settings | None = None, *, attach: bool = True, lake: str = "postgres") -> duckdb.DuckDBPyConnection:
    """Open an in-memory DuckDB connection wired to the Oog stack.

    Loads httpfs/postgres/ducklake from the pre-installed extension directory (connect() itself
    downloads nothing; DuckDB's default auto-install of other core extensions stays enabled),
    registers a temporary S3 secret for RustFS and, with ``attach=True``, attaches the DuckLake
    as ``settings.ducklake_name`` and makes it the default catalog. With ``settings.quack_token`` the DuckLake that a DuckDB
    server serves over Quack is attached as ``settings.quack_name`` as well (a failure only warns). Spill files go to a private
    directory under the system temp dir, not into the working directory.

    ``lake="quack"`` attaches only the Quack-served DuckLake (``settings.quack_name``) and makes it the default catalog:
    no Postgres secret, no Postgres catalog, and a failure to attach it is an error, not a warning (it needs
    ``settings.quack_token``).

    Small inserts are not inlined into the Postgres catalog, so every insert writes Parquet files
    that other engines and tools can read: ``DATA_INLINING_ROW_LIMIT 0`` in the ATTACH, plus (once per catalog)
    ``set_option('data_inlining_row_limit', 0)``, which is stored in the catalog and so also
    holds for other clients of it. Rows that were inlined earlier stay in the catalog until
    ``CALL ducklake_flush_inlined_data('<name>')`` runs. A different value stored in the catalog
    by someone else takes precedence over the ATTACH option, and is replaced by the call above.

    Note: ``con.cursor()`` returns a new connection that starts in the default in-memory
    catalog again; run ``USE <name>`` on it (or qualify table names).
    """
    import duckdb

    if lake not in ("postgres", "quack"):
        raise ValueError(f"lake must be 'postgres' or 'quack', not {lake!r}")
    s = settings or Settings.from_env()
    if attach and lake == "quack" and not s.quack_token:
        raise RuntimeError("lake='quack' needs the Quack token: OOG_QUACK_TOKEN is not set")
    ext_dir = extension_dir()
    # DuckDB spills to a relative ".tmp" by default, i.e. into the notebook folder (a bind mount under Compose)
    spill = os.path.join(tempfile.gettempdir(), "oog-duckdb")
    os.makedirs(spill, mode=0o700, exist_ok=True)
    config = {"temp_directory": spill}
    if ext_dir:
        config["extension_directory"] = ext_dir
    con = duckdb.connect(":memory:", config=config)
    try:
        for name in EXTENSIONS:
            _load(con, name, ext_dir)
        _run(con, lambda: _s3_secret_sql(s), "creating the S3 secret", s)
        if attach and lake == "quack":
            _attach_quack(con, s, strict=True)
            con.execute(f"USE {quote_ident(s.quack_name)}")
        elif attach:
            _run(con, lambda: _pg_secret_sql(s), "creating the Postgres secret", s)
            _run(con, lambda: _attach_sql(s), f"attaching DuckLake {s.ducklake_name!r}", s)
            _disable_inlining(con, s.ducklake_name)
            _attach_quack(con, s)
            con.execute(f"USE {quote_ident(s.ducklake_name)}")
    except BaseException:
        con.close()
        raise
    return con


def _load(con: duckdb.DuckDBPyConnection, name: str, ext_dir: str | None) -> None:
    try:
        con.execute(f"LOAD {name}")
    except Exception as exc:
        where = ext_dir or "the default DuckDB extension directory"
        raise RuntimeError(
            f"DuckDB extension {name!r} is not available in {where}; "
            f"install it once (needs internet) with: python -m oog.install_extensions\n{exc}"
        ) from None


def _run(con: duckdb.DuckDBPyConnection, build: Callable[[], str], what: str, s: Settings) -> None:
    # DuckDB errors may quote the failing statement, so scrub credentials before re-raising.
    # The statement is built here from a callable, so no frame (e.g. IPython's verbose traceback)
    # holds the credentials or the SQL text.
    try:
        con.execute(build())
    except Exception as exc:
        raise RuntimeError(f"{what} failed: {redact(str(exc), s)}") from None


def _attach_quack(con: duckdb.DuckDBPyConnection, s: Settings, *, strict: bool = False) -> None:
    """Attach the Quack-served DuckLake as ``s.quack_name`` (only with a token). A failure is a warning (the kernel stays usable), with ``strict`` an error."""
    if not s.quack_token:
        return
    try:
        if s.quack_ca_file:
            # Quack clients use TLS for every host but localhost; the server's certificate is self-signed.
            _run(con, lambda: f"SET GLOBAL ca_cert_file = {_lit(s.quack_ca_file)}", "setting the Quack CA file", s)
        host = f"{s.quack_host}:{int(s.quack_port)}"
        _run(con, lambda: f"CREATE OR REPLACE TEMPORARY SECRET {QUACK_SECRET} (TYPE quack, TOKEN {_lit(s.quack_token)}, SCOPE {_lit('quack:' + host)})", "creating the Quack secret", s)
        _run(
            con,
            lambda: f"ATTACH {_lit('ducklake:quack:' + host)} AS {quote_ident(s.quack_name)} "
            f"(DATA_PATH {_lit(s.quack_data_path)}, DATA_INLINING_ROW_LIMIT 0)",
            f"attaching the Quack DuckLake {s.quack_name!r}",
            s,
        )
        _disable_inlining(con, s.quack_name)
    except RuntimeError as exc:
        if strict:
            raise
        warnings.warn(f"oog: {exc}", RuntimeWarning, stacklevel=3)


def _disable_inlining(con: duckdb.DuckDBPyConnection, catalog: str) -> None:
    """Store ``data_inlining_row_limit = 0`` in the catalog (once; no snapshot), so every client benefits."""
    q = quote_ident(catalog)
    try:
        query = f"SELECT value FROM {q}.options() WHERE option_name = 'data_inlining_row_limit'"
        rows = con.execute(query).fetchall()
        if [v for (v,) in rows] != ["0"]:
            con.execute(f"CALL {q}.set_option('data_inlining_row_limit', 0)")
    except Exception:
        pass  # concurrent first start or read-only catalog: the ATTACH option still covers this session


def redact(text: str, s: Settings) -> str:
    """Replace the credentials of ``s`` in ``text`` by ``***``."""
    secrets = (s.s3_access_key, s.s3_secret_key, s.pg_password, s.quack_token)
    for secret in sorted(filter(None, secrets), key=len, reverse=True):
        text = text.replace(secret, "***").replace(secret.replace("'", "''"), "***")
    return text


def _lit(value: object) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _s3_secret_sql(s: Settings) -> str:
    # DuckDB wants the endpoint without scheme; the scheme only decides USE_SSL.
    url = urlsplit(s.s3_endpoint if "://" in s.s3_endpoint else "http://" + s.s3_endpoint)
    endpoint = (url.netloc + url.path).rstrip("/")
    return (
        f"CREATE OR REPLACE TEMPORARY SECRET {S3_SECRET} (TYPE s3, "
        f"KEY_ID {_lit(s.s3_access_key)}, SECRET {_lit(s.s3_secret_key)}, REGION {_lit(s.s3_region)}, "
        f"ENDPOINT {_lit(endpoint)}, URL_STYLE 'path', USE_SSL {'true' if url.scheme == 'https' else 'false'})"
    )


def _pg_secret_sql(s: Settings) -> str:
    # A secret keeps the password out of duckdb_databases().path and out of the ATTACH string.
    # CONNECT_TIMEOUT: an unreachable host must not block a kernel start for minutes.
    return (
        f"CREATE OR REPLACE TEMPORARY SECRET {PG_SECRET} (TYPE postgres, "
        f"HOST {_lit(s.pg_host)}, PORT {int(s.pg_port)}, DATABASE {_lit(s.pg_db)}, "
        f"USER {_lit(s.pg_user)}, PASSWORD {_lit(s.pg_password)}, CONNECT_TIMEOUT 10)"
    )


def _attach_sql(s: Settings) -> str:
    return (
        f"ATTACH 'ducklake:postgres:' AS {quote_ident(s.ducklake_name)} "
        f"(DATA_PATH {_lit(s.ducklake_data_path)}, META_SECRET {_lit(PG_SECRET)}, DATA_INLINING_ROW_LIMIT 0)"
    )
