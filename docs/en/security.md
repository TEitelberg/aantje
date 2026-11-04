# Security

This page is the security model of aantje: what it defends against, which guards exist, and where they end.

## Threat model

aantje is a client. It opens the databases you configure, with the credentials you give it, and shows what it finds. It is designed against these risks:

- **Changing a catalog by mistake.** A catalog is the single source of truth of a lake. The explorer has no write path. The SQL editor does, on purpose; [The SQL editor](#the-sql-editor) says what guards it.
- **Leaking a password.** A password can end up in a synced settings file, a log, an error message, a tooltip or a screenshot. aantje keeps passwords, Quack tokens and S3 keys in the VS Code secret storage only, and redacts everything it logs or shows in an error.
- **A project that steers aantje.** Opening a folder must not make aantje connect to a server the folder's author chose, or hand your stored password to it. Profiles come from your machine settings only; aantje reads nothing from the workspace.
- **Hostile content in a catalog.** Names, comments and view SQL are data written by whoever wrote to the lake. aantje shows them as text, and the metadata queries never contain them as SQL. Two things go further: Copy DDL composes SQL text from them for you to run elsewhere (see [Rules for code changes](#rules-for-code-changes)), and DuckDB runs the SQL of a view when its columns or rows are requested, but only for a connection you trusted ([Reading data](#reading-data-tables-and-views)).
- **A catalog that steers the data engine.** Select Top 1000 Rows and Create Notebook run a DuckDB with external access enabled against a catalog someone else may have written. [What a hostile catalog can and cannot do](#what-a-hostile-catalog-can-and-cannot-do) lists the result.
- **A database that does not answer.** PostgreSQL, DuckDB and Quack queries have a timeout (`aantje.queryTimeoutSeconds`) and can be cancelled; a Quack query that a hung server holds is given up. The SQLite driver reads the file into memory first, so it cannot wait on a lock; it has no timeout and its memory use grows with the file.

Not covered: someone who controls the machine or the extension host can read the secret storage and every file aantje can read. aantje does not harden your database server; give the catalog connection a role that may only read the `ducklake_*` tables (on a Quack server, a token that the server allows to read and nothing else). A DuckDB file is parsed by native code inside the extension host, so open catalog files only from sources you trust.

## Read-only guarantee

This is the guarantee of the explorer: the tree, tooltips, snapshot selection, search and the data preview. The SQL editor is not covered ([The SQL editor](#the-sql-editor)). There are two layers. The reader issues only fixed-text `SELECT` statements (snapshot-dependent ones start with `WITH snap AS (SELECT CAST(? AS BIGINT) AS id)`). And every driver opens its database read-only, so the guarantee does not depend on the caller. The Quack driver is the exception: only the first layer holds there ([Quack](#quack)).

### SQLite

`openSqlite` reads the whole file into memory (sql.js) and works on that copy. The original is never opened for writing, and a writer holding a lock does not block reading. The copy also runs with `PRAGMA query_only = ON`. The connection shows the file as it was when opened; reconnect to see newer commits. A catalog with a non-empty `-wal` file is refused, because the log is not in the main file and its data would be missing silently.

### DuckDB

`openDuckdb` opens the file with `READ_ONLY` and sets `enable_external_access` to `false`, so a hostile file cannot make DuckDB read other files or reach the network. If a writer holds the file, the connection fails with `LOCKED` instead of waiting. The reverse holds too: while aantje is connected, writers are locked out (a DuckDB limit). A DuckDB-file catalog suits a single client; use PostgreSQL for several.

### PostgreSQL

`openPostgres` starts the session with `default_transaction_read_only=on`, sets a statement timeout and labels the session `application_name=aantje`. The read-only default protects against mistakes in aantje, not against a user who can change session settings. The real protection is a role with only `SELECT` on the metadata tables ([Catalog reader](catalog-reader.md) lists them):

```sql
-- run as the owner of the catalog database; "ducklake_meta" is the metadata schema
CREATE ROLE aantje LOGIN PASSWORD '...';
GRANT USAGE ON SCHEMA ducklake_meta TO aantje;
GRANT SELECT ON ALL TABLES IN SCHEMA ducklake_meta TO aantje;
```

### Quack

`openQuack` attaches the served database without `READ_ONLY`: DuckDB 2.0.0 accepts the option for Quack but lets writes reach the server, and newer quack builds refuse it. On the client the guarantee rests on the fixed `SELECT` text of the reader. The instance is locked so that no statement on it can reach anything but that server: `allowed_paths` with the one `/quack` endpoint, `enable_external_access=false`, no automatic extension install or load, then `lock_configuration`. The real protection is on the server: a token that the server's `quack_authorization_function` allows to read and nothing else. aantje cannot see what a token may do ([Quack driver](driver-quack.md#read-only-access-and-the-lock)).

## Credentials

- A password is typed in a masked box and stored in the secret storage under `aantje.connection.<id>.password`. The secret storage is encrypted, platform specific, not synchronised and independent of the opened folder.
- `aantje.connections` never contains a password. The store writes each profile from an explicit field list. SQLite and DuckDB profiles have no password.
- Removing a connection deletes its secret. Editing keeps the stored password unless a new one is typed, and only while the target (host, port, database, user; host and port for a Quack token) is unchanged: a password is never sent to another server. A changed host or a new entry that reuses an old id discards the old password.
- A PostgreSQL connection takes its password from the profile and the secret storage only. `PGPASSWORD` and `~/.pgpass` are ignored; without a stored password the connection fails with `AUTH_FAILED`.
- aantje asks for a password only when the server rejects the connection (`AUTH_FAILED`). It asks once, in a masked box, and stores the typed password only after the connection with it worked. A cancelled prompt stores nothing. SQLite and DuckDB are never asked. See [Connections](connections.md).
- A Quack token is a password in all of this: masked input, the same secret key, bound to the server, asked for only after `AUTH_FAILED`, never in the settings, a log, a message or a notebook. It reaches DuckDB only in `CREATE OR REPLACE TEMPORARY SECRET aantje_quack` with `SCOPE 'quack:<host>:<port>'`, so DuckDB sends it to that server only. A parser error in `CREATE SECRET` would repeat the token, so every engine message is masked with it.
- Tooltips and descriptions of connection nodes show the server or file path, never a password. Log lines may name the user.
- `AantjeError.userMessage` is shown to the user and never contains a secret. The original error stays in `cause` and goes only to the redacted log.

### Log redaction

Log lines go through `createLogger(sink, secrets)`. Before a message reaches the "aantje" output channel, the `SecretRegistry` replaces every registered secret with `***` in each form it can take: raw, URL-encoded, JSON-escaped and with doubled single quotes, longest first. The connection store registers each password it reads or writes. Passwords in connection strings (`scheme://user:password@host`, `password=...`) are masked even when unregistered. Redaction applies at every log level.

One function, `maskSecrets` in `src/secrets.ts`, serves both the logger and the engine error path. Known limit: a registered value shorter than three characters (`MIN_SECRET_LENGTH`) is not masked by value, because it would mask unrelated text.

### S3 credentials and the data engine

The data features use three secrets: the PostgreSQL password (or the Quack token), the S3 key id and the S3 secret key.

- **Source.** **aantje: Set S3 Credentials...** stores the keys (the second box is masked) under `aantje.s3.keyId` and `aantje.s3.secretKey`. When nothing is stored, `S3CredentialStore` falls back to `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` of the extension host; one variable alone counts as nothing. Stored keys win, and the Health check says which source is in use. The keys sign every request to `aantje.s3.endpoint`, so use an `https://` endpoint unless the network is yours.
- **The Health panel never holds them.** Its **Set S3 Credentials...** action runs the same command and prompts; the page sends only an action name and a finding id. **Use suggested endpoint** writes `aantje.s3.endpoint` (and `aantje.s3.urlStyle`) at machine scope, only after a modal confirmation that names the setting, the value and where it came from, because that setting decides where the key id is sent.
- **In the engine.** The secrets exist only as non-persistent `CREATE OR REPLACE SECRET aantje_pg`, `aantje_quack` and `aantje_s3` statements in the memory of the private DuckDB instance of one call, which is closed afterwards. The PostgreSQL password and the Quack token are not in the `ATTACH` string.
- **Scrubbing.** DuckDB errors may quote the failing statement. Every engine message is cut to its first line and passed through `maskSecrets` with `secretsOf` (`src/data/errors.ts`), the same masking as the logger. The `cause` of the `AantjeError` is scrubbed too.
- **Log.** Every secret that `S3CredentialStore` hands out is registered with the `SecretRegistry`.
- **Not covered.** The scrubber replaces exact values; a secret that DuckDB prints in another form is not recognised. A notebook runs in the user's Python kernel, where nothing scrubs output ([Notebooks](#notebooks)).

### Azure DuckLake

[Azure DuckLake](azure-lake.md) creates cloud resources and uses a Microsoft Entra sign-in, so the rules are stated here.

- **What is created.** A PostgreSQL flexible server with public access and one firewall rule for your public IPv4 address (no `0.0.0.0` rule), TLS required; a storage account with shared key access, public blob access and TLS below 1.2 refused. Both are in the subscription and resource group you pick.
- **Who gets which role.** You get **Storage Blob Data Contributor** on the storage account, nothing on the resource group, the subscription or the server. The principal ID comes from the `oid` claim of your own token; aantje decodes it without checking the signature, because it only fills your own role assignment and Azure decides whether the deployment may create it. aantje checks first that you may write role assignments, to avoid a failed deployment; that check is advice, not a barrier.
- **What stays with you.** Who else may read the storage account, backups, patching windows, the cost, and the deletion of resources of a lake that aantje did not create. aantje manages a lake only for create and delete.
- **Tokens.** aantje never stores a token. It asks VS Code for them (`vscode.authentication.getSession('microsoft', ...)`) with the scopes `https://management.azure.com/.default` (Resource Manager) and `https://storage.azure.com/.default` (storage), and `VSCODE_TENANT:<id>` for the tenant you pick. The storage token reaches the engine only as a non-persistent DuckDB secret `aantje_azure`; it is registered with the log redactor and `secretsOf` masks it in engine errors. With **Microsoft Entra** as the PostgreSQL sign-in a third scope, `https://ossrdbms-aad.database.windows.net/.default`, gives a token that is the password: the explorer passes it to the PostgreSQL driver, the engine puts it into the non-persistent secret `aantje_pg`. It is masked in the same way and never stored; a connection in Entra mode has no password in the secret storage.
- **Entra administrator.** In Entra mode the template registers the deploying user as Entra administrator of the server, with the name from the `upn` (else `preferred_username`) claim of the token, and keeps the local password login enabled as break-glass access. The generated local password is not kept in that mode; to use the break-glass login an owner resets it in the portal. Further people are added by SQL ([Azure DuckLake](azure-lake.md#giving-another-person-access)).
- **The password** (password mode) of the PostgreSQL administrator is generated by aantje (cryptographically random), sent to Azure only as a secure parameter of the deployment, and stored in the secret storage under the id of the connection, like any other password. It is not an output of the template, because the outputs of a deployment are readable by everyone who can read the deployment. The password is shown nowhere. If you deploy with the portal, you choose it yourself.
- **The IP lookup.** To fill the firewall rule aantje sends one HTTPS request to `https://api.ipify.org` when you create a lake and when you run **Allow My IP**, and only then. The address is used for the rule and not stored by aantje.
- **Allow My IP** changes one thing: the firewall rule `client-ip` of the PostgreSQL server of the lake, through Azure Resource Manager with your Microsoft sign-in, after you confirmed the address and the server. It writes a single IPv4 address, never `0.0.0.0` or a range, and no other rule. A lake that aantje did not create is found by its host name among the servers of the subscriptions your account can read; the command needs the right to write firewall rules on the server and says so when you lack it.
- **Delete** removes the resource group only if aantje created it for that lake and it holds nothing else; otherwise just the server and the storage account. It needs the lake name typed and a second confirmation.
- **Not verified.** The feature has not run against a real subscription; see [what is verified](azure-lake.md#what-is-verified-and-what-is-not).

## Connection profiles and the machine scope

Profiles live in `aantje.connections`, declared with `"scope": "machine"`. VS Code applies such a setting only from the user settings (on a remote host, that host's machine settings); workspace and folder values are ignored, and Settings Sync does not carry it.

- A repository cannot ship a `.vscode/settings.json` that adds a connection and so receives the stored password of a profile with the same id.
- Host names, users and paths of one machine do not travel to another.

Every setting of aantje has machine scope: `aantje.connections`, `aantje.queryTimeoutSeconds`, `aantje.s3.endpoint`, `aantje.s3.region`, `aantje.s3.urlStyle`, `aantje.duckdb.extensionDirectory` and `aantje.sql.maxRows`. A manifest test pins this. Two would be dangerous at workspace scope: a workspace-chosen `aantje.s3.endpoint` would receive requests carrying the stored key id, and a workspace-chosen `aantje.duckdb.extensionDirectory` would make DuckDB load native extensions from a folder the workspace chose.

A profile holds the kind, name, connection details (host, port, database, user, metadata schema, TLS flag, certificate fingerprint or file path) and an id. These are not secrets but describe your infrastructure.

## Workspace trust and virtual workspaces

aantje reads no file from the workspace and runs nothing from it. Its inputs are the machine settings, the secret storage and the catalogs the profiles point to.

- **Virtual workspaces:** `capabilities.virtualWorkspaces.supported` is `false`. Catalogs are local files and network connections.
- **Untrusted workspaces:** `capabilities.untrustedWorkspaces.supported` is `true`, so aantje stays enabled in Restricted Mode. This is safe because all settings are machine-scoped, nothing is read from the workspace, and nothing from it is executed (no tasks, scripts, notebooks or paths). A manifest test pins the value.
- **Servers without Workspace Trust** (code-server with `--disable-workspace-trust`) have no Restricted Mode. The machine scope is then the only barrier between a workspace and your connections.

## Running in code-server

The extension host runs on the server. A SQLite or DuckDB path is a path on the server, and `localhost` in a PostgreSQL or Quack profile means the server.

- **Profiles** are written to `Machine/settings.json` in the code-server user data directory (`--user-data-dir`, default `~/.local/share/code-server`). A start script that rewrites that file must keep the `aantje.connections` array, and in a container the directory must be on a volume.
- **Secrets.** By default code-server keeps the secret storage in the browser (local storage of the origin, `secrets.provider`), not in clear text and in no file on the server. A restart keeps passwords. A second browser, another device, cleared site data or another origin has an empty storage, and aantje asks for the password again; the profile is unaffected.
- **Other users.** Every terminal of a code-server session runs as the same OS user as the extension host. The secret storage keeps passwords out of settings, logs and repositories; it is no barrier against someone with a shell there. Protect the code-server login and its volumes.

## TLS for PostgreSQL

The profile has an `ssl` flag. If the entry has no value, it is `true` for every host except the local machine (`localhost`, `127.0.0.1`, `::1`). An explicit `"ssl": false` is kept. The wizard asks "Use TLS for the connection?" and preselects Yes for remote hosts and No for local ones.

With TLS off, the catalog contents and the login cross the network unencrypted; use that only for `localhost` or a network you fully control. With TLS on, the driver requires a certificate that the Node.js process trusts and that matches the host name. `PGSSLMODE` and `NODE_TLS_REJECT_UNAUTHORIZED` cannot weaken this, and no switch accepts an untrusted certificate. For a private certificate authority, set `NODE_EXTRA_CA_CERTS` in the environment of the extension host.

The data preview and the notebook use DuckDB for the same server. They verify against the OpenSSL trust store (`SSLMODE 'verify-full'`, `SSLROOTCERT 'system'`), and with TLS off the secret says `SSLMODE 'disable'`, because DuckDB's PostgreSQL client would otherwise try TLS first and fall back to cleartext unchecked. Both paths do what the profile says. DuckDB does not read `NODE_EXTRA_CA_CERTS`; a private authority must be in the system trust store for the data features.

## TLS for Quack

A Quack profile has the same `ssl` flag with the same default. TLS off (`DISABLE_SSL true` for the explorer, `META_DISABLE_SSL true` for the data engine) sends the token and the catalog unencrypted; use it only for `localhost` or a network you fully control. With TLS on, DuckDB checks the certificate against the system trust store, or, with a `fingerprint`, accepts that one certificate only (`SSL_FINGERPRINT`, `META_SSL_FINGERPRINT`; only with TLS on, because quack refuses a pin with TLS off). The explorer, the data engine, the SQL editor and the notebook all do what the profile says.

- **Trust on first use.** Add Connection reads the certificate that the server presents (`src/connections/fingerprint.ts`, Node.js `tls.connect` without verification) and shows its SHA-256 fingerprint in a modal dialog. It is pinned only after you confirmed it. Compare it with the fingerprint on the server first: whoever answers this first connection could present any certificate. Edit Connection keeps an unchanged certificate without asking and shows a changed one again. Declining offers to keep the pinned certificate or to use the system trust store.
- **A pin, not a CA file.** `SET GLOBAL ca_cert_file` would make DuckDB trust a self-signed certificate too, but it replaces the trust store of `httpfs` for every HTTPS request of the engine, so public HTTPS endpoints then fail. A pin applies to the one attach.
- **A mismatch** fails with `CONNECTION_FAILED` and says that the certificate does not match the pin; aantje never pins a new one by itself.
- **Not tested:** a certificate from a public CA.

## Reading data: tables and views

Select Top 1000 Rows, Create Notebook, the columns of views in the explorer, the changes grid, the health check, the Maintenance Advisor and the SQL session use a private in-memory DuckDB with the DuckLake extension ([Data access](data-access.md)). It runs with external access enabled, because S3 (`httpfs`) and PostgreSQL metadata need it; the metadata reader, by contrast, switches it off for DuckDB files. That is why tables and views are treated differently.

- **Tables never execute catalog SQL.** aantje builds the statement from quoted names, attaches the lake `READ_ONLY`, locks the configuration (`SET lock_configuration = true`) and runs no SQL a user typed. Writes and a change of `enable_external_access` are refused afterwards. The lock stops setting changes; it is not a sandbox against statements, which is why the engine runs only what aantje built. Before the lock, `autoinstall_known_extensions` and `autoload_known_extensions` are switched off, so a view cannot pull in another core extension.
- **Engine limits.** Engines opened through `guardedOpen` have persistent secrets off, a private temporary directory (mode 0700, removed on close) and a memory limit of 2 GiB (`MEMORY_LIMIT` in `src/data/instance.ts`). The DuckDB-file driver, the language service and the dependency parser use separate instances with external access off.
- **Views run catalog SQL.** A view is SQL text stored in `ducklake_view` by whoever could write to the lake. DuckLake stores no typed columns, so learning the columns means binding the view, and showing rows means running it. With external access on, that SQL can read local files (`read_csv`, `read_text`, `glob`), reach the network and call table functions. Binding alone leaks: `read_csv('<file>')` returns the file's first line as column names.
- **Maintenance functions bypass the lock.** A view such as `SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)` deletes files scheduled for deletion even though the lake is `READ_ONLY` and locked. Before a view is bound or run, `guardRelation` (`src/data/guard.ts`, with `view-closure.ts`, `queries.ts` and `file-origins.ts` in `src/data/guard/`) reads the view SQL from the catalog and parses it with `json_serialize_sql`, which never executes it. It follows the views and macros the SQL names and refuses the view when any of them:
  - calls a `ducklake_*` function other than the read-only ones (`ducklake_snapshots`, `ducklake_options`, `ducklake_list_files` and the like), also without the prefix, because DuckLake stores `lake.merge_adjacent_files()` as `merge_adjacent_files()`; the names come from `duckdb_functions()` of the running engine, with a fixed fallback list, so functions of a newer DuckLake are refused too;
  - calls `checkpoint`, `force_checkpoint`, `query`, `query_table` or `json_execute_serialized_sql` (dynamic SQL no check can see);
  - calls a `quack_*` function, on every kind of connection: `quack_query` runs any SQL on a Quack server, with the token of the user who previews the view;
  - uses a catalog- or schema-qualified function call that is not read-only, a macro of the lake or a `system` function;
  - reads a relation or calls a function in any catalog other than the lake (including the `__ducklake_metadata_lake` database, `memory` and `temp`), except `system`, `pg_catalog` and `information_schema`;
  - does not parse into a single `SELECT`.

  It reads only the views and macros the view reaches, so a catalog with thousands of views costs no more than the few that are named. The lake tables a view reads are checked like a table read directly.

- **The guard sees what DuckDB reads.** Checks and read run in one transaction (`withLake`, `src/data/engine.ts`) on a pinned snapshot, so an author of a PostgreSQL catalog cannot swap a safe view for a harmful one in between. On SQLite and DuckDB catalogs the writer is locked out instead. The guard compares names the way DuckDB looks them up (ASCII letters case-folded); a name that matches several relations that way is refused with a message naming the clash. The relation is judged at the snapshot the read binds it at (for Show Changes the end of the range). Whether a view needs the trust confirmation follows from what the guard finds there, not from the tree node kind.
- **Data files are named by the catalog.** A catalog names its Parquet files, including absolute paths and URLs. Before a table is read, the files DuckLake lists for it (`ducklake_list_files`, resolved against the data path) are checked. A file is refused before any request is sent when it is on a server that is neither the origin of the data path, nor the configured S3 endpoint, nor a local file. That covers `http://`, `https://`, `hf://`, `gs://` and schemeless network paths (`\\host\share\f.parquet`, `//host/share/...`), because the operating system would open an SMB or WebDAV connection and, on Windows, send the user's login hash. A `file:` URL is local only with an empty or `localhost` authority. For Show Changes the files of the whole snapshot range are checked. Files on S3 go to the configured endpoint only, with your keys, also for another bucket (`add_data_files` can register such files). A catalog's own `data_path` is followed: the connection is the trust.
- **Where it ends.** The data engine never writes to the catalog. A view that aantje runs for you cannot call the DuckLake functions above. Create Notebook runs the same check, for views and tables, before it writes the notebook. A view touched by SQL you type in the SQL editor is not guarded, by design ([The SQL editor](#the-sql-editor)). The guard is not a sandbox: a view can still read any file the user can read and reach any address, and the function list is that of the tested DuckDB version. The confirmation below stays the real decision.

The decision for views is a one-time confirmation per connection:

- **Confirmation.** Before DuckDB binds or runs a view of a connection for the first time, a modal dialog asks whether you trust the catalog. It names the connection and its location, and says the view SQL runs with your rights, may read files and use the network, that maintenance calls are refused, and that this is no sandbox. "Allow" is remembered (`ViewTrustStore`, in the editor's global state). Until then nothing of a view runs: the `Columns` folder shows a message, Select Top 1000 Rows and Create Notebook ask first, and completion in the SQL editor shows a hint instead of the view's columns and never asks. The `Definition` is shown as text and runs nothing. A decline is not remembered and is not an error; the explorer asks again after the next Refresh, the commands ask each time.
- **Binding.** The trust is bound to the connection id plus its target: host, port, database, user, metadata schema and TLS flag for PostgreSQL, the kind and path for SQLite and DuckDB, the kind, host and port for Quack (not the TLS flag or the fingerprint). Editing the target asks again. Name and password are not part of it, and nothing secret is stored.
- **Revoking.** **aantje: Revoke Trust in Views** withdraws the trust of all connections. Removing a connection withdraws its trust. Afterwards a view asks again on the next read: in the explorer after the next Refresh (an expanded `Columns` folder keeps what it shows until then), in the commands at once.
- **Not a sandbox.** Once allowed, the SQL of that catalog's views runs with the rights of the extension host. Allow it only for catalogs written by people you trust. Tables need no confirmation.

## Notebooks

**Create Notebook** writes cells; aantje runs none. The user runs them in a Jupyter kernel of their choice ([Notebooks](notebooks.md)). The notebook is the user's session, not a sandbox.

- **No secrets in cells.** `NotebookSpec` has no field for a password or key, and `buildNotebook` reads only named fields of the profile and S3 settings. The PostgreSQL password comes from `PGPASSWORD` or `getpass`, the Quack token from `QUACK_TOKEN` or `getpass`, the S3 keys from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` or `getpass`, and reach DuckDB as `CREATE SECRET` statements, never in the `ATTACH` string.
- **Infrastructure is in the cells:** connection name, host, port, database, user or file path, endpoint, region, extension directory, table name. Treat a saved notebook like the settings file and keep it out of a shared repository.
- **Catalog text cannot become code.** Names go through `pyString` (escapes quotes, backslashes, line breaks, control and invisible characters including bidirectional overrides) and `quoteIdentifier`; in Markdown they are code spans.
- **Read-only, not locked.** The `ATTACH` has `READ_ONLY`, except on a Quack catalog: DuckDB 2.0.0 accepts `READ_ONLY` on a Quack attach without enforcing it, and newer quack builds refuse it (`READ_ONLY is not currently supported for Quack databases`), so aantje attaches a Quack catalog without it, so the server decides what the token may change. `lock_configuration` is not set, because the user may load extensions or change settings. The notebook switches off automatic extension install and load.
- **What stays with the user.** The connection cell deletes the secret variables from the kernel after use. Nothing scrubs cell output: a DuckDB error may quote a statement with a secret, and outputs, including query rows, are saved in the `.ipynb`. Clear outputs before committing or sharing.
- **Views.** Create Notebook on a view asks the same confirmation as the preview.
- **One install.** The second cell is `%pip install "duckdb>=2.0.0" pandas`; it runs only when the user runs it.

## The data grid

The grid is a webview built so that data never becomes markup or script ([Data grid](grid.md)).

- **Strict policy:** `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'; base-uri 'none'; form-action 'none'`. The nonce is new for every panel. There is no `unsafe-inline`, no `unsafe-eval`, no event handler or `style` attribute. `localResourceRoots` is the extension's `dist` directory only.
- **No data in the page.** The page is static. Rows arrive by `postMessage` after the page says `ready`, and the client writes them with `textContent`, never `innerHTML`. The title, which contains the table name, is HTML-escaped.
- **Messages from the webview are untrusted.** The host forwards a `copy` or `export` message only if `isWebviewMessage` accepts its shape. The host writes the clipboard. An export always goes through a save dialog; the page's file name is only a suggestion.
- **Spreadsheet formulas.** CSV export, Copy row and Copy all prefix text cells and column names that start with `=`, `+`, `@`, `-`, a tab or a carriage return with `'`. Plain numbers such as `-5` and number, boolean and nested columns are left alone. Copy cell is exact, because it is meant to paste one value into SQL or text.

## The SQL editor

The SQL editor ([SQL editor](sql-editor.md), [SQL session](sql-session.md)) is the one part of aantje that runs SQL a user typed, and it runs any SQL: SELECT, but also CREATE, INSERT, UPDATE, DELETE, ALTER and DROP against the DuckLake. This is on purpose: the rights of the credentials decide, not aantje.

- **Running is the consent.** aantje asks nothing before a statement. The view confirmation belongs to the tree and preview, where catalog SQL runs without the user typing it.
- **The rights are those of the credentials:** the PostgreSQL user on the metadata schema, the token on a Quack server, the S3 key on the data path, the file permissions of a SQLite or DuckDB file.
- **The reach of the process.** The session runs with external access on and an unlocked configuration. The SQL has the rights of the extension host (in code-server, the container user): `COPY ... TO` writes files, `read_text`, `read_csv` and `glob` read them, `ATTACH` creates files, HTTP(S) works once `httpfs` is loaded, and the user may `INSTALL` and `LOAD` extensions (also from the community repository). Automatic installation and loading are off. A view you query in the editor runs with the same reach.
- **Read-only sessions.** The `readOnly` connection switch and **Toggle Read-only Session** attach the lake `READ_ONLY`, and DuckLake then refuses statements that write to it. This guards against a slip and is not a hard guarantee: the session still runs any SQL with its credentials, and known bypasses exist (`ducklake_cleanup_old_files` deletes scheduled files before its metadata write fails, `ducklake_delete_orphaned_files` deletes files without error, a second `ATTACH` of a SQLite or PostgreSQL catalog without `READ_ONLY` is writable). For a guarantee use credentials that may only read. See [What read-only means](sql-session.md#what-read-only-means).
- **No read-only session on Quack.** The switch exists to avoid the lock of a DuckDB file, not as write protection, and a Quack server has no such lock. Quack cannot be attached `READ_ONLY` either: DuckDB 2.0.0 does not enforce it, and newer quack builds refuse it. A Quack session always has full access; what it may change is decided by the server, through the token and its `quack_authorization_function`.
- **Secrets.** The PostgreSQL password, the Quack token and S3 keys exist in the session only in the `CREATE SECRET` statements of its setup. Persistent secrets are off, `duckdb_secrets()` masks values, and every error message the session reports is scrubbed. SQL text and results are the user's data and are not scrubbed.
- **The explorer stays separate.** It reads through its own read-only drivers, so a mistake in the editor cannot change what the tree reads. After a committed change the tree reads the connection again.
- **DuckDB files.** A writable session locks the file exclusively, so the explorer disconnects that connection first. A read-only session shares the file. A Quack server has no lock: the explorer stays connected.
- **The language service never runs text.** Completion, hover and the marks while typing (syntax errors, unknown names) use a separate DuckDB with external access off that only tokenizes and parses. For the columns of a view, completion binds the view's stored SQL the way the explorer does (data engine, view guard), only for a connection whose views you trusted ([SQL IntelliSense](sql-intellisense.md#columns-of-views)).
- **Restricted Mode.** The editor runs nothing by itself: a SQL document in the workspace runs only when the user runs it, on a connection from the machine settings.

## What a hostile catalog can and cannot do

"Hostile" means a catalog written by someone you do not trust: names, comments, view SQL, data paths and data files are theirs.

| It cannot                                      | Because                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Change the catalog                             | The reader has only `SELECT`; every driver opens read-only (a Quack attach cannot, see [Quack](#quack)); the data engine attaches `READ_ONLY` (a Quack catalog with `CREATE_IF_NOT_EXISTS false`) and locks settings. (The SQL editor changes it only with SQL you run.) |
| Delete or write lake files through a view      | `guardRelation` refuses views that call maintenance functions, with names taken from the engine. Not a sandbox: a view can read any file.                                                                                                                                |
| Make aantje run view SQL without your decision | Binding or running a view needs the confirmation of that connection (`ViewTrustStore`).                                                                                                                                                                                  |
| Run code through names, comments or SQL text   | Tooltips escape it, the notebook escapes it (`pyString`), the grid writes `textContent`, Copy DDL is never run.                                                                                                                                                          |
| Read your passwords or S3 keys from aantje     | They are in no catalog or cell, and engine messages are scrubbed.                                                                                                                                                                                                        |
| Make a profile appear or change one            | Profiles come from the machine settings only.                                                                                                                                                                                                                            |

| It can                                                                | Consequence and what to do                                                                                                                                                                                                          |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Show misleading names, comments and data                              | Everything shown is theirs. Do not decide from a tooltip alone.                                                                                                                                                                     |
| Decide which Parquet files a table reads                              | Files may be in another bucket of the same S3 store (read with your keys, request to the configured endpoint only) or on the local disk. Other URLs and network hosts are refused. Give the S3 keys access to the lake bucket only. |
| Make a view read local files or reach the network, once you confirmed | This is what the confirmation is for. Confirm only for catalogs written by people you trust; revoke with **aantje: Revoke Trust in Views**.                                                                                         |
| Make a query slow, large or hanging                                   | The preview reads at most 1001 rows and ends at `aantje.queryTimeoutSeconds`; a stalled network call may end only with DuckDB's network timeout.                                                                                    |
| Put an expression into an exported cell                               | See spreadsheet formulas under [The data grid](#the-data-grid).                                                                                                                                                                     |

A catalog also names files that aantje touches: data file footers (deep health check), the data path (health check listing) and files scheduled for deletion (the Maintenance Advisor asks the store for their size). A hostile catalog can therefore make aantje send a read, listing or `HEAD` to a URL or path the workbench can reach, with your keys when it is the same store, and no trust confirmation is involved (it covers view SQL only). The advisor and the health checks narrow this: they read only a path below the data path (`isBelowDataPath` in `src/catalog/locations.ts`), and the health check does not `stat` a data path that names a network host (`isNetworkPath`). The table preview refuses other servers (`src/data/guard/file-origins.ts`). Open catalogs of people you do not trust only with S3 keys that reach the lake bucket and nothing else.

The metadata reader switches external access off for a DuckDB-file catalog; the data engine cannot, because S3 and PostgreSQL need it. Use DuckDB-file catalogs only from sources you trust.

## What aantje never does

- Write to a catalog on its own. The explorer, preview and notebook never write: no `INSERT`, `UPDATE`, `DELETE` or DDL, no read-write `ATTACH`, no checkpoint or maintenance. The SQL editor writes only what the user runs.
- Execute SQL a user typed outside the SQL editor. The metadata reader uses fixed text with bound parameters; the data engine builds its few statements from quoted names and escaped literals. The notebook is the user's own Python session and aantje does not run it.
- Read the data files of a lake or contact an object store on its own. Only the data commands do, with the S3 settings you configured, or with the Microsoft account of VS Code for an Azure lake.
- Run view SQL without your confirmation for that connection.
- Send telemetry. The network traffic is the PostgreSQL and Quack connections you configured, the S3 endpoint you configured for data commands, the download of DuckDB extensions and, only when you use the Azure commands, Azure Resource Manager, Microsoft Entra, the storage account of an Azure lake and the IP lookup at api.ipify.org.
- Download code at runtime, except the DuckDB extensions `ducklake`, `postgres`, `sqlite` or `quack`, `httpfs` and, for an Azure lake, `azure` from `extensions.duckdb.org` on first use. With `aantje.duckdb.extensionDirectory` set to a prepared directory nothing is downloaded. The notebook's `%pip install` runs only when the user runs that cell.
- Store a password, Quack token or S3 key anywhere but the secret storage, or put a secret into a notebook cell, webview message, log line or error message.

## Rules for code changes

- Never put a password or connection string into an error message, tooltip, log line or test snapshot.
- In the metadata reader SQL is constant text with `?` placeholders; catalog and profile values are never concatenated. The PostgreSQL metadata schema must be a plain identifier and is quoted before it goes into the `search_path` start-up option.
- A new driver or query path of the explorer must be read-only by itself, and its tests must show that a write fails.
- Declare every new `aantje.*` setting with scope `machine`; a manifest test pins it.
- View trust is decided in `guardRelation`, which refuses an untrusted view with `VIEW_UNTRUSTED`. A new read path passes the connection's trust into `DataAccess.viewsTrusted` and turns `VIEW_UNTRUSTED` into the confirmation and a retry. Do not decide trust from a tree node's kind.
- The data engine and notebook builder cannot use placeholders (`ATTACH` and `CREATE SECRET` take none). Every value goes through one escaping function (`quoteLiteral` and `quoteIdentifier` in `src/catalog/ddl.ts`, `pyString`). Add no second way.
- Every error leaving the data engine goes through `maskSecrets` with `secretsOf(access)`. Add a new secret in `DataAccess` to `secretsOf`.
- Keep the webview as it is: nonce policy, no data in markup, `textContent`, and `isWebviewMessage` for everything from the page. A new message type needs a new check.
- Copy DDL composes SQL from catalog text. Identifiers are quoted, but unknown type names, default expressions and view SQL are copied verbatim, so read it before running it elsewhere. Nothing in aantje executes it. Script as CREATE opens the same text; Script as SELECT, ALTER and DROP quote every name and put only the snapshot number into comments, and a table's ALTER consists of comments only. The ALTER of a view copies the stored SQL. A name with a line break is written over several comment lines so it cannot leave the comment. A script runs only when the user runs it (F5).
- Catalog text goes through the escaping in `src/tree/format.ts` before it enters a Markdown tooltip, and a tooltip never enables HTML or command links.
- Review every new runtime dependency: the bundle contains `pg` and `sql.js`, and the VSIX ships the native DuckDB binding.
- Licence notices travel with every copy: the build writes `THIRD-PARTY-NOTICES.md` from the source map (`scripts/notices.mjs`) and the VSIX contains it. The source map is not part of the VSIX.
