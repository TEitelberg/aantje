"""Runtime settings, read from the OOG_* environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field, fields


@dataclass(frozen=True)
class Settings:
    """Connection settings for the Oog stack (defaults are the local demo values).

    Each field maps to the environment variable ``OOG_<FIELD>`` (``pg_port`` -> ``OOG_PG_PORT``).
    Secrets are excluded from ``repr``. Values are stripped, except ``pg_password`` (only a trailing newline goes).
    """

    s3_endpoint: str = "http://rustfs:9000"
    s3_region: str = "us-east-1"
    s3_bucket: str = "oog-lake"
    s3_access_key: str = field(default="oogadmin", repr=False)
    s3_secret_key: str = field(default="change-me-oog-secret", repr=False)
    pg_host: str = "postgres"
    pg_port: int = 5432
    pg_db: str = "ducklake"
    pg_user: str = "ducklake"
    pg_password: str = field(default="change-me-pg", repr=False)
    ducklake_name: str = "oog"
    ducklake_data_path: str = "s3://oog-lake/ducklake/"
    # Second catalog: a DuckLake whose metadata is served by a DuckDB server over Quack. Without a token it is not attached.
    quack_host: str = "duckdb"
    quack_port: int = 9494
    quack_token: str = field(default="", repr=False)
    quack_name: str = "oog_quack"
    quack_data_path: str = "s3://oog-lake/ducklake-quack/"
    quack_ca_file: str = ""  # certificate that the Quack server uses (self-signed); unset = the system trust store

    @classmethod
    def from_env(cls, environ: Mapping[str, str] | None = None) -> Settings:
        """Build settings from ``environ`` (default ``os.environ``); unset or empty variables use the defaults."""
        env = os.environ if environ is None else environ
        values: dict[str, object] = {}
        for f in fields(cls):
            var = "OOG_" + f.name.upper()
            raw = env.get(var, "")
            # Postgres keeps leading/trailing blanks of the password (initdb drops only a trailing CR/LF);
            # RustFS trims its keys, so every other field stays stripped.
            raw = raw.rstrip("\r\n") if f.name == "pg_password" else raw.strip()
            if not raw.strip():
                continue
            if f.name in ("pg_port", "quack_port"):
                try:
                    values[f.name] = int(raw)
                except ValueError:
                    raise ValueError(f"{var} must be an integer, got {raw!r}") from None
            else:
                values[f.name] = raw
        # keep the data path inside the configured bucket unless it is set explicitly
        if "ducklake_data_path" not in values and "s3_bucket" in values:
            values["ducklake_data_path"] = f"s3://{values['s3_bucket']}/ducklake/"
        if "quack_data_path" not in values and "s3_bucket" in values:
            values["quack_data_path"] = f"s3://{values['s3_bucket']}/ducklake-quack/"
        return cls(**values)
