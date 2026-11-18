# Sync to Iceberg

**Sync to Iceberg...** on a connected connection writes all tables of the lake, on a schema the tables of that schema, and on a table that table, at one snapshot, as Iceberg tables into an Iceberg REST catalog. The code is in `src/iceberg/`.

## Targets

A target is an Iceberg REST catalog that you define once and choose again for every copy. The setting `aantje.icebergTargets` holds the entries; the client secret or token is never part of it, it lives in the VS Code secret storage under `aantje.iceberg.<id>.secret`, bound to the endpoint and client it was entered for (the same rule as the password of a connection).

| Field               | Meaning                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `name`              | Shown when you copy. Unique, ignoring case.                                                                              |
| `endpoint`          | The REST endpoint, for example `http://polaris:8181/api/catalog`. A trailing `/` is dropped.                             |
| `warehouse`         | The warehouse or catalog name that DuckDB's `ATTACH` takes.                                                              |
| `signIn`            | `oauth2` (client ID and secret), `token` (a bearer token) or `none`.                                                     |
| `clientId`          | `oauth2` only.                                                                                                           |
| `oauth2ServerUri`   | `oauth2` only; default `<endpoint>/v1/oauth/tokens`.                                                                     |
| `scope`             | `oauth2` only, optional.                                                                                                 |
| `region`            | Region for the storage behind the catalog; default `us-east-1`. Polaris sends none for S3-compatible stores.             |
| `vendedCredentials` | Default `true`: the catalog hands out short-lived storage credentials, so aantje needs no keys for the target's storage. |

**Add Iceberg Target...** first asks for the kind (**Iceberg REST catalog** or **Microsoft Fabric lakehouse**), then for name, endpoint, warehouse, sign-in, client ID and secret of a REST catalog; **Sync to Iceberg...** offers **New Iceberg target...** in the same way. **Remove Iceberg Target...** deletes a target, its secret and the records of its copies; the Iceberg tables stay in the catalog. An entry that breaks a rule is skipped and reported as `aantje.icebergTargets[<index>]: <reason>`. Generic REST catalogs (Polaris, Lakekeeper) and lakehouses of Microsoft Fabric ([below](#microsoft-fabric-lakehouse)) are supported; Amazon S3 Tables and AWS Glue are not.

## Microsoft Fabric lakehouse

A lakehouse of Microsoft Fabric is a target through the Iceberg REST catalog of OneLake, `https://onelake.table.fabric.microsoft.com/iceberg`, with the warehouse `<workspace id>/<lakehouse id>`. aantje writes native Iceberg tables into the lakehouse's own OneLake storage (`Tables/<schema>/<table>`), and Fabric shows them as Delta tables to the SQL analytics endpoint, Spark and Power BI within about 5 seconds to 2 minutes. It is a copy: the files of the lake stay where they are, and the copy takes OneLake storage of the workspace's capacity. A shortcut to the files of the lake would not do: they have no Iceberg or Delta metadata, and the catalog of OneLake cannot commit through a shortcut.

**Add Iceberg Target...** with **Microsoft Fabric lakehouse**, or **New Fabric lakehouse...** in **Sync to Iceberg...**, asks for:

1. The tenant: empty for the tenant of your Microsoft account, or the directory (tenant) ID.
2. The workspace, by name or ID. It needs a Fabric capacity; a name that Fabric does not know, or a workspace without capacity, is asked again.
3. A lakehouse of the workspace from the list, or **New lakehouse...**: after a confirmation aantje creates it with schemas through the Fabric API (`POST /v1/workspaces/<id>/lakehouses` with `enableSchemas`), with a progress notification until Fabric has finished it.
4. The name of the target, with the name of the lakehouse proposed. A new lakehouse gives the target its name without this question, unless another target has that name.

Every call of the Fabric API is written to the aantje output. The target keeps the ids, so it stays the same when the workspace or the lakehouse is renamed:

| Field                            | Meaning                                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------------------------- |
| `kind`                           | `fabric`.                                                                                       |
| `workspace`, `lakehouse`         | The ids (GUIDs).                                                                                |
| `workspaceName`, `lakehouseName` | The names when the target was made, for messages.                                               |
| `tenant`                         | Optional: the directory (tenant) ID of the sign-in.                                             |
| `schemas`                        | Whether the lakehouse has schemas (default `true`); a lakehouse without schemas has only `dbo`. |

**Sign-in.** The Microsoft account of VS Code, also in code-server; aantje stores no secret for a Fabric target. The Fabric API takes a token for `https://api.fabric.microsoft.com/.default`, the catalog and OneLake one for `https://storage.azure.com/.default`. Before each table the sync asks VS Code for the token without asking you; when VS Code has renewed it, aantje replaces the OneLake secret and attaches the catalog again, because the attached catalog keeps the token it started with. A sync of more than an hour so keeps writing.

**Writing.** DuckDB 2.0 cannot write with the storage credentials that OneLake vends (checked on 2026-11-16), so the catalog is attached with `ACCESS_DELEGATION_MODE 'none'`, `STAGE_CREATE_TABLES false` and `DISABLE_MULTI_TABLE_COMMIT true`, and the data files are written with aantje's own OneLake secret `aantje_iceberg_onelake` (`TYPE azure`, `PROVIDER access_token`), limited to `abfss://<workspace id>@onelake.dfs.fabric.microsoft.com/`. A lake on OneLake keeps its own secret.

**Schemas.** In a lakehouse with schemas, the sync creates the schemas the lakehouse lacks before the first table is written (`CREATE SCHEMA IF NOT EXISTS`, which the catalog of OneLake carries out), as for every catalog, and the aantje output names each schema it created or could not create. Fabric allows only letters, digits and `_` in a schema name, and shows no table whose name has a space; the confirmation names both before anything is written. A lakehouse without schemas has only `dbo`: a schema or a table goes to `dbo` without a question, and the whole lake is refused, because the tables of several schemas could clash there.

**Types.** On top of the [types](#types) of every copy, `TIME` and `UUID` columns are written as `VARCHAR`: Fabric drops a time column and shows a UUID as bytes. Nested fields of these types are written as they are. A `TIMESTAMP` (without time zone) is `timestamp_ntz` in Fabric, which not every Fabric engine reads fully; `TIMESTAMP WITH TIME ZONE` is the safe choice.

**After the sync.** Fabric converts each table that the sync wrote to Delta 5 seconds to 2 minutes after its commit; until then the SQL analytics endpoint reports it as `DeltaTableNotFound`. So aantje follows each sync to a Fabric lakehouse with a step under a notification of its own: it waits up to 3 minutes until the conversion log of each table names the metadata that the sync wrote, then asks the SQL analytics endpoint to read those tables again (`POST /v1/workspaces/<id>/sqlEndpoints/<id>/refreshMetadata`, 25 tables at a time). The output names each table: converted, the reason of a failed conversion, not converted in time, and what the endpoint made of it. A problem in this step is a warning; the sync itself is done.

**Limits of Fabric.** Fabric converts a table only while it has fewer than 5,000 Iceberg commits; after that it keeps showing the last converted state. Each sync adds commits; **Replace** in a first sync, or a table that the lake altered, writes the table new and starts the count again. A table that is synced more often than every two minutes may look inconsistent in Fabric until the conversion has caught up. Fabric writes how the last conversion went to `Tables/<schema>/<table>/_delta_log/latest_conversion_log.txt` (**View files** on the table).

**What Fabric needs.** The role Contributor or higher in the workspace, and the tenant setting **Users can access data stored in OneLake with apps external to Fabric**. **Remove Iceberg Target...** leaves the lakehouse and its tables in Fabric.

## The copy

The wizard asks for the target (and the secret, once, when none is stored); for a schema the Iceberg namespace (default: the name of the schema), for a table the namespace and the name of the Iceberg table (default: its schema and name); what to do with a table that the catalog has already (**Stop** or **Replace**); and a confirmation, which also says what does not map one to one (below). The tables of a lake keep their schema as namespace and their name. The snapshot is the newest one that the explorer's reader of the lake sees when the copy starts (the live catalog for PostgreSQL and Quack, the file as it was opened for SQLite), or the one chosen with **Show Catalog at this Snapshot**. All tables are read at that snapshot (`AT (VERSION => n)`).

- The lake is attached read-only in a private in-memory DuckDB together with the Iceberg catalog (`ATTACH ... (TYPE iceberg, ...)`); the Iceberg extension and `httpfs` load before the configuration lock, the secret and the `ATTACH` follow the lake's `ATTACH`.
- Each table is one transaction: the same guard as the data preview runs first (a catalog that lists data files on a foreign server is refused), then `CREATE TABLE ... AS SELECT`, which is one Iceberg commit, and the table properties of its origin, which write no snapshot of their own. A reader of the catalog sees a table complete or not at all.
- **Partitioning**: a table that the lake partitions by `identity`, `year`, `month`, `day` or `hour` of top-level columns is written `PARTITIONED BY` the same keys. A table with another key (a nested column, another transform) is written without partitioning; the message counts the partitioned tables.
- **The origin** as table properties of the Iceberg table, so that it can be read on any machine: `aantje.ducklake.table` (`schema.table` in the lake), `aantje.ducklake.snapshot-id` and `aantje.ducklake.snapshot-time`.
- With **Stop**, nothing is written when the catalog already has one of the tables, and the message names them. With **Replace**, each of them is dropped and written new.
- A table that fails is reported and the others go on; the message names the first three failures. Views and macros are not copied.
- The aantje output names each table when it is done (rows written, or the reason it failed, with its number of all), and the notification the table that runs now; at the end the number of tables written.
- Where the data goes is the catalog's decision: the table location below the warehouse, on the storage that the catalog is set up for. It is never the data path of the lake.

### Types

DuckDB's `iceberg` extension writes Iceberg format version 2 (checked with DuckDB 2.0 against Polaris). Before the copy, the confirmation names the columns that Iceberg gets as another type and the tables that Iceberg cannot hold; the message after the copy counts the converted columns.

| DuckDB type                                                                                                                        | In Iceberg                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`, `UHUGEINT`                                                                         | Cast to `SMALLINT`, `INTEGER`, `BIGINT`, `DECIMAL(20,0)`, `DECIMAL(38,0)`.              |
| `TIMESTAMP_S`, `TIMESTAMP_MS`                                                                                                      | Cast to `TIMESTAMP` (microseconds).                                                     |
| `JSON`, `ENUM`                                                                                                                     | Cast to `VARCHAR`.                                                                      |
| An array of fixed length (`INTEGER[3]`)                                                                                            | Cast to a list (`INTEGER[]`).                                                           |
| `TINYINT`, `SMALLINT`, `HUGEINT`                                                                                                   | Widened by the writer to `INTEGER`, `INTEGER`, `DECIMAL(38,0)`.                         |
| `TIME WITH TIME ZONE`, `INTERVAL`, `TIMESTAMP_NS` and `TIMESTAMPTZ_NS`, `TIME_NS`, `VARIANT`, `GEOMETRY`, `UNION`, `BIT`, `BIGNUM` | Not written: the table fails. Nanoseconds, variants and geometry need format version 3. |

The casts apply to top-level columns; a nested field of a type that needs a cast makes its table fail too.

## Bringing a sync up to date

**Sync to Iceberg...** again on a connection, a schema or a table that an earlier sync to the chosen target covers does not copy anew: it brings the Iceberg tables to the state of the lake at the snapshot of the sync (the newest one, or the one pinned with **Show Catalog at this Snapshot**). **Sync to Iceberg** in the report, or in the context menu of the row of the sync in the tree, does the same for everything synced to its target. A source that no earlier sync covers is copied as above.

What happens to each table is decided from the snapshots of the lake after its last sync and from a fresh check of the Iceberg catalog:

| The lake, since the last sync              | The sync                                                                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Only inserted rows                         | Appends them: the rows of `table_changes` with the change type `insert`, by their row ids, as they are at the snapshot of the sync.      |
| Deleted or updated rows                    | Replaces the rows: `DELETE` and `INSERT` in one transaction.                                                                             |
| Altered the table (its columns may differ) | Drops the Iceberg table and writes it new, with the partitioning of the lake; its snapshot history in Iceberg starts again.              |
| Renamed it, or nothing                     | Writes nothing; the record moves to the snapshot of the sync, and the Iceberg table keeps its name. **Rename...** says so in its script. |
| Dropped it                                 | Leaves the Iceberg table alone.                                                                                                          |

A table that Iceberg lacks is written new; a table that was changed in Iceberg after the last sync (Iceberg is ahead, or replaced) is replaced, and the question names it, because those changes are lost. A sync of a lake or a schema also writes the tables of the lake that are new since, as a first sync does. After an append, the rows of the Iceberg table and of the lake table are counted; when they differ (an expired snapshot hides its changes from the plan), the rows are replaced in the same transaction. The question before the sync counts the tables of each kind; the message after it says how many were synced. Every written table gets the table properties of its origin again.

An AI assistant can read the state of the syncs and ask for such a sync through aantje's [MCP server](mcp.md#tools-for-the-syncs-to-iceberg): `request_iceberg_sync` opens the same question in VS Code, marked as asked by an assistant, and nothing is written unless you confirm it.

## Remembered copies

For each copied table aantje keeps, in its own state (`aantje.icebergCopies`): connection, target, schema and table, the id of the table in the lake (it survives a rename), the DuckLake snapshot and its time, the Iceberg snapshot that the copy wrote (read with `iceberg_snapshots`, as text because the ids are 64 bit), the rows written, the columns that were written as another type, the time of the copy, the Iceberg namespace and table when they are not the schema and table of the lake, and what the copy covered (the lake, a schema, a table). A copy of the whole lake replaces all records of that connection and target, a copy of a schema those of the schema, and a copy of a table adds or replaces the record of the table. Removing the connection or the target removes its records.

A table of the lake that no copy has makes a copy out of sync only where a copy covered it: any table after a copy of the whole lake, the tables of a schema after a copy of that schema, no other table after a copy of single tables.

A table that a sync could not write is kept as well (`aantje.icebergFailures`): connection, target, schema and table, the first line of the reason, the snapshot and the time. A later sync that writes it, a forgotten sync or a removed target drop the entry; a table the lake dropped is not shown any more.

## The row in the tree

Once a lake was copied to a target, its connection has one row below the folders for each target: **Iceberg · <target>**. Its context menu offers what the header of the report offers: **Sync to Iceberg**, **Refresh Iceberg State** (checks the copy again) and **Forget Iceberg Sync**. A connection that was never copied has none. The icon, an iceberg, is **green** when every copied table has the state of the lake, **red** when not, and grey while the tree checks it (when the connection opens, on Refresh and after a copy); the label keeps the colour of the text. The icon is a file per colour (`media/iceberg-row-<green|red|plain>-<light|dark>.svg`) in the default colours of the theme's `charts.green` and `charts.red`, because a theme colour cannot reach an SVG file. The description says `in sync at @<snapshot>` or `<n> tables out of sync`. A copied table also gets a line in its tooltip, `Iceberg · <target>: in sync` or the reasons, and while the lake changed it after its sync the description `Iceberg: <n> behind` (the most of all targets). A click on the row, or **Show Iceberg Report** in its context menu, opens the report.

A copy is checked when the connection opens, on Refresh, after a copy and when the report is refreshed; there is no polling. After a copy, from the tree or from the report, the report of that copy is read again by itself if it is open, also when the copy failed or was cancelled half way; the tree reads the levels of the connection again without reopening the lake, which the copy did not change. The check never writes and never asks for a sign-in: without a stored secret, or when the catalog cannot be reached, the row is red and the tooltip says why.

A table is in sync when the lake did not change it after the copy and the Iceberg table is the one the copy wrote:

| State               | Meaning                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lake is newer       | A snapshot after the copy inserted into, deleted from or altered the table, or renamed it. Compactions, merges and the flush of inlined rows do not count. |
| Dropped in the lake | The table of the record (found by its id) is gone from the lake.                                                                                           |
| Missing in Iceberg  | The catalog has no such table.                                                                                                                             |
| Iceberg is ahead    | The current Iceberg snapshot is not the one the copy wrote, but that one is in the snapshot log: others wrote after it.                                    |
| Replaced in Iceberg | The snapshot the copy wrote is not in the log any more: the table was replaced.                                                                            |
| Not checked         | The catalog could not be asked, or the copy has no Iceberg snapshot to compare. Counts as out of sync.                                                     |

A table that the lake has and the copy has not (created after the copy) also makes the copy out of sync; the report lists it.

The Iceberg side is read with REST calls, not with DuckDB: a token (OAuth2 client credentials or the bearer token of the target), `GET /v1/config?warehouse=...` for the prefix and `GET /v1/<prefix>/namespaces/<schema>/tables/<table>` per table, eight at a time, each with a timeout of 15 seconds. The 64 bit snapshot ids are quoted in the response before it is parsed, so they are compared as text.

## The report

The panel **Iceberg Report: <target> · <connection>** shows the report **Iceberg Report: <target>**: the logo of aantje, then the Apache Iceberg logo (as tall as the title) before the title, under it the lake, the target and where the target is (the Fabric lakehouse and its workspace, or the warehouse at the endpoint of the catalog), and in the header **Sync to Iceberg**, **Forget Iceberg Sync** and **Refresh**; it has no **Open as Markdown**. Below are cards (tables copied, in sync, out of sync, new in the lake, the snapshot of the copy against the lake's), one row per copied table (state, snapshot of the copy, snapshots the lake changed it since and when, the Iceberg snapshot remembered and current, rows, notes such as converted columns or why it could not be checked) and a filter. A table that the last sync could not write has a row of the state **Error**: only its name and, under Notes, the reason; it counts as out of sync and not as new in the lake. **Refresh** checks the copy again. **Sync to Iceberg** brings everything synced to the target up to date ([Bringing a sync up to date](#bringing-a-sync-up-to-date)); when Iceberg tables were changed after the last sync, the question says that those changes are lost. **Forget Iceberg Sync** removes aantje's record and the row; the Iceberg tables stay.

## Security

- The client secret appears only in `CREATE OR REPLACE SECRET` and is registered with the log redactor and with the scrubbing of error messages.
- A Fabric lakehouse stores no secret: the token of the Microsoft account goes only into the non-persistent secrets `aantje_iceberg` and `aantje_iceberg_onelake` (the latter limited to the workspace), with the same masking. aantje creates a lakehouse only after a confirmation and never deletes one.
- The data leaves the machine that runs aantje: DuckDB reads the lake and writes to the storage of the catalog, also across clouds. The confirmation says so.
