# DuckDB server for the Oog stack: serves one DuckDB database over the Quack protocol, so that DuckLake clients
# can use it as their catalog (ATTACH 'ducklake:quack:<host>'). The data files stay on S3 (written by the clients).
# Build context is the stack folder (docker/):
#   docker build -f images/quack/Dockerfile -t oog/quack:0.1.0 .
# DUCKDB_VERSION is the DuckDB that aantje ships; the extensions (ducklake, httpfs, quack) are versioned per DuckDB
# version and fetched now, so the stack needs no internet access at run time.
ARG PYTHON_VERSION=3.13
FROM python:${PYTHON_VERSION}-slim

ARG DUCKDB_VERSION=2.0.0

LABEL org.opencontainers.image.title="oog-quack" \
      org.opencontainers.image.description="DuckDB ${DUCKDB_VERSION} server (Quack) that holds a DuckLake catalog"

# openssl: serve.py creates the TLS certificate with it on the first start (Quack clients insist on TLS for every
# host but localhost).
# /data holds the catalog database, /certs the certificate (the workbench mounts it read-only). Both belong to the
# user, so that a new named volume inherits the ownership on its first mount.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir "duckdb==${DUCKDB_VERSION}" \
 && groupadd --gid 10003 quack \
 && useradd --uid 10003 --gid 10003 --no-create-home --shell /usr/sbin/nologin quack \
 && install -d -o quack -g quack /data /certs /opt/duckdb-extensions

ENV PYTHONUNBUFFERED=1 \
    OOG_DUCKDB_EXTENSION_DIR=/opt/duckdb-extensions

USER 10003:10003
RUN python -c "import duckdb; c = duckdb.connect(config={'extension_directory': '/opt/duckdb-extensions'}); [c.execute('INSTALL ' + e) for e in ('ducklake', 'httpfs', 'quack')]"

COPY --chmod=755 images/quack/serve.py /usr/local/bin/oog-quack

EXPOSE 9494
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --start-interval=1s --retries=5 \
    CMD ["python", "-c", "import os, socket; socket.create_connection(('127.0.0.1', int(os.environ.get('OOG_QUACK_PORT', '9494'))), 3).close()"]
ENTRYPOINT ["python", "/usr/local/bin/oog-quack"]
