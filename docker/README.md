# Oog: a local DuckLake stack with aantje

A small Docker Compose stack to try [aantje](https://github.com/TEitelberg/aantje) (a VS Code extension to explore
and query DuckLake catalogs) against a real lake, and to run a medallion architecture (Bronze, Silver, Gold) on DuckLake
with DuckDB.

| Service | What it is | URL |
|---|---|---|
| **workbench** | code-server (VS Code in the browser) with Jupyter, DuckDB, the DuckLake catalog `oog` and the **aantje** extension. Opens the start page on load. | http://localhost:8443 |
| **postgres** | PostgreSQL 17: the DuckLake catalog (database `ducklake`) and the Gitea database | `localhost:5433` |
| **rustfs** | S3-compatible object storage: the DuckLake data files (bucket `oog-lake`) and the Git objects of Gitea (`oog-gitea`) | S3 http://localhost:9000, console http://localhost:9001 |
| **duckdb** | DuckDB 2.0.0 server that serves a second DuckLake catalog over [Quack](https://duckdb.org/quack/) (client-server protocol, experimental); the data files are in RustFS | `localhost:9494` (TLS, see below) |
| **gitea** | Git server with LFS; holds the `oog-workspace` repository with the notebooks | http://localhost:3000 |

DuckLake is not a service of its own. In the catalog `oog` the metadata lives in Postgres and the Parquet files in RustFS;
the workbench attaches it with DuckDB. The **duckdb** service holds the metadata of a second catalog, `oog_quack`, in a
DuckDB database that it serves over Quack; its Parquet files are in RustFS too. Both catalogs run side by side.

```
workbench (DuckDB + aantje) --> postgres  (DuckLake metadata)
                            --> duckdb    (DuckLake metadata, served over Quack)
                            --> rustfs    (Parquet data files of both catalogs)
                            --> gitea     (workspace repository, objects in rustfs)
```

## Start

Requirements: Docker with Compose v2 (about 6 GB RAM for Docker, about 8 GB disk for the images).

```sh
docker compose up -d --build --wait     # first start: builds five small images, takes a few minutes
```

Then open **http://localhost:8443** and sign in with the code-server password (default `change-me`, see
`.env.example`). The start page opens as the first tab and links to every service; the folder
`oog-workspace` (a clone of the Gitea repository) is open.

Settings: `cp .env.example .env` and edit. All defaults are demo values for your own machine only; change every
password before the stack is reachable by anyone else. All ports are published on `127.0.0.1` only.

## Try it

1. In the activity bar open **aantje** and connect to **Oog Lakehouse** (Postgres password from `.env`,
   default `change-me-pg`). The catalog is empty until you load data.
2. Open `notebooks/local/01-medallion-generator.ipynb`, pick the kernel **Oog** and run all cells: it writes raw Parquet
   extracts of an online shop (10 tables, September 2026, one extract per day) to `s3://oog-lake/bronze/`.
   Set `SCALE` in the first cell (for example `0.01`) for a quick run; `1.0` is up to a million order items per day.
3. Open `02-medallion-pipeline.ipynb`, set `LOAD_DATE` and run all cells: one load date goes through Bronze, Silver
   (clean, deduplicate, quarantine, history) and Gold (star schema with SCD2 dimensions, facts and five reporting views).
   `LOAD_WHOLE_MONTH = True` loads every day in a loop. The notebook proves that repeating a day changes nothing.
4. Refresh the catalog in aantje: schemas `bronze`, `silver`, `gold`, `ops`, snapshots and table changes.
5. `03-medallion-cleanup.ipynb` undoes it (every step has a switch; the default is a dry run).
6. To build the same lake on the Quack server, set `LAKE = "oog_quack"` in the first cell of notebooks 02 and 03. The
   catalogs `oog` (PostgreSQL) and `oog_quack` then hold the same schemas, tables, views and macros; their snapshot
   histories are separate.

The notebooks of this tour are in `notebooks/local/`. `notebooks/azure/` has the same three notebooks for an Azure
DuckLake ([below](#azure-notebooks)).

## Azure notebooks

`notebooks/azure/` holds the medallion notebooks for an **Azure DuckLake**: one that aantje created (*Create Azure
DuckLake...*) or that the template in `deploy/azure/` deployed. Nothing of the local stack is used: the metadata is in
Azure Database for PostgreSQL, the data files (Parquet) and the Bronze files are in the storage account.

| File | What it is |
|---|---|
| `azure.config.json` | The one place with the connection data: storage account, container, PostgreSQL server, database, user, lake name, sign-in mode. No secrets. |
| `azure_lake.py` | Reads the file and opens DuckDB with the Azure secrets and the attached lake. All three notebooks import it. |
| `01-medallion-generator.ipynb`, `02-medallion-pipeline.ipynb`, `03-medallion-cleanup.ipynb` | As in `notebooks/local/`, with the Azure connection; `SCALE` starts at `0.01`. |

1. Fill in `azure.config.json`: in aantje, **Copy Azure Config** (context menu of the Azure DuckLake) copies the whole file content for it; paste it over the file. Otherwise the values are in the output `ducklake` of the deployment (`postgres.host` is `pgHost`,
   `postgres.user` is `pgUser`); `storageAccount` is the name of the storage account, `container` is `lake`. Bronze goes to the folder
   `bronze` of the same container, the lake itself to `data` (`dataPrefix`).
2. The PostgreSQL password is read from the environment variable `OOG_AZURE_PG_PASSWORD` or asked for when the connection is
   made; it is never written to a file.
   With `"pgAuth": "entra"` (a lake that signs in to PostgreSQL with Microsoft Entra; Copy Azure Config sets it) nothing is asked: the notebook
   takes an access token of the same sign-in as the password, and `pgUser` is your Entra user name.
3. Sign in to Azure with `"auth": "device_code"` (default: the notebook prints a code that you enter in the browser; the token lasts about an hour,
   run the connection cell again afterwards) or `"auth": "service_principal"` (set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET`
   in the environment of the workbench). The identity needs the role **Storage Blob Data Contributor** on the storage account.
4. The firewall of the PostgreSQL server has to allow the public IP address of this machine (aantje: *Allow My IP*).
5. Run the notebooks in order 01, 02, 03 and pick the kernel **Oog**. The first cell installs `azure-identity` (and the
   Data Lake client in notebook 03) and DuckDB loads its `azure` extension from the internet on the first run; restart the
   kernel if the import fails after the install.

Every statement is a round trip to a server in Azure, so the pipeline takes much longer than the local one: start with `SCALE = 0.01` and one load date.
The resources cost money for as long as they exist. This path has not been run against a real Azure subscription by automated tests.

## Where things live

| What | Where |
|---|---|
| DuckLake data files | bucket `oog-lake`, prefix `ducklake/` (catalog `oog`) and `ducklake-quack/` (catalog `oog_quack`) |
| Raw test data | bucket `oog-lake`, prefix `bronze/` |
| Catalog metadata | database `ducklake` in postgres (`oog`); `/data/catalog.duckdb` in the volume `oog-quack-data` of the duckdb service (`oog_quack`) |
| Notebooks | repository `oog-workspace` in Gitea, cloned to `/home/coder/workspace/oog-workspace` |

In a notebook, `con` is the DuckDB connection with the catalogs `oog` (the default) and `oog_quack` attached; `%sql` and `%%sql` work as well. In a
terminal of the workbench, `oog-sql "select 42"` runs a statement against the lake.

## The Quack server

The **duckdb** service runs `quack_serve` on a DuckDB database (`/data/catalog.duckdb`) and holds the metadata of the
catalog `oog_quack`; clients attach it with `ATTACH 'ducklake:quack:duckdb:9494' AS oog_quack (DATA_PATH 's3://oog-lake/ducklake-quack/')`
and write the data files themselves, so the server needs no S3 access. Several clients can use the catalog at the same
time (there is no file lock as with a DuckDB file).

- **Token:** `OOG_QUACK_TOKEN` in `.env` (demo value `change-me-quack`) authenticates the clients. The workbench creates
  the secret `oog_quack` (type `quack`, scope `quack:duckdb:9494`) from it when it connects.
- **TLS:** by default a Quack client uses plain HTTP only for `localhost`, `127.0.0.1` and `::1` and TLS for every other
  host. A client can switch that with `DISABLE_SSL true|false` on a plain `quack:` attach and `META_DISABLE_SSL true|false`
  on a `ducklake:quack:` attach. The server runs TLS with a self-signed certificate that it creates on its first start
  (names `duckdb` and `localhost`, volume `oog-quack-certs`). The workbench mounts the volume read-only and trusts exactly
  that certificate (`SET GLOBAL ca_cert_file`, variable `OOG_QUACK_CA_FILE`). `ca_cert_file` replaces the trust store for
  every HTTPS request of that DuckDB, so public HTTPS endpoints then fail; a client can instead pin the certificate with
  `SSL_FINGERPRINT` (plain attach) or `META_SSL_FINGERPRINT` (DuckLake attach), as aantje does. To use another
  certificate, put `quack.crt` and `quack.key` into the volume before the first start.
- **From the host:** port `127.0.0.1:9494` is published for tools on your machine. The server speaks TLS there, but a
  client that attaches `localhost` uses plain HTTP by default, so it has to ask for TLS (`DISABLE_SSL false` or
  `META_DISABLE_SSL false`); this is not tried in this stack.
- **Name of the service:** it is called `duckdb`, not `quack`: a client URI `ducklake:quack:quack:9494` is parsed wrongly.
- **Experimental:** Quack and DuckLake on Quack are marked experimental by DuckDB. Known: a `set_option` call is not undone
  by `ROLLBACK`. The medallion notebooks, the snapshot expiry and time travel work on the served catalog.

## Everyday commands

```sh
docker compose ps                      # state
docker compose logs -f workbench       # logs of one service
docker compose stop                    # stop, keep the data
docker compose down                    # remove the containers, keep the data
docker compose down -v                 # remove everything, including all data volumes
```

After changing a Dockerfile or a build argument run `docker compose build`. The data lives in the named volumes
`oog-rustfs-data`, `oog-postgres-data`, `oog-gitea-data`, `oog-quack-data`, `oog-quack-certs`, `oog-workbench-workspace` and `oog-workbench-userdata`.

## The aantje extension

The workbench image installs aantje from Open VSX as `teitelberg.aantje`, in the version of `AANTJE_VERSION` (`.env`, default `latest`). Docker keeps the layer of that step, so to update the image set the number of the new version, for example `AANTJE_VERSION=0.1.9`, and run `docker compose up -d --build`. The Extensions view of the workbench also shows when a newer version exists; **Update** installs it until the container is re-created (the extension folder belongs to the image). A volume that already has a `settings.json` keeps its old value of `extensions.autoCheckUpdates`; set it to `true` there to see the notice. To try a package you built yourself, put its VSIX
into `images/workbench/aantje/` (`aantje-linux-x64*.vsix` or `aantje-linux-arm64*.vsix`); the build then installs that file
instead, and `*.vsix` is not tracked by Git. The connection
profile "Oog Lakehouse" and the S3 settings for RustFS are preconfigured (`images/workbench/code-server/`); S3
credentials come from the `AWS_*` variables of the container. The Postgres password is asked for on the first connect and kept in
the code-server secret storage.

## Layout

```
compose.yaml            the stack
.env.example            settings (demo defaults)
notebooks/local/        the three medallion notebooks for the local stack (seed of the Gitea repository and of the workbench)
notebooks/azure/        the same three for an Azure DuckLake, with azure.config.json and azure_lake.py
workspace/              README and .gitignore of the Gitea repository
images/workbench/       code-server, Python venv with the oog helper package, start page, aantje
images/quack/           the DuckDB server that serves the Quack catalog
images/postgres-init/   one-shot: database and role of Gitea
images/rustfs-init/     one-shot: creates the buckets
images/gitea-init/      one-shot: admin account and the workspace repository
```

The images `oog/*` are built locally and never pulled; the Docker Hub namespace `oog` is not ours.

## Troubleshooting

- **A service is unhealthy:** `docker compose logs <service>`; the one-shot jobs (`*-init`) must show `Exited (0)`.
- **Port already in use:** set the host port in `.env` (for example `WORKBENCH_PORT=18443`); an empty value picks a free port.
- **`oog_quack` is not attached:** the kernel and `python -m oog.smoke` print a warning with the reason. Check
  `docker compose logs duckdb`, that `OOG_QUACK_TOKEN` is the same for both services and that the volume `oog-quack-certs` holds the certificate the server uses (after removing it, remove `oog-quack-data` and restart both services).
- **The notebooks are still directly in `notebooks/` or `local/` and `azure/` are missing:** the workspace repository is filled once, on the first start. See "Restoring the examples" in `workspace/README.md` (copy the new folders and remove the old files), or start from scratch.
- **aantje asks for a password:** the Postgres password (`OOG_PG_PASSWORD`), default `change-me-pg`.
- **Start from scratch:** `docker compose down -v`, then `docker compose up -d --build --wait`.
