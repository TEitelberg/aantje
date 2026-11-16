# Files

The folder **Files** below a connected connection browses the storage of the lake like a file explorer: the bucket, container, OneLake workspace or folder that holds the lake, without the lake's own data files. A CSV, Parquet, JSON or Excel file there becomes a table of the lake with a script that aantje writes and you run. The folder only reads: it uploads, deletes, renames and moves nothing.

## Code

| File                                                       | Job                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `src/files/source.ts`                                      | `FilesPort`: the roots of a connection and one level below a root, for the tree.                                           |
| `src/files/place.ts`                                       | The default root of a data path, whether a root lies on the storage of the connection, directory keys.                     |
| `src/files/listing.ts`                                     | One level: the listing that fits the storage, hidden directories left out, sorted, at most 1000 shown.                     |
| `src/files/local.ts`                                       | A level of a local folder, only below its root.                                                                            |
| `src/files/s3.ts`, `src/files/sigv4.ts`                    | ListObjectsV2 with the delimiter `/`, signed with Signature Version 4.                                                     |
| `src/files/azure.ts`, `src/files/azure-auth.ts`            | List Paths of the DFS API, List Blobs with the delimiter `/`; bearer token, SAS or Shared Key.                             |
| `src/files/aws-chain.ts`                                   | The keys of an AWS credential chain, resolved by the engine.                                                               |
| `src/files/azure-token.ts`, `src/files/entra.ts`           | The Entra token of an Azure or OneLake service principal: client secret or certificate; kept until shortly before its end. |
| `src/files/azure-chain.ts`                                 | The Azure credential chain: environment, workload identity, managed identity, Azure CLI.                                   |
| `src/files/http.ts`                                        | One request with a time limit and no redirect; the error of the storage as one line.                                       |
| `src/files/kinds.ts`, `src/files/scripts.ts`               | The file kinds DuckDB reads and their readers; the import scripts.                                                         |
| `src/files/import-flow.ts`, `src/files/commands.vscode.ts` | The questions of the import commands; Copy Path, Refresh and the import commands.                                          |
| `src/tree/files.ts`                                        | The levels below the folder Files in the tree.                                                                             |

## In the tree

```text
Lake                               duckdb · DuckLake 1.1 · @56
  main
  sales
  Snapshots
  Query History
  Files
    abfss://lake@account.dfs.core.windows.net/
      exports
        orders_2026.csv            12.4 MB · 2026-11-10 08:12
        customers.parquet          3.1 MB · 2026-11-09 17:40
      raw
      readme.txt                   2 KB · 2026-10-01 09:00
```

- **Files** follows **Snapshots** and **Query History**. A Quack connection has no Files folder: the Quack server reads the files there, not aantje.
- One node per root, labelled with its path. Below it folders first, then files, each sorted by name like the rest of the tree. A file shows its size and the time of its last change (local time); the tooltip has the full path, the size in bytes and the time in UTC.
- Lazy: a folder lists its own level when you expand it, never the levels below.
- A folder shows at most 1000 entries. A message node after them says how many more there are. aantje counts up to 10,000 entries of a level; beyond, the message says "more than".
- **Refresh** on Files, a root or a folder lists that part again, without opening the catalog again. The folder does not follow the snapshot that the tree shows: it lists the storage as it is now.

## Roots

Without `fileRoots` the connection has one root:

| Data path of the lake                                            | Root                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `s3://bucket/lake/data/`                                         | `s3://bucket/`                                                 |
| `abfss://lake@account.dfs.core.windows.net/data/`                | `abfss://lake@account.dfs.core.windows.net/`                   |
| `az://lake/data/`                                                | `az://lake/`                                                   |
| `abfss://ws@onelake.dfs.fabric.microsoft.com/l.Lakehouse/Files/` | `abfss://ws@onelake.dfs.fabric.microsoft.com/` (the workspace) |
| `/srv/lakes/shop/data/` (local)                                  | `/srv/lakes/shop` (the folder above)                           |

The profile field `fileRoots` (one or more paths; **Edit Connection** asks for them, separated by semicolons) replaces the default root ([Connections](connections.md#profile-model)). A root lies on the storage of the lake and is listed with the connection's access:

- a local root next to a local data path, written as an absolute path;
- any other root on the service of the connection's storage, in any bucket or container: the S3 endpoint, the R2 account, the Azure storage account, OneLake.

A root on another storage gets a message node instead of a listing: another storage needs a connection of its own. A root of a kind the folder does not list (Google Cloud Storage, HTTP) gets one too. A catalog without a data path, or with a data path on such a storage, shows a message that points to `fileRoots`.

## What is hidden

- The data path of the lake.
- The directories that the catalog gives schemas and tables of their own (`path` of `ducklake_schema` and `ducklake_table`, every version, resolved against the data path).

Nothing else is hidden. A file that the catalog registered elsewhere (`ducklake_add_data_files`) shows like any file. A root that you set yourself is listed as it is, even when it is the data path.

## How each storage lists one level

DuckDB's `glob()` lists files, not folders, and on S3 even `glob('s3://bucket/*')` walks every prefix of the bucket. So aantje asks the storage for one level itself, with plain HTTPS requests from `node:crypto` and `fetch`, and no SDK. The sign-in is the one of the connection's storage ([Data access](data-access.md#storage-of-a-connection)), from `resolveStorage` like the engine's: the same keys, token or SAS, read from the secret storage.

| Storage                      | Request                                                                                                                                                               | Sign-in                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local disk                   | `opendir` and `stat` of the folder                                                                                                                                    | the user of the extension host                                                                                                                                                        |
| AWS S3                       | ListObjectsV2 with `delimiter=/`, virtual-host style, the region of the storage (a bucket in another region answers with its region, and aantje asks there once more) | keys (SigV4); the credential chain through the engine (below); unsigned only with the global settings                                                                                 |
| S3-compatible, R2            | ListObjectsV2 with `delimiter=/` at the endpoint, path or virtual-host style as the engine uses it                                                                    | keys (SigV4)                                                                                                                                                                          |
| Azure ADLS Gen2 (`abfss://`) | DFS "List Paths" with `recursive=false`                                                                                                                               | Entra ID (the token of the editor's Microsoft sign-in), account key (Shared Key), SAS, connection string, service principal and credential chain (a token that aantje fetches, below) |
| Azure Blob (`az://`)         | "List Blobs" with `delimiter=/`                                                                                                                                       | the same                                                                                                                                                                              |
| OneLake                      | DFS "List Paths" on `onelake.dfs.fabric.microsoft.com`                                                                                                                | Entra ID, service principal, credential chain                                                                                                                                         |

- **AWS credential chain.** aantje does not resolve SSO, profiles or the environment itself. A private, short-lived engine creates the same secret that the lake is read with and hands back the keys that the chain resolved; they sign the listing and are reused for five minutes.
- **Missing sign-in values.** A storage of the connection whose sign-in needs values that are not stored yet (S3 keys, an account key, a SAS, a connection string, the client secret of a service principal) is not asked: an unsigned request would only be refused. The folder shows a message node instead that says the connection has no sign-in values for its storage; a click runs **Set Storage Sign-in...** for the connection ([Connections](connections.md#set-storage-sign-in)). Only a connection without a storage of its own, whose global S3 settings hold no keys, lists unsigned: a bucket that allows anonymous reads.
- **Azure service principal and credential chain.** The engine's azure extension resolves these sign-ins for the lake but hands out no token, so the Files folder fetches its own token for the storage audience (`https://storage.azure.com/.default`, which OneLake accepts too) with plain HTTPS requests, no SDK:
  - A service principal with a client secret: the OAuth 2.0 client credentials grant at `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, with the tenant and client ID of the storage and the client secret from the secret storage.
  - A service principal with a certificate: the same request with a client assertion instead of the secret, a JWT signed PS256 with the private key of the PEM file at `certificatePath` (the certificate and an unencrypted RSA key in one file), with the SHA-256 thumbprint of the certificate (`x5t#S256`), as Microsoft documents certificate credentials. The file is read each time a token is needed.
  - A credential chain: the providers of `chain` in their order, `default` (or no `chain`) for `env;workload_identity;managed_identity;cli`, the order of the Azure SDK that DuckDB uses. `env` signs in the service principal of `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` or `AZURE_CLIENT_CERTIFICATE_PATH`; `workload_identity` uses the federated token in `AZURE_FEDERATED_TOKEN_FILE` as the client assertion of `AZURE_CLIENT_ID`; `managed_identity` asks the instance metadata service of an Azure machine (system-assigned identity); `cli` runs `az account get-access-token --resource https://storage.azure.com/ --output json`. A provider that fails hands over to the next; when none gives a token, the folder shows a message node with each provider and its reason.
  - A token is kept in memory for the connection and its sign-in until five minutes before it runs out, and shared by the folders that list meanwhile; a failure is not kept, so the next listing asks again. Only the public Azure cloud is supported: `AZURE_AUTHORITY_HOST` is not followed, and managed identities of App Service, Azure Arc and Cloud Shell, which do not use the instance metadata service, are not covered.
- Google Cloud Storage is out of scope, as it is for the storage of a connection.
- Requests carry the signature or token only to the endpoint of the storage, never to a host that a path or a catalog names, and follow no redirect.
- A storage that refuses a listing (no permission, an expired token, a missing bucket) shows its own error as a message node, for example `The storage refused the listing (HTTP 403): AccessDenied: Access Denied`. aantje restricts nothing itself: what the storage lets the sign-in see is listed, what it refuses is not.
- A request ends after the time of `aantje.queryTimeoutSeconds`, also a token request; the instance metadata service gets at most 3 s and the Azure CLI at most 30 s.

## Context menu

| Entry                                       | On                                       |
| ------------------------------------------- | ---------------------------------------- |
| **Refresh**                                 | Files, a root, a folder                  |
| **Copy Path**                               | a root, a folder, a file                 |
| **Script as Import into New Table...**      | a root, a folder, a file of a kind below |
| **Script as Insert into Existing Table...** | a root, a folder, a file of a kind below |

The kinds of file that get the import entries (the letter case of the name does not matter); other files get Copy Path only:

| Kind     | Ends with                                     | Reader                                                           |
| -------- | --------------------------------------------- | ---------------------------------------------------------------- |
| CSV, TSV | `.csv`, `.tsv`, also with `.gz` or `.zst`     | `read_csv`                                                       |
| Parquet  | `.parquet`                                    | `read_parquet`                                                   |
| JSON     | `.json`, `.jsonl`, `.ndjson`, also with `.gz` | `read_json`                                                      |
| Excel    | `.xlsx`                                       | `read_xlsx`; the script starts with `INSTALL excel; LOAD excel;` |

**Script as Import into New Table...** asks for the schema of the lake and proposes the name of the file, without its ending, as the name of the table:

```sql
CREATE TABLE "sales"."orders_2026" AS
SELECT * FROM read_csv('abfss://lake@account.dfs.core.windows.net/exports/orders_2026.csv');
```

**Script as Insert into Existing Table...** asks for a table of the lake and adds the rows by column name:

```sql
INSERT INTO "sales"."orders" BY NAME
SELECT * FROM read_csv('abfss://lake@account.dfs.core.windows.net/exports/orders_2026.csv');
```

On a folder or a root, both read all files of one kind on that level through a glob with `union_by_name = true`. When the level holds several kinds (`.csv` and `.parquet`, or `.csv` and `.CSV`, which one glob cannot both match), aantje asks which. The comment says how to take in the subfolders:

```sql
-- Reads all files of the pattern on this level of the folder.
-- To include the files of the subfolders, write **/ in front of the * of the pattern.
CREATE TABLE "main"."exports" AS
SELECT * FROM read_parquet('s3://bucket/exports/*.parquet', union_by_name = true);
```

Excel files are imported one file at a time: `read_xlsx` reads a single file, and given a glob it reads only the first match.

Every script opens as a new, unsaved SQL document bound to the connection. Nothing runs: you check, edit and run it. The import copies the rows; the source file stays as it is. The SQL editor's session may install and load `excel` itself (`INSTALL` needs the network once, or an extension directory that holds it), on a local file as on S3 or Azure.

## Safety

File and folder names are data of whoever writes to the storage.

- A label shows the name as text (`visibleLine`: no control or format character, white space on one line); pickers show names through `pickerLabel`, the status bar through `withoutIcons`; tooltips put the path in a code span.
- In a script a path is only a quoted literal (`quoteLiteral`). In a single-file script the glob characters of the path are escaped (`escapeGlob`: `*`, `?` and `[` become `[*]`, `[?]` and `[[]`), so `a*b.csv` reads exactly that file and not `axb.csv`. A folder pattern escapes the folder the same way.
- The proposed table name is a quoted identifier; no name of a file or folder appears in a comment of a script.
- A local root lists only below itself: the folder and each link in it are resolved, and a folder or link that resolves outside the root is not listed.

## Not in this feature

A preview of a file, taking over Parquet files without a copy (`ducklake_add_data_files`), Delta and Iceberg folders, Avro and spatial formats, writing to the storage.
