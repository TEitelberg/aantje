# PostgreSQL driver

`src/catalog/drivers/postgres.ts` reads a DuckLake catalog stored in a PostgreSQL database. It implements the `Driver` interface of `src/catalog/drivers/driver.ts` (positional `?` parameters, lower-case column names, numbers for integers, ISO 8601 for timestamps, read-only, failures as `AantjeError`) with `pg` (node-postgres). `pg` is plain JavaScript: esbuild bundles it into `dist/extension.js`, and its optional add-on `pg-native` is never loaded.

## API

```ts
export interface PostgresOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly ssl?: boolean;
  readonly metadataSchema?: string;
  readonly statementTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}
export function openPostgres(options: PostgresOptions): Promise<Driver>;
```

| Option                             | Meaning                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`, `port`, `database`, `user` | The server and the role.                                                                                                                            |
| `password`                         | From the VS Code secret storage. Never taken from `PGPASSWORD` or `~/.pgpass`; without one only a server that asks for none accepts the connection. |
| `ssl`                              | `true` turns TLS on and verifies the certificate. Otherwise the connection is not encrypted, whatever `PGSSLMODE` says.                             |
| `metadataSchema`                   | Schema with the `ducklake_*` tables. Without it the role's default search path applies (normally `public`). An empty string counts as not set.      |
| `statementTimeoutMs`               | Maximum duration of one statement. Without it the driver sets no limit; a limit of the server still applies.                                        |
| `connectTimeoutMs`                 | Wait for the connection including log-in. Default 10000.                                                                                            |

- `query` waits for the queries before it, runs the statement and returns plain objects with lower-cased column names ([Values](#values)).
- `close` ends the connection and may be called more than once. A running statement is cut off and its call ends with `CONNECTION_FAILED`; the server may finish it on its own.
- A `signal` in the options of `query` cancels the statement on the server ([Time limits and cancelling](#time-limits-and-cancelling)).

The driver does not check that the database is a DuckLake catalog; `CatalogReader.info()` reports `NOT_A_DUCKLAKE` or `UNSUPPORTED_VERSION`.

## How it works

`openPostgres`:

1. Checks `metadataSchema` and refuses an invalid name before connecting.
2. Creates the `pg` client. Settings travel as start-up parameters, so they hold before the first statement: `default_transaction_read_only=on`, `search_path` (with a metadata schema), `statement_timeout` (with a limit) and `application_name=aantje`. TCP keep-alive is on.
3. Connects. A failure becomes `AUTH_FAILED` or `CONNECTION_FAILED`, and the half-open connection is closed.
4. Reads the session's process id (`SELECT pg_backend_pid()`), which cancelling needs.

Every `query` goes through one queue, replaces each `?` by `$1`, `$2`, ... (values travel separately from the SQL text, so a value can never become SQL), reads rows as arrays and builds objects with lower-cased column names, also for quoted aliases.

## Values

The driver installs type parsers on its own client. The global registry of `pg` stays untouched.

| PostgreSQL type                                   | Result                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bigint`                                          | `number`; a value beyond +/-9007199254740991 stays an exact string.                                             |
| `numeric`                                         | `number` for a whole number, otherwise an exact string such as `'1.50'`. `SUM` over a `bigint` is a `numeric`.  |
| `integer`, `smallint`, `real`, `double precision` | `number`.                                                                                                       |
| `boolean`                                         | `boolean`.                                                                                                      |
| `timestamptz`                                     | ISO 8601 in UTC with milliseconds (`2026-10-29T21:42:02.338Z`), whatever the session time zone.                 |
| `timestamp` (without zone)                        | The same format. DuckLake writes such a value as UTC, so it is read as UTC whatever the machine's time zone is. |
| `infinity`, `-infinity`                           | As the server writes them.                                                                                      |
| `NULL`                                            | `null`.                                                                                                         |
| `text`, `varchar`, `uuid`, ...                    | `string`.                                                                                                       |

The `ducklake_*` tables use only `bigint`, `varchar`, `boolean`, `uuid` and `timestamptz`. Other types come back as `pg` parses them and are not part of the contract.

## Read-only guarantee

`default_transaction_read_only=on` is a start-up parameter, so every transaction starts read-only. `INSERT`, `UPDATE`, `DELETE` and DDL fail with SQLSTATE `25006` and the driver reports `QUERY_FAILED`. This is the second layer; the reader issues fixed `SELECT` text only.

The setting guards against mistakes, not against a session that runs `SET default_transaction_read_only = off`. Give the connection a role with `SELECT` on the metadata tables and nothing else, and the server enforces the guarantee. The `CREATE ROLE` and `GRANT` recipe is in [Security](security.md).

## Metadata schema

DuckLake creates its tables in the schema named by its `METADATA_SCHEMA` option (`public` by default). The reader writes unqualified names, so the driver sets the session `search_path` to that schema. A schema that does not exist, or lacks the table, makes the statement fail with `QUERY_FAILED`; there is no fall back to `public`, which could silently show another catalog.

The name is user input and becomes part of the `options` start-up parameter, where a space starts the next setting (`public -c default_transaction_read_only=off` must not switch the guard off). It must therefore be a plain identifier: letters (also beyond ASCII), digits, `_` and `$`, not starting with a digit; anything else is rejected with `INVALID_PROFILE`. It is then quoted with `escapeIdentifier` of `pg`, which keeps the case: `Lake` and `lake` are different schemas.

## Time limits and cancelling

`statementTimeoutMs` becomes the session's `statement_timeout`. The server stops a long statement with `57014`, the driver reports `TIMEOUT`, and the connection stays usable. SQLSTATE is the only reliable sign, because server message text is translated.

A `signal` that aborts while a statement runs cancels it:

1. The driver opens a second short connection with the same settings and calls `pg_cancel_backend` for the session.
2. The server answers the running statement with `57014`; because the signal is aborted, the driver reports `ABORTED`, not `TIMEOUT`.
3. The next statement starts only after the cancel request has been handled, so a late cancel never hits the next query ("abort the old load, start a new one").

If the cancel request cannot be delivered (no free connection slot for the role, network gone), the driver closes the connection. The aborted call still ends with `ABORTED`, and every later call ends with `CONNECTION_FAILED` until the caller opens a new driver.

Queries run one at a time. A queued query that is aborted does nothing to the running one and ends with `ABORTED` when its turn comes. An already aborted signal ends with `ABORTED` without touching the server.

## TLS

`ssl: true` encrypts the connection and verifies the certificate chain and host name against the Node.js trust store. The driver passes `rejectUnauthorized: true` explicitly, so neither `NODE_TLS_REJECT_UNAUTHORIZED=0` nor `PGSSLMODE` can weaken it. There is no option to skip verification, and the driver never falls back to plain text when the server has no TLS. The cancel connection uses the same settings.

A certificate of a private authority is refused with `CONNECTION_FAILED` and Node's message (for example `self-signed certificate`). Make Node trust the authority, for example with `NODE_EXTRA_CA_CERTS` (set before VS Code starts) or by installing it in the system store and starting Node with `--use-system-ca`.

## Errors

The user message never contains the password, and neither does the original `pg` error kept in `cause`.

| Situation                                                        | Code                | Message                                                                                                    |
| ---------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------- |
| The schema name is not a plain identifier                        | `INVALID_PROFILE`   | `The metadata schema must be a plain identifier: letters, digits, "_" and "$", not starting with a digit.` |
| The server asks for a password and none is stored                | `AUTH_FAILED`       | `db:5432 asks for a password, but none is stored for user "reader".`                                       |
| Wrong password or user (28P01), or no `pg_hba.conf` rule (28000) | `AUTH_FAILED`       | `Authentication failed on db:5432: password authentication failed for user "reader".`                      |
| Connection refused                                               | `CONNECTION_FAILED` | `Cannot connect to db:5432: connection refused (is the server running on this port?).`                     |
| Unknown host                                                     | `CONNECTION_FAILED` | `Cannot connect to db:5432: the host name could not be resolved.`                                          |
| No answer in time                                                | `CONNECTION_FAILED` | `Cannot connect to db:5432: no response within 10 s.`                                                      |
| Database does not exist                                          | `CONNECTION_FAILED` | `Cannot connect to db:5432: database "lake" does not exist.`                                               |
| `ssl` on, server without TLS                                     | `CONNECTION_FAILED` | `Cannot connect to db:5432: The server does not support SSL connections.`                                  |
| `ssl` on, certificate not trusted                                | `CONNECTION_FAILED` | `Cannot connect to db:5432: self-signed certificate; ...`                                                  |
| Any other refusal while connecting                               | `CONNECTION_FAILED` | `Cannot connect to db:5432: <message of the server>.`                                                      |
| A statement fails, including any write                           | `QUERY_FAILED`      | `The catalog query failed: cannot execute INSERT in a read-only transaction`                               |
| A statement runs longer than `statementTimeoutMs`                | `TIMEOUT`           | `The catalog query exceeded the time limit of 30 s and was cancelled.`                                     |
| The call's `AbortSignal` aborts                                  | `ABORTED`           | `The query was cancelled.`                                                                                 |
| The server ends the session or the network breaks                | `CONNECTION_FAILED` | `The connection to db:5432 was lost.`                                                                      |
| A call after `close`, or after a failed cancel request           | `CONNECTION_FAILED` | `The catalog connection is closed.`                                                                        |

A server that requires TLS (Azure Database for PostgreSQL, for example) typically answers a connection without `ssl` with SQLSTATE 28000, so the user sees `AUTH_FAILED` with the server's text about missing encryption. Switch `ssl` on.

## Design decisions

- **`pg` instead of a native module:** one code base for every platform and code-server. DuckDB is the only native dependency.
- **Start-up parameters instead of `SET` statements.** Read-only guard, search path and timeout hold before the first statement and cannot be skipped by a code path.
- **One connection, one statement at a time.** Catalog queries are small, and the queue makes cancelling exact: the driver knows which statement runs and never cancels one of another caller.
- **Cancelling through a second connection.** `pg_cancel_backend` is plain SQL over settings that already work, including TLS and the password. The wire-protocol cancel message would need `pg` internals and its own TLS negotiation.
- **The password is handed over as a function** that raises `AUTH_FAILED` itself, because `pg` otherwise reads `PGPASSWORD` and `~/.pgpass`. For the same reason `ssl` is always set explicitly.
- **SQLSTATE instead of message text** to classify failures.
- **No automatic reconnect.** A lost connection is a state the user should see; the next connect or refresh opens a new driver.

## Testing

The suite needs Docker and runs only with `AANTJE_POSTGRES=1`; without it, it is reported as skipped and no container starts.

```powershell
$env:AANTJE_POSTGRES = '1'; npx vitest run test/unit/postgres-driver.test.ts
npm run test:full
```

The global setup starts a throw-away `postgres:17-alpine` container with the fixture catalog ([Test fixtures](test-fixtures.md)). The tests cover value conversion, parameters, read-only behaviour, timeout and abort (checked on the server), connection and authentication errors, TLS (a self-signed certificate is refused), the metadata schema including hostile names, and the connection lifecycle. The reader contract suite runs against this driver as the `postgres` source of `catalogSources`. The successful TLS path has no automated test, because it needs a trusted certificate; it was checked by hand. In code-server, the specs `postgres-secrets` and `files-errors` run the driver against a real server ([End-to-end tests](e2e-tests.md)).

## Limits

- **One connection per driver.** There is no pool; queries run one after the other.
- **Poolers.** A pooler such as PgBouncer can refuse the start-up parameters (`options`, `statement_timeout`), and one in transaction mode breaks cancelling. Connect to the server directly, or through a pooler in session mode that accepts the parameters.
- **Cancelling needs a second connection.** Without a free slot for the role, the driver closes the connection instead.
- **Other types are not normalised.**
- **The placeholder is `?`.** A literal question mark (the `jsonb` operator `?`) is not supported. The catalog queries contain none.
- **The result is read completely** before it is returned.
- **TLS uses the Node.js trust store.** No CA-file option in the profile and none to skip verification.
- **No reconnect.** After a lost connection every call fails with `CONNECTION_FAILED`.
- **Timestamps keep milliseconds**, the precision of a JavaScript `Date`; `pg` delivers microseconds.
