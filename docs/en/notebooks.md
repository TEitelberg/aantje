# Notebooks

**Create Notebook** (`aantje.createNotebook`) on a table or view node opens an untitled Jupyter notebook with everything needed to query that table or view with DuckDB: install, imports, configuration, the connection to the DuckLake, and a query cell to edit. It is the "go further" companion of the [preview grid](grid.md): the grid shows the first rows, the notebook gives a Python session at the same place.

| File                          | Job                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `src/notebook/build.ts`       | `buildNotebook(spec)`: pure function from a `NotebookSpec` to cells. No I/O, no clock.  |
| `src/notebook/python.ts`      | `pyString(value, triple?)`: the one place that turns text into a Python string literal. |
| `src/notebook/open.vscode.ts` | `openNotebook(cells)`: opens the cells as an untitled Jupyter notebook.                 |

```ts
export interface NotebookSpec {
  readonly connectionName: string;
  readonly profile: ConnectionProfile; // never a password
  readonly table: TableRef;
  readonly snapshot?: SnapshotId; // undefined: follows the latest snapshot
  readonly shownSnapshot?: SnapshotId; // the snapshot the tree showed, informational
  readonly s3: S3Settings; // settings values, never keys
  readonly extensionDirectory?: string;
  readonly generatedOn: string; // YYYY-MM-DD, passed in so the function stays pure
}
export function buildNotebook(spec: NotebookSpec): NotebookCell[]; // { kind, language, source }
```

`openNotebook` throws an `AantjeError` "Creating a notebook needs the Jupyter extension (ms-toolsai.jupyter). Install it and try again." when that extension is missing. Otherwise it opens the document (`jupyter-notebook`); Jupyter then asks for a kernel.

## The cells

The notebook always has these eight cells:

| #   | Kind     | Content                                                                                                                                 |
| --- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | markdown | Title `schema.table`, where the notebook comes from (date, connection, catalog kind, snapshot), how to run it, how secrets are handled. |
| 2   | code     | `%pip install "duckdb>=2.0.0" pandas`, alone, so a failed install is easy to see and repeat.                                            |
| 3   | code     | Imports (`getpass`, `os`, `duckdb`) and the helper `lit()` that quotes a SQL string literal.                                            |
| 4   | code     | Configuration: catalog variables, `SNAPSHOT`, the `S3_*` variables, `EXTENSION_DIRECTORY`.                                              |
| 5   | code     | Connection: `duckdb.connect`, `INSTALL`/`LOAD`, the secrets, the read-only `ATTACH`, `USE lake` (or its first schema).                  |
| 6   | markdown | "Ask your question": `QUERY` is the statement of **Select Top 1000 Rows**; DuckDB has no `TOP`; tables are addressed through `lake`.    |
| 7   | code     | `QUERY = '''SELECT * FROM lake."schema"."table" LIMIT 1000'''` and `con.sql(QUERY).df()`.                                               |
| 8   | markdown | Next steps: change `QUERY`, `.show()`, `.fetchall()`, time travel with `SNAPSHOT` and `ducklake_snapshots('lake')`.                     |

The configuration cell of a PostgreSQL profile:

```python
# DuckLake catalog (PostgreSQL).
PG_HOST = 'db.example.com'
PG_PORT = 5433
PG_DATABASE = 'lake'
PG_USER = 'reader'
PG_PASSWORD = os.environ.get('PGPASSWORD') or getpass.getpass('PostgreSQL password: ')
PG_SSL = True
PG_METADATA_SCHEMA = None

# Snapshot to read; None follows the latest snapshot.
SNAPSHOT = 6

# S3: only needed when the data files of the table are stored on S3.
S3_ENDPOINT = 'http://localhost:9000'
S3_REGION = 'us-east-1'
S3_URL_STYLE = 'path'
S3_KEY_ID = os.environ.get('AWS_ACCESS_KEY_ID')
S3_SECRET_KEY = os.environ.get('AWS_SECRET_ACCESS_KEY')
# ... prompts for a missing key when S3_ENDPOINT is set

# Where DuckDB keeps its extensions; None uses the default and downloads on first use.
EXTENSION_DIRECTORY = None
```

SQLite and DuckDB profiles have one catalog variable, `CATALOG_PATH`, instead of `PG_*`. A Quack profile has `QUACK_HOST`, `QUACK_PORT`, `QUACK_TOKEN`, `QUACK_TLS` and `QUACK_FINGERPRINT` (`None` checks the certificate against the system trust store). The connection cell attaches `ducklake:sqlite:<path>`, `ducklake:<path>` (DuckDB file), `ducklake:postgres:` with `META_SECRET 'aantje_pg'`, or `ducklake:quack:<host>:<port>` with the secret `aantje_quack`, `META_DISABLE_SSL` and, with a fingerprint and TLS on, `META_SSL_FINGERPRINT`. The extensions are `ducklake` plus `sqlite`, `postgres`, or `quack` with `httpfs` (none for a DuckDB file), and `httpfs` when S3 is used (an endpoint, a region, a URL style or both keys are set; the `aantje_s3` secret is created then too). With `PG_SSL` the `aantje_pg` secret carries `SSLMODE 'verify-full'` and `SSLROOTCERT 'system'`, without it `SSLMODE 'disable'`. `PG_SSL` holds the connection's `ssl` value. The connection cell ends by deleting the secrets from the kernel ([Secrets](#secrets)).

## Relation to the grid and to the data package

The notebook and the preview grid run the same logic on purpose: the connection cell builds the SQL of `setupStatements` in `src/data/attach.ts` ([Data access](data-access.md)) in Python. A test keeps the two in step. The engine is set up like the extension's own ([Security](security.md)): `allow_persistent_secrets` `false` (DuckDB would otherwise write the notebook's secrets to the home directory), a `temp_directory` created for the kernel and removed on exit, and `memory_limit` `2GiB`. After the `ATTACH`, `autoinstall_known_extensions` and `autoload_known_extensions` are set to false. Two differences are intended:

- The notebook does not run `SET lock_configuration = true`. The session belongs to the user, who may load more extensions or change settings. The `ATTACH` is read-only either way.
- The notebook ends with `USE lake`; on a lake without the schema `main`, where that fails, it uses the first schema by name (`USE lake."<schema>"`), as the SQL session does. Its query still names the catalog: `lake."schema"."table"`. After `USE lake`, `"lake"."table"` is ambiguous when a schema is itself called `lake` (`Binder Error: Ambiguous reference to catalog or schema`). The grid runs `LIMIT 1001` (one row more than shown, to detect more rows); the notebook uses `LIMIT 1000`.

## Requirements

- The Jupyter extension `ms-toolsai.jupyter` and a Python 3 kernel the user selects. aantje does not install or select a kernel.
- `pip` in that kernel. The lower bound `duckdb>=2.0.0` matters: `pip` keeps an older installed `duckdb`, and DuckLake spec 1.1 catalogs cannot be attached with it (`DuckLake catalog version mismatch`). If the import in cell 3 fails afterwards, restart the kernel and run again from cell 3. The run test uses Python 3.12 and DuckDB 2.0.0.
- Network access on the first run: DuckDB downloads `ducklake`, `sqlite`, `postgres` or `quack`, and `httpfs`. Offline, set `aantje.duckdb.extensionDirectory`; it is written to `EXTENSION_DIRECTORY`.

## Secrets

The cells never contain a password or a key. `NotebookSpec` has no field for them, and `buildNotebook` reads only named fields of the profile and S3 settings, so an object that carries a password at runtime cannot leak it. See [Security](security.md#notebooks).

- The PostgreSQL password is read from `PGPASSWORD` or asked for with `getpass` when the configuration cell runs (PostgreSQL profiles only). The Quack token is read from `QUACK_TOKEN` or asked for the same way (Quack profiles only).
- The S3 key id and secret come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`. A missing one is asked for only when `S3_ENDPOINT` is set. The credentials stored by **Set S3 Credentials** serve the grid and do not reach the notebook, which runs in another process. With an endpoint and a local file catalog both prompts still appear; Enter leaves the value empty.
- The values live in Python variables of the kernel and in the `CREATE SECRET` statements DuckDB receives, never in the `ATTACH` string.
- The connection cell deletes the lists `pg` and `s3` and the variables `PG_PASSWORD` (or `QUACK_TOKEN`), `S3_KEY_ID` and `S3_SECRET_KEY` from the kernel afterwards. Run the notebook from the configuration cell on; running the connection cell alone fails because the variables are gone.

## S3 settings

`aantje.s3.endpoint`, `aantje.s3.region` and `aantje.s3.urlStyle` pre-fill `S3_ENDPOINT`, `S3_REGION` and `S3_URL_STYLE`; an empty value becomes `None`. The endpoint may carry a scheme: `http://localhost:9000` gives `ENDPOINT 'localhost:9000'` and `USE_SSL false`, `https://...` gives `USE_SSL true`, and an endpoint without scheme leaves `USE_SSL` to DuckDB (TLS). The secret `aantje_s3` is created only when an endpoint or both keys are present.

## Snapshots

A notebook created while the tree is pinned to a snapshot gets `SNAPSHOT = <id>` and attaches with `SNAPSHOT_VERSION <id>`. One created while the tree follows the latest snapshot gets `SNAPSHOT = None` and reads the newest state on every run. Change the variable and run from the configuration cell on to travel in time. **Query at Snapshot...** with **Create Notebook** ([Time travel](time-travel.md)) creates a notebook pinned to any snapshot at which the table exists.

## Limits

- An Azure DuckLake (a PostgreSQL connection with a storage account) gets no notebook: the cells cannot load the `azure` extension, sign in to the storage account or to PostgreSQL with Microsoft Entra. The context menu of its tables and views does not offer Create Notebook (they carry the context value `table.azure` or `view.azure`), and a call from elsewhere is refused with a pointer to the SQL editor; the Azure notebooks of the [Docker stack](../../docker/README.md#azure-notebooks) cover that case.
- The notebook is generated once; later changes to the tree, connection or settings do not reach an open notebook.
- Paths and hosts in the cells are those of the extension host. A kernel on another machine does not find a local catalog file or a host reachable only from the extension host.
- A relative `DATA_PATH` of a DuckLake resolves against the kernel's working directory, not the catalog file ([Data access](data-access.md)).
- The relation to `src/data/attach.ts` is kept by a test, not by shared code, because one side is Python text.
- Only the first 1000 rows are queried by the template; edit `QUERY` for anything else.
- The PostgreSQL case is verified by the recorded statements, not against a running server. The Quack case is checked in the generated cells only.
