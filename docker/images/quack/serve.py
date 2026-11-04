"""Serve /data/catalog.duckdb over the Quack protocol until the container stops.

Environment: OOG_QUACK_TOKEN (required, at least 4 characters), OOG_QUACK_PORT (default 9494),
OOG_QUACK_HOSTNAMES (names for the certificate, default "duckdb,localhost").

The server is the metadata database of DuckLake clients: they attach it with
ATTACH 'ducklake:quack:<host>:<port>' and write their data files to S3 themselves, so this container needs no S3
access. Clients use plain HTTP for localhost only and insist on TLS for every other host, so the server runs TLS with
a self-signed certificate, created once in /certs; clients trust it with SET GLOBAL ca_cert_file.
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading

import duckdb

DATABASE = "/data/catalog.duckdb"
CERT_DIR = "/certs"
CERT = f"{CERT_DIR}/quack.crt"
KEY = f"{CERT_DIR}/quack.key"
EXTENSIONS = ("ducklake", "httpfs", "quack")


def fail(message: str) -> None:
    print(f"oog-quack: {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def ensure_certificate(names: list[str]) -> None:
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    san = ",".join(f"DNS:{n}" for n in names)
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", f"/CN={names[0]}",
         "-addext", f"subjectAltName={san}", "-keyout", KEY, "-out", CERT],
        check=True, capture_output=True,
    )
    os.chmod(KEY, 0o600)
    os.chmod(CERT, 0o644)
    print(f"oog-quack: created the certificate {CERT} for {', '.join(names)}", flush=True)


def main() -> None:
    token = os.environ.get("OOG_QUACK_TOKEN", "").strip()
    if len(token) < 4:
        fail("OOG_QUACK_TOKEN must be set (at least 4 characters)")
    port = int(os.environ.get("OOG_QUACK_PORT", "9494"))
    names = [n.strip() for n in os.environ.get("OOG_QUACK_HOSTNAMES", "duckdb,localhost").split(",") if n.strip()]
    ensure_certificate(names)

    con = duckdb.connect(DATABASE, config={"extension_directory": os.environ.get("OOG_DUCKDB_EXTENSION_DIR", "")})
    for name in EXTENSIONS:
        con.execute(f"LOAD {name}")
    uri = f"quack:0.0.0.0:{port}"
    # the token goes in as a parameter, so it never appears in a statement text
    con.execute(
        f"CALL quack_serve('{uri}', allow_other_hostname = true, token = ?, ssl_cert_file = '{CERT}', ssl_key_file = '{KEY}')",
        [token],
    )
    print(f"oog-quack: serving {DATABASE} on {uri} (DuckDB {duckdb.__version__}, TLS)", flush=True)

    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    stop.wait()
    con.execute(f"CALL quack_stop('{uri}')")
    con.close()


if __name__ == "__main__":
    main()
