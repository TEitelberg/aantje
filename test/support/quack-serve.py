"""Serves a fixture catalog over Quack WITHOUT TLS, for the tests of aantje (test/support/quack-fixture.ts).

Runs in a container of the image docker/images/quack. The catalog is /data/catalog.duckdb; the port 9494 is published
on 127.0.0.1 of the host, which a Quack client reaches over plain HTTP. Environment: AANTJE_QUACK_TOKEN (required);
AANTJE_DATA_PATH rewrites the stored data_path, for a catalog whose data files the test reads on the host.
"""

import os
import signal
import threading

import duckdb

token = os.environ["AANTJE_QUACK_TOKEN"]
con = duckdb.connect(
    "/data/catalog.duckdb", config={"extension_directory": os.environ.get("OOG_DUCKDB_EXTENSION_DIR", "")}
)
for name in ("ducklake", "httpfs", "quack"):
    con.execute(f"LOAD {name}")
data_path = os.environ.get("AANTJE_DATA_PATH")
if data_path:
    con.execute("UPDATE ducklake_metadata SET value = ? WHERE key = 'data_path'", [data_path])
# The token goes in as a parameter, so it never appears in a statement text.
con.execute(
    "CALL quack_serve('quack:0.0.0.0:9494', allow_other_hostname = true, disable_ssl = true, token = ?)", [token]
).fetchall()
print("aantje-test-quack: serving", flush=True)

stop = threading.Event()
for sig in (signal.SIGTERM, signal.SIGINT):
    signal.signal(sig, lambda *_: stop.set())
stop.wait()
con.execute("CALL quack_stop('quack:0.0.0.0:9494')")
con.close()
