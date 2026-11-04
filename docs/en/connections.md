# Connections

`src/connections/` turns the `aantje.connections` setting into validated connection profiles, keeps passwords and Quack tokens in the editor's secret storage, implements the dialogs to add, edit and remove a connection, and opens a catalog, asking for the password or token only when the server needs it. A lake in Azure is created and imported by `src/azure/` ([Azure DuckLake](azure-lake.md)); it saves its profile and password through the same store. The editor is reached through three ports in `ports.ts` (`SettingsPort`, `SecretsPort`, `WizardUi`); only `ports.vscode.ts` imports `vscode`.

| File              | Job                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `profile.ts`      | Profile types, tolerant parsing of the setting, ids, input validators                           |
| `store.ts`        | `ConnectionStore`: profiles in the setting, passwords in the secret storage                     |
| `connect.ts`      | `openWithPassword`: opens a catalog, asks for the password only if needed                       |
| `wizard.ts`       | The add, edit and remove flows on top of `WizardUi`                                             |
| `fingerprint.ts`  | `certificateFingerprint`: the SHA-256 fingerprint of a TLS server's certificate, for the wizard |
| `ports.ts`        | Interfaces to the editor                                                                        |
| `ports.vscode.ts` | VS Code implementations of the ports                                                            |

## Profile model

A profile says where the DuckLake metadata tables (`ducklake_*`) are stored. The `kind` selects one of three shapes; all have an `id` and a `name`.

| Kind               | Further fields                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postgres`         | `host`, `port` (default 5432), `database`, `user`, optional `metadataSchema`, `ssl` (default `true`; `false` for `localhost`, `127.0.0.1` and `::1`), optional `azureAccount`, `azureTenant` and `azureAuth` |
| `sqlite`, `duckdb` | `path` of the database file                                                                                                                                                                                  |
| `quack`            | `host` (not `quack`), `port` (default 9494), `ssl` (default as for `postgres`), optional `fingerprint`                                                                                                       |

A `quack` profile is a DuckDB server that serves the catalog over Quack ([Quack driver](driver-quack.md)). It reuses the `ssl` property of `postgres`, with the same meaning and the same default rule (`defaultSsl`), instead of a new `tls` property: one TLS property, one wizard question. `fingerprint` is the SHA-256 fingerprint of the server certificate, 64 hex digits with or without colons, stored as `AB:CD:...` (`normalizeFingerprint`). It pins that certificate instead of the system trust store and needs `ssl: true`. The host name `quack` is refused (`validateQuackHost`), because the quack client then parses `quack:quack:<port>` wrongly.

A `postgres` profile with `azureAccount` is an Azure lake: its data files are on that ADLS Gen2 storage account and are read with a Microsoft Entra token, which `azureTenant` (optional) names the tenant of. No key or token is in the profile ([Azure DuckLake](azure-lake.md)). `azureAuth` is `"password"` (the default when absent) or `"entra"`: with `entra` a token of your Microsoft account is the password, `user` is your user principal name and no password is stored. The connection then ignores any stored password and does not ask for one. **Create Azure DuckLake...**, **Finish Creating Azure DuckLake...** and **Import Azure DuckLake...** write these fields; Add Connection and Edit Connection ask for them ([below](#signing-in-with-microsoft-entra-id)).

`postgres`, `sqlite` and `duckdb` profiles can carry `readOnly`: the SQL editor then opens its sessions on this connection read-only ([SQL editor](sql-editor.md)). Absent means writable. The explorer ignores it, because it is read-only anyway. A `quack` profile with `readOnly` is refused: the switch exists to avoid the lock of a DuckDB file, a Quack server has none, and what the token may do is the server's decision.

A profile never contains a password. The password of a `postgres` profile lives in the secret storage under `aantje.connection.<id>.password`, and the token of a `quack` profile under the same key. SQLite and DuckDB profiles have no secret.

The stored secret carries the server it was given for (host, port, database and user; host and port for a Quack token). `store.password(profile)` returns the password only when that target matches, so a password is never sent to a server it was not given for: after the host is edited, or after a new entry reuses an old id, the user is asked again and the orphaned secret is removed on the next `update` or `remove`.

## Settings format

`aantje.connections` is a machine-scoped array, so a workspace cannot smuggle a connection into the user's editor.

```jsonc
[
  // Minimal: the id (example-lakehouse) and the port (5432) are derived. Without "ssl" a remote host gets TLS;
  // this server sits in an internal network and has none, so the entry says so.
  {
    "name": "Example Lakehouse",
    "kind": "postgres",
    "host": "postgres",
    "database": "ducklake",
    "user": "ducklake",
    "ssl": false,
  },
  {
    "id": "lab",
    "name": "Lab (TLS)",
    "kind": "postgres",
    "host": "lab.example.org",
    "port": 6543,
    "database": "lake",
    "user": "reader",
    "metadataSchema": "ducklake_meta",
    "ssl": true,
  },
  { "name": "Local SQLite", "kind": "sqlite", "path": "D:\\data\\ducklake.sqlite" },
  { "name": "Local DuckDB", "kind": "duckdb", "path": "/data/ducklake.duckdb", "readOnly": true },
  // A DuckDB server that serves the catalog over Quack: port 9494 and TLS are derived, the pin replaces the system
  // trust store.
  {
    "name": "Served lake",
    "kind": "quack",
    "host": "lake.example.org",
    "fingerprint": "5C:9E:12:7A:B3:40:6D:E8:21:F4:0B:97:C6:3A:58:E1:0F:72:AD:94:3B:C8:16:E5:7D:20:A9:4F:B1:63:08:DE",
  },
]
```

`parseProfiles(raw)` reads the value tolerantly and returns `{ profiles, problems }`; it never throws.

- `name` is required and unique, ignoring case and surrounding spaces.
- `postgres`: `host` (no spaces, not a URL), `database` and `user` are required; `port` is an integer from 1 to 65535; `ssl` and `readOnly` are booleans. A text such as `"true"` is rejected, not guessed.
- `sqlite` and `duckdb`: `path` is required and must not be wrapped in quotes.
- `quack`: `host` is required and must not be `quack`; `port` and `ssl` as for `postgres`; `fingerprint` must be a SHA-256 fingerprint and needs `"ssl": true`; `readOnly` is refused.
- Unknown properties are ignored; text values are trimmed.
- An entry that breaks a rule is skipped and reported as `aantje.connections[<index>]: <reason>` (the first reason per entry). The other entries are not affected.
- A value that is not an array is one problem, and nothing is written over it.

The wizard uses the same validators as the parser, so what it accepts is accepted when the setting is read again.

### Ids

The `id` is optional. Without it the profile gets the slug of its name: lower case, accents removed, other characters replaced by `-` (`Café Münster` becomes `cafe-munster`; a name without letters or digits becomes `connection`). A collision gets a numeric suffix (`prod-db`, `prod-db-2`).

- Explicit ids win and are reserved first, so adding or repairing an entry never changes the id of another. A second entry with the same explicit id is skipped.
- The id is the key of the stored password, so it must stay stable. The wizard always writes the id. Before you rename a hand-written entry without `id`, add `"id"` with the old slug.

### Hand-edited entries

The setting belongs to the user. `ConnectionStore` replaces only the entry it works on: `add` appends, `update` replaces in place, `remove` drops it. Every other element, including entries that cannot be parsed, is written back unchanged. A setting that is not an array is not overwritten (`INVALID_PROFILE`). An entry is built from an explicit list of fields (`toSettingEntry`), so a password cannot reach the setting. `update` writes the setting only when the profile changed, so storing just a password leaves a provisioned entry untouched.

## Passwords

Passwords exist only in the secret storage and in memory while the wizard or a connect runs. Settings are plain text that people sync and commit. A Quack token is handled like a password in everything below.

- `add` stores the password; without one it deletes a leftover secret of an earlier connection with the same id.
- `update` replaces the password; an empty password keeps the stored one. A profile that signs in with Entra (`azureAuth: "entra"`) keeps none: `update` deletes the stored password.
- `remove` deletes the entry and the secret.
- Every password the store reads, stores or is told about is passed to the log redactor, so it is masked in the log.

## Connecting

`openWithPassword(profile, deps)` is what the tree calls when a connection is expanded, connected or refreshed, and what Test Connection calls. It takes the store, `open(profile, password)` (`openCatalog`, which rejects with an `AantjeError` and leaves nothing open) and `askPassword(profile, previousRejected)` (a masked input box).

1. A `sqlite` or `duckdb` profile opens without a password. Nobody is asked.
2. A `postgres` or `quack` profile opens with the stored password or token, or without one when none is stored. If that works, the user is never asked.
3. Only `AUTH_FAILED` leads to a question (the server wants a password and none is stored, the password is wrong, or the user is not accepted). For Quack that is `Authentication failed` (the server refused the token) or `Could not find a Quack authentication token` (none is stored; the client refuses before it sends anything). `previousRejected` is `true` when a stored password was refused. The prompt says Token instead of Password for a Quack connection.
4. A cancelled or empty answer throws the original error.
5. The typed password is registered with the redactor and the catalog is opened again with it.
6. Only after that second attempt succeeded is the password stored. If it fails, its error is thrown and nothing is stored, so a typing error never replaces a good password. There is no third attempt; the user connects again.

Any other error (`CONNECTION_FAILED`, `TIMEOUT`, ...) is thrown as it is, without a question. A reader that the first attempt returned is never replaced. If storing the password fails after the catalog opened (locked secret storage), the reader is closed and the store's error is thrown, so the problem is not hidden. A secret storage that cannot be read fails the same way, before any attempt. Errors of the ports are not caught here; the command handler shows them.

## Wizard flows

The flows take a `WizardUi` and `WizardDeps` (`store`, `testConnection`, `certificateFingerprint`, and `entraUser`, the sign-in name of the Microsoft account of VS Code). A cancelled prompt returns `undefined` and saves nothing, at every step.

### Add

1. Pick the kind: PostgreSQL, SQLite, DuckDB or DuckDB + Quack.
2. Name, then for PostgreSQL host, port (prefilled 5432), database, the sign-in (Password or Microsoft Entra ID, [below](#signing-in-with-microsoft-entra-id)), user, the TLS choice and the password (masked, may stay empty; not with Entra); for SQLite and DuckDB the file path; for DuckDB + Quack host, port (prefilled 9494), the TLS choice, the certificate (only with TLS) and the token (masked, required). The last question for PostgreSQL, SQLite and DuckDB is the read-only choice; Quack has none. Steps are numbered, for example `Add Connection (1/9)` for PostgreSQL with a password and `(1/3)` for the file kinds; the total follows the answers that decide which questions come.
3. `testConnection` opens the catalog and reads its info, inside a progress notification.
4. On success the profile and password are saved and the DuckLake spec version and latest snapshot are reported.
5. On failure the user message is shown (never the text of an unexpected error) and a pick offers: save anyway, edit the answers (all questions again, prefilled), or cancel.

Every text input except the password is validated, so an invalid value cannot be confirmed.

- **TLS** is a `No`/`Yes` pick. When adding, the first item follows the host (`defaultSsl`: `Yes` for a remote host, `No` for `localhost`, `127.0.0.1`, `::1`), so Enter keeps the safe choice. The test already uses the choice, so a server without TLS is reported before anything is saved.
- **Read-only** is a `No`/`Yes` pick. `Yes` saves `readOnly: true`; `No` saves nothing. A new DuckDB connection starts with `Yes`, because a writable session locks the DuckDB file exclusively and the explorer could not read it.
- **Certificate** (Quack with TLS): trust on first use. `certificateFingerprint` (`src/connections/fingerprint.ts`) connects with Node.js `tls.connect` without checking the certificate, reads its SHA-256 fingerprint and sends nothing. A modal dialog shows the fingerprint and how to compare it on the server (`openssl x509 -noout -fingerprint -sha256 -in <certificate>`); **Trust This Certificate** pins it. Declining, or a certificate that cannot be read (the error is shown), leads to a pick: keep the pinned certificate (when one is pinned) or use the system trust store, for a certificate from a CA. TLS off saves no fingerprint.

### Signing in with Microsoft Entra ID

The sign-in of a PostgreSQL catalog is a pick after the database: **Password** (the default) or **Microsoft Entra ID**, for Azure Database for PostgreSQL. With Entra:

- **Storage account** and **tenant** come next, both optional. The storage account (`azureAccount`, 3 to 24 lowercase letters and digits) is where the data files are (`abfss://` or `az://`); the data engine reads them with the Microsoft account of VS Code instead of a key ([Azure DuckLake](azure-lake.md#reading-and-writing-the-data-files)). The tenant (`azureTenant`, a GUID) picks the directory for both tokens; empty uses the home tenant of the account. Both questions also come with a password, for a host that ends with `.postgres.database.azure.com` or a connection that has a storage account already.
- **User** is prefilled with the sign-in name of the Microsoft account (`upn`, else `preferred_username`, of a token for that tenant). VS Code asks to sign in when there is no session. If that fails, the error is shown and the user types the name: any Entra principal that is a role on the server, also a group or a managed identity.
- **No password** is asked or stored. The test and every connect get a new token (`openWithPassword`); the profile saves `azureAuth: "entra"`.

Edit Connection asks the same. Switching to Entra deletes the stored password; switching back to Password asks for one, with the prompt of a new connection. The prefilled user name is read only when the sign-in changes to Entra, so an edited Entra user is kept.

**Windows sign-in (SSPI, Kerberos) is not possible**, checked with DuckDB 2.0.0:

- The explorer reads the catalog with node-postgres (`pg` 8.23), which knows only the cleartext, MD5 and SCRAM-SHA-256 password methods. A server that asks for GSSAPI or SSPI is answered with `Unknown authenticationOk message type`.
- The `postgres` extension of DuckDB, which the data engine and the SQL editor use, is built without GSSAPI: `gssencmode=require` fails with `gssencmode value "require" invalid when GSSAPI support is not compiled in`. Its Windows build contains the SSPI code of libpq, which was not tried against a server.

Azure Database for PostgreSQL has no Kerberos login anyway; Entra is its passwordless login.

### Edit

The same questions, prefilled. TLS and read-only list the current value first. The password or token is never prefilled: empty keeps the stored one, and the test uses it. If the host, port, database or user was changed, the stored password belongs to the previous server and is not reused: the prompt says so, and an empty field tests without a password. For Quack the certificate is read again: an unchanged one is kept without a question, a changed one is shown with the note that it is not the pinned one. Kind and id never change; `metadataSchema` is carried over, and the sign-in, storage account and tenant are asked again, prefilled. The own name is accepted, another connection's name is not. The wizard does not use the password retry. After saving, Edit Connection refreshes the connection explicitly (a new password does not change the setting), and the setting listener leaves it alone while the flow runs, so it opens once.

### Remove

A confirmation names the connection and says that the catalog is not touched; for PostgreSQL and Quack also that the stored password (the token, for Quack) is deleted too. Only then are the entry and the secret deleted.

## Provisioning with machine settings

An administrator can ship connections without passwords by putting `aantje.connections` into the machine settings ([Installation](installation.md#preconfigure-connections)).

1. The entry is valid without `id` and `port`. Without `ssl` a remote host gets TLS, so write `"ssl": false` for a server without it.
2. No secret exists, so the first connect fails with `AUTH_FAILED` and the user is asked for the password.
3. After the second attempt worked, only the password is stored. The setting is not written and the entry stays as the administrator wrote it.
4. From then on the user is asked again only if the server refuses the password or the connection is pointed at another server.

A provisioned `quack` entry works the same way, with the token as the secret; without `fingerprint` its certificate is checked against the system trust store. A `password` property in an entry is ignored. In code-server passwords are kept in the browser by default ([Security](security.md)), so a provisioned profile leads to one password question per user and browser.

## Testing

`npx vitest run connect` runs the unit tests: parser and validators, the store against in-memory ports (comparing the whole serialised setting, so a password in it or a lost hand-edited entry fails), the wizard with a scripted `WizardUi`, and `openWithPassword` against a fake PostgreSQL server that accepts one password. `connections-fingerprint.test.ts` reads the fingerprint of a local TLS server with a self-signed certificate, and fails with `CONNECTION_FAILED` for a server without TLS, one that does not answer and a closed port. With `AANTJE_POSTGRES=1` (needs Docker) the connect tests also run against the PostgreSQL fixture server with the real driver.

## Known limits

- `metadataSchema` can only be set in the settings. A file catalog (SQLite, DuckDB) has no `azureAccount`, so its data files cannot be read with the Microsoft account.
- Windows sign-in to PostgreSQL is not supported ([above](#signing-in-with-microsoft-entra-id)).
- Updating an entry rewrites it from the profile, so unknown properties of that entry are dropped. VS Code replaces the whole array on write, which can drop comments inside it.
- A stored password can be replaced but not cleared; removing the connection deletes it.
- `AUTH_FAILED` also stands for a user the server does not accept, and a server that requires TLS often answers a connection without it the same way. The user is asked for a password anyway; if the second attempt fails, the server's message is shown. Fix the profile (user, TLS).
- `openWithPassword` does not guard against two simultaneous calls for the same profile; the caller ignores a second connect while one runs.
- The store writes the array without locking. Two wizards saving at the same moment could overwrite each other.
- Provisioned and saved connections must end up in the same effective setting, because VS Code does not merge arrays from different settings files.
