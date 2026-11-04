# Logging

aantje writes its diagnostics to one output channel. Every line first passes a secret filter, and errors are written in one fixed format. The logic is in `src/log.ts` (no `vscode` import); `src/log.vscode.ts` is the thin adapter. Masking itself is in `src/secrets.ts`.

## Where the log goes

The channel is called **aantje**: open the Output panel and pick it in the drop-down list. It is a VS Code log channel (`createOutputChannel('aantje', { log: true })`), so every line has a timestamp and a level and VS Code does the filtering. aantje has no log level setting of its own.

- A new channel starts at the editor's log level, normally Info. aantje writes `info`, `warn` and `error` lines only. Change the level with _Developer: Set Log Level..._ (pick _aantje_).
- `info` marks milestones such as "connected", `warn` a problem aantje recovered from, `error` a failure.
- The channel is also a file, `aantje.log`, in a folder `teitelberg.aantje` below the `logs` directory of the user data directory. In code-server that is `~/.local/share/code-server/logs/` by default, with a timestamped subfolder per server start. Find it with `find <user-data-dir>/logs -path '*/teitelberg.aantje/aantje.log'`.

The channel works the same in desktop VS Code and in code-server.

## What is logged

aantje logs what an operator needs to find out why a connection or command failed, and nothing about catalog content. The main lines:

| Level   | Line                                                                | When                                         |
| ------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `info`  | `Connected to "<name>" (DuckLake <version>, latest snapshot <id>).` | A catalog was opened.                        |
| `info`  | `Disconnected from "<name>".`                                       | A connection was closed on purpose.          |
| `info`  | `The command <id> was stopped: <message>`                           | The user cancelled a command.                |
| `error` | `Cannot connect to "<name>".` and the error with its causes         | A catalog could not be opened.               |
| `error` | `Cannot read the children of "<node>" in "<name>".` and the error   | A level of the tree could not be read.       |
| `error` | `The command <id> failed.` and the error                            | A command threw.                             |
| `warn`  | `Ignored an entry of "aantje.connections": <reason>`                | An invalid entry of the setting was skipped. |

Other `warn` and `error` lines report failures of reports, the SQL session or shutdown. What appears in the log: connection names, hosts, ports, database names, user names, file paths, error texts of the database server and snapshot ids. Read a log before you attach it to a bug report.

## What is redacted

`createLogger` passes every message and every error text through `SecretRegistry.redact` on all levels, including the `error` argument. A secret is replaced by `***`.

- **Registered secrets** are masked in each form they take in text: raw, URL-encoded, JSON-escaped and with doubled single quotes (`secretForms`). All forms are replaced in one pass, longest first, so a secret that prefixes another (`s3cret`, `s3cret-prod`) leaves no remainder and a mask is never rescanned.
- **Passwords in connection strings, even when unregistered:** `scheme://user:password@host` (the password ends at the last `@` of the authority) and the libpq form `password=secret` or `password='quoted \' value'`, case-insensitive.

Registered secrets are replaced first, so a registered password with `@`, `/`, `:` or spaces is masked completely before the connection-string patterns look at the text.

```text
Login failed for p@ss:w/rd#1 %                          ->  Login failed for ***
postgres://app:p%40ss%3Aw%2Frd%231%20%25@db:5432/lake   ->  postgres://app:***@db:5432/lake
host=db user=app password=hunter2 dbname=lake           ->  host=db user=app password=*** dbname=lake
```

The first two lines assume that `p@ss:w/rd#1 %` is registered; the third needs no registration.

## How secrets get registered

One `SecretRegistry` is created at activation and shared by the logger and everything that handles passwords. The connection store calls `registerSecret` (which calls `secrets.add`) with every password it reads from or writes to the secret storage, before the password is used for anything that can fail and be logged. `S3CredentialStore` does the same for the S3 keys. Values shorter than three characters are ignored, because they would turn the log into noise. A registered secret stays registered until the extension host restarts.

## What is never logged

- Passwords, and connection strings that contain one. Code must not pass them to a `Logger` method or put them into an error message. Redaction is the safety net for text from outside (driver and server messages), not a licence.
- `AantjeError.userMessage` reaches notifications and the tree without passing the registry, so it must be free of secrets by construction (`src/errors.ts`). The original error stays in `cause` and reaches the log only through `formatError`, and therefore through redaction.
- Catalog data. The explorer reads metadata only; rows never reach the logger.

## Error formatting

`formatError(error)` produces the text that `Logger.error(message, error)` appends after a line break.

- An `AantjeError` is an expected failure with a message for people: `CODE: userMessage`, without a stack.
- Any other `Error` is a bug or an untranslated library failure and keeps its stack.
- Every cause follows on its own `Caused by:` line, depth first. The members of an `AggregateError` count as causes (Node reports a refused `localhost` that way, one member per address). A chain that leads back to a printed error ends there.
- A thrown string is printed as is. Anything else goes through `util.inspect` on one line, never `[object Object]`, and a circular object does not throw.

```text
Connecting to "prod" failed
CONNECTION_FAILED: Cannot connect to localhost:5432.
Caused by: AggregateError
Caused by: Error: connect ECONNREFUSED ::1:5432
Caused by: Error: connect ECONNREFUSED 127.0.0.1:5432
```

The notification a user sees comes from `userMessageOf(error)`: the `userMessage` of an `AantjeError`, otherwise one generic text that points to this channel. The text of an unknown error is never shown, because it could contain a secret.

## API

```ts
interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}
const silentLogger: Logger; // discards everything, the default in tests
type LogSink = (level: 'info' | 'warn' | 'error', message: string) => void;
class SecretRegistry {
  add(value: string): void;
  redact(text: string): string;
}
function createLogger(sink: LogSink, secrets: SecretRegistry): Logger;
function formatError(error: unknown): string;
// src/log.vscode.ts, the only file that imports "vscode"
function createOutputChannelLogger(secrets: SecretRegistry): Logger & { dispose(): void };
```

Logic receives a `Logger` as a parameter and never imports the adapter. The sink receives text that is already redacted.

## Key decisions

- **Redaction happens in the logger, once.** Callers just log. The message and the formatted error are joined first and redacted together, so a secret cannot slip through at the seam.
- **Registered values first, patterns second.** The registry knows the real password and masks it however it is spelled. The patterns only catch common connection-string shapes of passwords nobody registered.
- **The editor owns the log level**, so no aantje setting can disagree with it.
- **A stack only for unexpected errors.** An `AantjeError` already says what went wrong; another error is a bug and the stack is what the fix needs.

## Testing

```powershell
npx vitest run test/unit/log.test.ts test/unit/errors.test.ts
```

Unit tests run the real registry, logger and `formatError` with a realistic secret (a password with `@`, `:`, `/`, `#`, `%` and a space) in a message, a URL, a libpq string and a cause chain, and test the adapter against a stand-in for `vscode`. An extension-host test reads the log file of the real channel and checks that a typed password is masked ([Extension-host tests](integration-tests.md)); the end-to-end spec `postgres-secrets` checks it in code-server ([End-to-end tests](e2e-tests.md)).

## Known limits

- Redaction is text based. A secret in another encoding (Base64, or the escaped form `util.inspect` prints inside a thrown object) is not recognised, nor is one split over several messages.
- Secrets shorter than three characters are ignored. A password that is an ordinary word, such as `postgres`, is masked wherever the word appears. The log gets harder to read, never less safe.
- A password that was never registered is masked only inside the two connection-string shapes, not in free text. Every code path that receives a password must register it.
- Text that does not go through the logger (notifications, tooltips, `userMessage`) is not redacted.
- An unquoted `password=` value runs to the next whitespace. In a URL query string, parameters after it are masked too (`...&password=s3cret&ssl=true` loses `ssl=true`), because the same text can be a libpq string whose password contains `&`. An unterminated quote masks only up to the next space.
