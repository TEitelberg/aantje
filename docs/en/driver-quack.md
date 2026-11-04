# Quack driver

`src/catalog/drivers/quack.ts` reads a DuckLake catalog that a DuckDB server serves over Quack, the client-server protocol of DuckDB (experimental in DuckDB 2.0.0). The server keeps the `ducklake_*` tables in a DuckDB database and runs `quack_serve`. The driver attaches that database with the `quack` extension in a private in-memory DuckDB and queries the tables directly, as the [DuckDB driver](driver-duckdb.md) does with a file. It implements the `Driver` interface of `src/catalog/drivers/driver.ts` (positional `?` parameters, lower-case column names, failures as `AantjeError`) with `@duckdb/node-api` and shares the row conversion (`toRow`) of the DuckDB driver. Unlike the other drivers it cannot make the database read-only ([Read-only access and the lock](#read-only-access-and-the-lock)).

## API

```ts
export interface QuackOptions {
  readonly host: string;
  readonly port: number;
  readonly token?: string; // from the secret storage; only in CREATE SECRET
  readonly ssl: boolean;
  readonly fingerprint?: string; // SHA-256 of the server certificate, AB:CD:...
  readonly statementTimeoutMs?: number; // per query, and for the attach
  readonly extensionDirectory?: string; // aantje.duckdb.extensionDirectory
}
export function openQuack(options: QuackOptions): Promise<Driver>;
```

| Option               | Meaning                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`       | The Quack server. The profile refuses the host name `quack` ([Limits](#limits)).                                                                                                                         |
| `token`              | From the VS Code secret storage. It appears only in `CREATE SECRET` and is masked in every message. Without one the quack client refuses before it sends anything, and the driver reports `AUTH_FAILED`. |
| `ssl`                | `true`: TLS, the certificate is checked against the system trust store or against `fingerprint`. `false`: plain HTTP.                                                                                    |
| `fingerprint`        | Pins the server certificate: only this one is accepted, for this attach. Needs `ssl`.                                                                                                                    |
| `statementTimeoutMs` | Limits one query, and the attach. Installing the extension has its own limit of 5 minutes.                                                                                                               |
| `extensionDirectory` | DuckDB `extension_directory`; `openCatalog` passes `aantje.duckdb.extensionDirectory`. Without it DuckDB downloads `quack` on first use.                                                                 |

- `query` writes the parameters into the SQL as literals ([Parameters](#parameters)), runs the statement on a connection of its own and returns plain objects with lower-cased column names, converted as in the [DuckDB driver](driver-duckdb.md#type-conversion). The `signal` of the call gives the query up (`ABORTED`).
- `close` gives up running queries (`ABORTED`), waits up to 3 s for them and closes the instance. A query that a hung server holds is left behind; the instance closes when it ends. `close` may be called more than once; a `query` afterwards rejects with `CONNECTION_FAILED`.

The driver does not check that the served database is a DuckLake catalog; `CatalogReader.info()` reports `NOT_A_DUCKLAKE` or `UNSUPPORTED_VERSION`.

## How it works

`openQuack` loads the engine (`loadEngine` in `src/data/open-lake.ts`) and attaches. `quackSetup` returns the statements:

1. Create an in-memory DuckDB with `allow_persistent_secrets=false` and the extension directory.
2. `INSTALL` and `LOAD` of `quack` and `httpfs` (Quack sends its requests through httpfs), within the 5-minute limit of the extension download.
3. `CREATE OR REPLACE TEMPORARY SECRET aantje_quack (TYPE quack, TOKEN '...', SCOPE 'quack:<host>:<port>')`. The scope keeps the token away from any other server.
4. `ATTACH 'quack:<host>:<port>' AS metadata (DISABLE_SSL <true|false>[, SSL_FINGERPRINT '<fingerprint>'])`, within `statementTimeoutMs`. No `READ_ONLY` ([Read-only access and the lock](#read-only-access-and-the-lock)); the fingerprint only with TLS on.
5. Lock the instance: `SET allowed_paths = ['<http|https>://<host>:<port>/quack']`, `SET enable_external_access = false`, `autoinstall_known_extensions` and `autoload_known_extensions` off, and last `SET lock_configuration = true`.

Queries take turns. Each opens its own connection on the instance, runs `USE metadata` and the statement, reads all rows and closes the connection, also on failure. The time limit of a query counts from its turn, not from the call.

### Parameters

The quack extension of DuckDB 2.0.0 loses the bound parameters of a statement that reads its tables (`Values were not provided for the following parameters`). `inlineParameters` therefore replaces every `?` by its value as a SQL literal: a number as it is, a negative number in parentheses (so that a minus in front of the placeholder cannot form the comment `--`), a string quoted by `quoteLiteral` (`'` doubled), `NULL`, `TRUE` and `FALSE`. A placeholder count that does not match the values, and a number that SQL cannot write (`NaN`, `Infinity`), fail with `QUERY_FAILED` before anything is sent. This relies on the rule of the reader that a `?` stands only where a value goes, never inside a literal or a comment ([Portable SQL](catalog-reader.md#portable-sql)).

### Time limits, restarts and reconnects

- A query races its time limit and its signal. When one fires, the driver interrupts the connection and gives the query up at once (`TIMEOUT` or `ABORTED`), because an interrupt does not reach a server that hangs; the engine call ends on its own later, and the next query takes its turn.
- After a server restart every request on the old attach fails with `Invalid connection id`, and while the server is down with `Could not connect to server`. The driver then retires that instance, and the next query attaches again on a fresh one. A query that met a restart runs once more right away, because the server is back.
- Other clients may write while the explorer is attached; their new snapshots are visible to the next query without a new attach. Conflicting schema changes of two writers end in the transaction conflict of DuckLake.

## Errors

The table of the messages of the quack extension is `quackProblem` in `src/data/errors.ts`; the data engine and the SQL editor use it too. While attaching, a token problem becomes `AUTH_FAILED` `Authentication failed on <host>:<port>: <reason>.` and anything else `CONNECTION_FAILED` `Cannot connect to <host>:<port>: <reason>.`. During a query the code of the table applies, with the message `The catalog query on <host>:<port> failed: <reason>.`.

| Engine message                                                                    | Code                | Reason                                                                                                                                                                                     |
| --------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Authentication failed`                                                           | `AUTH_FAILED`       | the server refused the token                                                                                                                                                               |
| `Could not find a Quack authentication token`                                     | `AUTH_FAILED`       | no token is stored for this connection, and the server needs one                                                                                                                           |
| `Authorization failed`, `Authorization callback failed: <text>`                   | `QUERY_FAILED`      | the server refused the request: its authorization function does not allow it for this token                                                                                                |
| `Could not connect to server`                                                     | `CONNECTION_FAILED` | the server does not answer (it is not running, or a firewall blocks the port)                                                                                                              |
| `Could not resolve hostname`                                                      | `CONNECTION_FAILED` | the host name could not be resolved                                                                                                                                                        |
| `does not match the pinned ssl_fingerprint`                                       | `CONNECTION_FAILED` | the server certificate does not match the pinned fingerprint. If the server has a new certificate, Edit Connection reads and shows it; otherwise something in between presents another one |
| `SSL peer certificate`, `Problem with the SSL CA cert`, `Invalid SSL fingerprint` | `CONNECTION_FAILED` | the server certificate is not trusted: pin its fingerprint with Edit Connection, or give the server a certificate from a CA that this machine trusts                                       |
| `Unsupported protocol`                                                            | `CONNECTION_FAILED` | the server expects TLS: turn on TLS for this connection                                                                                                                                    |
| `SSL connect error` (TLS on, the server speaks plain HTTP)                        | `CONNECTION_FAILED` | the TLS handshake failed: the server may not use TLS on this port (turn off TLS for this connection), or the port is wrong                                                                 |
| `Invalid connection id`                                                           | `CONNECTION_FAILED` | the server was restarted after the connection was made; connect again                                                                                                                      |

| Situation                                             | Code                | Message                                                                                                                |
| ----------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `quack` or `httpfs` cannot be installed or loaded     | `CONNECTION_FAILED` | `The DuckDB extensions quack and httpfs, which read a Quack server, could not be installed or loaded (<message>). ...` |
| Installing the extensions takes longer than 5 minutes | `TIMEOUT`           | `Installing the DuckDB extensions quack and httpfs exceeded the time limit of 300 s and was cancelled. ...`            |
| The attach takes longer than `statementTimeoutMs`     | `TIMEOUT`           | `Connecting to <host>:<port> exceeded the time limit of <n> s and was cancelled.`                                      |
| The native engine cannot be loaded                    | `CONNECTION_FAILED` | `The native DuckDB engine could not be loaded on this platform (<platform>-<arch>). ...`                               |
| Any other failing statement                           | `QUERY_FAILED`      | `The catalog query failed: <DuckDB message>`                                                                           |
| Placeholders and values do not match                  | `QUERY_FAILED`      | `The catalog query has <n> placeholders for <m> values.`                                                               |
| `statementTimeoutMs` has passed                       | `TIMEOUT`           | `The catalog query exceeded the time limit of <n> s and was cancelled.`                                                |
| The call's `AbortSignal` fired, or `close` ran        | `ABORTED`           | `The query was cancelled.`                                                                                             |
| `query` after `close`                                 | `CONNECTION_FAILED` | `The catalog connection is closed.`                                                                                    |

Messages name the server as `host:port` and never contain the token. Every engine message is cut to its first line and passed through `maskSecrets` with the token, the `cause` too, because a parser error in `CREATE SECRET` repeats the statement with the token.

## Read-only access and the lock

- **No `READ_ONLY`.** DuckDB 2.0.0 accepts `READ_ONLY` on a Quack attach but lets `INSERT`, `UPDATE`, `DELETE`, `CREATE` and `DROP` through to the server, and newer quack builds refuse the option (`READ_ONLY is not currently supported for Quack databases`). The driver therefore attaches without it. On the client only the reader holds: it sends fixed `SELECT` text.
- **The server decides.** Only the server can refuse a write. A token that the server's `quack_authorization_function` allows only to read makes the whole connection read-only, the SQL editor and notebooks included. aantje cannot see what a token may do ([Security](security.md#quack)).
- **The instance reaches one server.** Because the attach does not guard, the instance is locked: `allowed_paths` names only the `/quack` endpoint of the server, `enable_external_access=false` blocks every other file and URL, no extension installs or loads on its own any more, and `lock_configuration` keeps a later statement from changing this. Whatever runs on the instance reaches that server and nothing else.
- **No persistent secrets.** The token exists only in the memory of the instance.
- **No file lock.** A Quack server has no lock like a DuckDB file, so the explorer stays connected while other clients and SQL editor sessions write.

## TLS and certificate pinning

- **`ssl`** is the property of PostgreSQL profiles, with the same default: TLS for every host but `localhost`, `127.0.0.1` and `::1`. It becomes `DISABLE_SSL` on the attach, so TLS can be switched on and off for any host.
- **Without a fingerprint** the certificate is checked against the system trust store.
- **With a fingerprint** `SSL_FINGERPRINT` accepts only that certificate. It is sent only with TLS on: quack refuses a pin together with `DISABLE_SSL true`, so a profile with TLS off and a leftover fingerprint still connects. The Add Connection wizard reads it from the server and pins it after you confirmed it ([Connections](connections.md#add)).
- **No `ca_cert_file`.** `SET GLOBAL ca_cert_file` would make DuckDB trust a self-signed certificate, but it replaces the trust store of `httpfs` for every HTTPS request of the engine, and public HTTPS endpoints then fail. A pin applies to the one attach.

## Design decisions

- **The served database, not a DuckLake attach.** As for a DuckDB file, the explorer reads the `ducklake_*` tables directly. It attaches `quack:`, not `ducklake:quack:`, so it needs neither the DuckLake extension nor the data path.
- **`ssl` instead of a new `tls` property.** It has the same meaning and the same default rule (`defaultSsl`) as for PostgreSQL, so the profile has one TLS property and the wizard one TLS question.
- **Literals instead of bound parameters**, because of the bug above. One function writes the values, and the placeholder count is checked.
- **Queries take turns.** The quack client runs the statements of all connections of one attach on one connection to the server, and a statement that starts while another runs there supersedes it (`INTERRUPT Error: superseded by a new query`, then `cannot start a transaction within a transaction`; the contract suites found it). The reader starts queries in parallel, so the driver lines them up, like the PostgreSQL driver. Each still gets a connection of its own, so an interrupt hits only its own query.
- **Give up instead of waiting.** An interrupt does not reach a server that hangs; racing the limit releases the caller on time, and the instance closes later.
- **Attach again after a restart.** A Quack connection does not survive a restart of the server; without a new attach the tree would fail until Refresh. The PostgreSQL driver, in contrast, does not reconnect.
- **A pin instead of a CA file**, for the reason above.
- **No read-only switch.** aantje's read-only session exists to avoid the lock of a DuckDB file and is no write protection; a Quack server has no such lock, and Quack cannot be attached `READ_ONLY` ([SQL editor](sql-editor.md#quack-catalogs)).

## Testing

`quack-driver.test.ts` checks the setup statements (the token only in the scoped secret, the lock last), that the engine reads the inlined literals back as the same values, and the errors of a server that cannot be reached, with no server running. `quack-lifecycle.test.ts` plays a server on a stand-in for the engine (`engine` of the options, a test seam): a query that meets a restarted server attaches again and runs once more, the queries take turns, and `close` returns after its grace while a query hangs. With `npm run test:full` the contract suites run the driver against the fixture catalogs served by Docker containers (`aantje-test-quack-*`, [Test fixtures](test-fixtures.md#running-the-quack-tests)), and `data-quack.test.ts` previews a table, writes through a SQL session while an explorer driver stays attached, and pins the certificate of a TLS server.

## Limits

- **Experimental.** DuckDB marks Quack as experimental in 2.0.0. The driver works around the bind-parameter bug; a newer DuckDB may change the messages that the error table matches.
- **No `READ_ONLY` on the client:** DuckDB 2.0.0 does not enforce it for Quack and newer quack builds refuse it ([above](#read-only-access-and-the-lock)).
- **The host name `quack`** cannot be used: the client parses `quack:quack:<port>` wrongly. The profile refuses it; use the IP address or another DNS name.
- **`set_option` is not undone by `ROLLBACK`** on a served catalog. This concerns SQL you run in the editor.
- **No connection survives a server restart.** The explorer attaches again; an open SQL editor session has to be closed ([SQL session](sql-session.md#errors)).
- **A port where nothing listens** takes about 13 s on Windows to fail with `Could not connect to server`.
- **One query at a time** per connection ([Design decisions](#design-decisions)); a report waits for the queries before it.
- **An abandoned query** still holds a thread of Node's pool ([DuckDB driver](driver-duckdb.md#limits)) until the engine call ends.
- **Not tested:** IPv6 addresses, arm64 and macOS, the Electron runtime of desktop VS Code (the tests run in Node.js), a certificate from a public CA, data files on S3 or Azure behind a Quack catalog, long idle times, and roles per token.
