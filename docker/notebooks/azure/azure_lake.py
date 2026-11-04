"""Connection to an Azure DuckLake for the notebooks in this folder.

All three notebooks read their connection data from ``azure.config.json`` next to this file and open DuckDB through
``connect()``. The file holds no secret. The PostgreSQL password comes from the environment variable
``OOG_AZURE_PG_PASSWORD`` or a prompt, or, with ``"pgAuth": "entra"``, an access token of the same Microsoft Entra
sign-in (then ``pgUser`` is your Entra user name and nothing is asked). The storage account is reached with a Microsoft Entra sign-in:

* ``"auth": "device_code"``: a code that you enter in the browser (valid for about an hour; run the connection cell again
  or ``refresh_storage_secret(con)`` when it ran out),
* ``"auth": "service_principal"``: the environment variables ``AZURE_TENANT_ID``, ``AZURE_CLIENT_ID`` and
  ``AZURE_CLIENT_SECRET``.

The identity needs the role "Storage Blob Data Contributor" on the storage account, and the public IP address of this
machine has to be allowed in the firewall of the PostgreSQL server (aantje: "Allow My IP").
"""

from __future__ import annotations

import getpass
import json
import os
import sys
import tempfile
from pathlib import Path

CONFIG_FILE = Path(__file__).with_name("azure.config.json")
PASSWORD_VARIABLE = "OOG_AZURE_PG_PASSWORD"
EXTENSION_DIR_VARIABLE = "OOG_DUCKDB_EXTENSION_DIR"
EXTENSIONS = ("ducklake", "postgres", "azure")
PG_SECRET = "azure_pg"
STORAGE_SECRET = "azure_storage"
STORAGE_SCOPE = "https://storage.azure.com/.default"
POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"
AUTH_MODES = ("device_code", "service_principal")
PG_AUTH_MODES = ("password", "entra")
DEFAULTS = {
    "container": "lake",
    "dataPrefix": "data",
    "bronzePrefix": "bronze",
    "lakeName": "azure_lake",
    "pgPort": 5432,
    "pgDatabase": "ducklake_catalog",
    "pgUser": "ducklakeadmin",
    "auth": "device_code",
    "pgAuth": "password",
    "tenantId": "",
}
REQUIRED = ("storageAccount", "pgHost")

_credential = None
_secrets: list[str] = []


def load_config() -> dict:
    """Read ``azure.config.json``; stops with a clear message when a value is missing or still a placeholder."""
    try:
        values = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise RuntimeError(f"{CONFIG_FILE} is missing") from None
    except ValueError as exc:
        raise RuntimeError(f"{CONFIG_FILE} is not valid JSON: {exc}") from None
    cfg = {**DEFAULTS, **{k: v for k, v in values.items() if v is not None}}
    for key in REQUIRED:
        value = str(cfg.get(key, "")).strip()
        if not value or "<" in value or ">" in value:
            raise RuntimeError(f"Enter your own value for {key!r} in {CONFIG_FILE.name} first (now: {value!r})")
    if cfg["auth"] not in AUTH_MODES:
        raise RuntimeError(f"'auth' in {CONFIG_FILE.name} must be one of {', '.join(AUTH_MODES)}, not {cfg['auth']!r}")
    if cfg["pgAuth"] not in PG_AUTH_MODES:
        raise RuntimeError(f"'pgAuth' in {CONFIG_FILE.name} must be one of {', '.join(PG_AUTH_MODES)}, not {cfg['pgAuth']!r}")
    return cfg


def lake_name() -> str:
    """The name under which the DuckLake is attached."""
    return load_config()["lakeName"]


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _lit(value) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _root(cfg: dict, prefix: str) -> str:
    return f"abfss://{cfg['container']}@{cfg['storageAccount']}.dfs.core.windows.net/{prefix.strip('/')}"


def data_path() -> str:
    """DATA_PATH of the DuckLake: where DuckDB puts the Parquet files of the tables."""
    cfg = load_config()
    return _root(cfg, cfg["dataPrefix"]) + "/"


def bronze_root() -> str:
    """Root of the raw Bronze Parquet files; the notebooks add ``/<table>/load_date=.../<table>.parquet``."""
    cfg = load_config()
    return _root(cfg, cfg["bronzePrefix"])


def credential(cfg: dict | None = None):
    """The Microsoft Entra credential of the kernel (one sign-in per kernel)."""
    global _credential
    if _credential is None:
        cfg = cfg or load_config()
        try:
            from azure import identity
        except ImportError:
            raise RuntimeError("azure-identity is not installed: run the first code cell (%pip install) and restart the kernel") from None
        if cfg["auth"] == "service_principal":
            _credential = identity.EnvironmentCredential()
        else:
            _credential = identity.DeviceCodeCredential(tenant_id=cfg["tenantId"] or None)
    return _credential


def _storage_secret_sql(cfg: dict) -> str:
    account = _lit(cfg["storageAccount"])
    if cfg["auth"] == "service_principal":
        return f"CREATE OR REPLACE TEMPORARY SECRET {STORAGE_SECRET} (TYPE azure, PROVIDER credential_chain, CHAIN 'env', ACCOUNT_NAME {account})"
    token = credential(cfg).get_token(STORAGE_SCOPE).token
    _secrets.append(token)
    return f"CREATE OR REPLACE TEMPORARY SECRET {STORAGE_SECRET} (TYPE azure, PROVIDER access_token, ACCESS_TOKEN {_lit(token)}, ACCOUNT_NAME {account})"


def refresh_storage_secret(con) -> None:
    """Replace the storage secret with a new token: DuckDB does not renew an access token during a long session."""
    _run(con, lambda: _storage_secret_sql(load_config()), "refreshing the storage secret")


def _pg_secret_sql(cfg: dict, password: str) -> str:
    return (
        f"CREATE OR REPLACE TEMPORARY SECRET {PG_SECRET} (TYPE postgres, HOST {_lit(cfg['pgHost'])}, PORT {int(cfg['pgPort'])}, "
        f"DATABASE {_lit(cfg['pgDatabase'])}, USER {_lit(cfg['pgUser'])}, PASSWORD {_lit(password)}, "
        "SSLMODE 'verify-full', SSLROOTCERT 'system', CONNECT_TIMEOUT 10)"
    )


def _pg_password(cfg: dict) -> str:
    """The PostgreSQL password: an Entra access token (``pgAuth`` is ``entra``, about an hour), else the variable or a prompt."""
    if cfg["pgAuth"] == "entra":
        return credential(cfg).get_token(POSTGRES_SCOPE).token
    return os.environ.get(PASSWORD_VARIABLE) or getpass.getpass(f"PostgreSQL password of {cfg['pgUser']}: ")


def _redact(text: str) -> str:
    for secret in sorted(filter(None, _secrets), key=len, reverse=True):
        text = text.replace(secret, "***").replace(secret.replace("'", "''"), "***")
    return text


def _run(con, build, what: str) -> None:
    # DuckDB errors may quote the failing statement; the statement is built from a callable so that no frame holds it.
    try:
        con.execute(build())
    except Exception as exc:
        raise RuntimeError(f"{what} failed: {_redact(str(exc))}") from None


def connect(*, attach: bool = True):
    """In-memory DuckDB with the secret of the storage account; with ``attach`` also the Azure DuckLake as default catalog."""
    import duckdb

    cfg = load_config()
    spill = os.path.join(tempfile.gettempdir(), "oog-duckdb")
    os.makedirs(spill, mode=0o700, exist_ok=True)
    config = {"temp_directory": spill, "allow_persistent_secrets": "false"}
    ext_dir = os.environ.get(EXTENSION_DIR_VARIABLE, "").strip()
    if ext_dir:
        config["extension_directory"] = ext_dir
    con = duckdb.connect(":memory:", config=config)
    try:
        # INSTALL does nothing for an extension that is in the directory already; the azure extension is downloaded here.
        for name in EXTENSIONS:
            _run(con, lambda name=name: f"INSTALL {name}", f"installing the DuckDB extension {name!r}")
            _run(con, lambda name=name: f"LOAD {name}", f"loading the DuckDB extension {name!r}")
        if sys.platform.startswith("linux"):
            # The default transport of the azure extension looks for the CA bundle only where Red Hat keeps it, so on
            # Debian and Ubuntu (this image) every request fails with "Problem with the SSL CA cert"; curl finds it.
            _run(con, lambda: "SET azure_transport_option_type = 'curl'", "selecting the curl transport")
        _run(con, lambda: _storage_secret_sql(cfg), "creating the storage secret")
        if attach:
            password = _pg_password(cfg)
            _secrets.append(password)
            _run(con, lambda: _pg_secret_sql(cfg, password), "creating the PostgreSQL secret")
            name = quote_ident(cfg["lakeName"])
            _run(
                con,
                lambda: f"ATTACH 'ducklake:postgres:' AS {name} "
                f"(DATA_PATH {_lit(data_path())}, META_SECRET {_lit(PG_SECRET)}, DATA_INLINING_ROW_LIMIT 0)",
                f"attaching the DuckLake {cfg['lakeName']!r}",
            )
            con.execute(f"USE {name}")
    except BaseException:
        con.close()
        raise
    return con


def delete_bronze_files(*, dry_run: bool = True) -> tuple[int, float]:
    """Delete everything below the Bronze folder; returns the number of files and their size in MB. Needs ``azure-storage-file-datalake``."""
    cfg = load_config()
    try:
        from azure.core.exceptions import ResourceNotFoundError
        from azure.storage.filedatalake import DataLakeServiceClient
    except ImportError:
        raise RuntimeError("azure-storage-file-datalake is not installed: run the first code cell (%pip install) and restart the kernel") from None
    service = DataLakeServiceClient(f"https://{cfg['storageAccount']}.dfs.core.windows.net", credential=credential(cfg))
    system = service.get_file_system_client(cfg["container"])
    prefix = cfg["bronzePrefix"].strip("/")
    try:
        files = [p for p in system.get_paths(path=prefix, recursive=True) if not p.is_directory]
    except ResourceNotFoundError:
        return 0, 0.0
    size = sum(p.content_length or 0 for p in files) / 1024 / 1024
    if files and not dry_run:
        system.get_directory_client(prefix).delete_directory()
    return len(files), size
