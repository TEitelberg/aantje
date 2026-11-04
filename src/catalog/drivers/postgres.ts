import { Client, DatabaseError, TypeOverrides, escapeIdentifier, types as pgTypes } from 'pg';
import type { ClientConfig } from 'pg';
import { AantjeError, isErrnoException, messageOf, networkReason } from '../../errors';
import type { Driver, QueryOptions, Row, Value } from './driver';
import { catalogClosed, queryCancelled, queryTimedOut } from './limits';

export interface PostgresOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password?: string;
  readonly ssl?: boolean;
  /** Schema of the `ducklake_*` tables; default: the connection's default schema. */
  readonly metadataSchema?: string;
  /** Maximum duration of one query in milliseconds. */
  readonly statementTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
// Unquoted PostgreSQL identifiers (plus upper case, which quoting preserves).
const PLAIN_IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

// Whole numbers become `number` unless that loses digits; other NUMERIC values stay exact strings.
function integral(value: string): number | string {
  const number = Number(value);
  return /^-?\d+(\.0+)?$/.test(value) && Number.isSafeInteger(number) ? number : value;
}

// `infinity` and other non-dates stay as the server wrote them.
function isoUtc(value: string, zone = ''): string {
  const date = new Date(value + zone);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

// Per client: the global `pg` registry must stay untouched for the rest of the process.
const typeParsers = new TypeOverrides();
typeParsers.setTypeParser(pgTypes.builtins.INT8, integral);
typeParsers.setTypeParser(pgTypes.builtins.NUMERIC, integral);
typeParsers.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, (value) => isoUtc(value));
// DuckLake writes timestamps without a zone as UTC.
typeParsers.setTypeParser(pgTypes.builtins.TIMESTAMP, (value) => isoUtc(value, 'Z'));

/**
 * Opens one read-only connection (`default_transaction_read_only`); queries run serially, an abort cancels
 * server-side.
 */
export async function openPostgres(options: PostgresOptions): Promise<Driver> {
  const config = clientConfig(options);
  const client = new Client(config);
  // A connection that breaks while idle emits 'error'; without a listener that ends the process.
  client.on('error', () => undefined);

  let backendPid: number | undefined;
  try {
    await client.connect();
    backendPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  } catch (cause) {
    client.end().catch(() => undefined);
    throw connectError(cause, options);
  }

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= client.end());

  // Cancels from a second connection; the first is busy running the statement.
  async function cancelStatement(): Promise<void> {
    const canceller = new Client(config);
    canceller.on('error', () => undefined);
    try {
      await canceller.connect();
      const { rows } = await canceller.query<{ cancelled: boolean | null }>({
        text: 'SELECT pg_cancel_backend($1) AS cancelled',
        values: [backendPid],
      });
      if (rows[0]?.cancelled !== true) {
        throw new Error('The server did not accept the cancel request.');
      }
    } finally {
      canceller.end().catch(() => undefined);
    }
  }

  async function execute(sql: string, params: readonly Value[], signal?: AbortSignal): Promise<Row[]> {
    if (closing) {
      throw catalogClosed();
    }
    if (signal?.aborted) {
      throw queryCancelled();
    }
    // If the cancel fails the statement keeps running, so the connection is closed.
    const cancellations: Promise<void>[] = [];
    const onAbort = (): void => {
      cancellations.push(cancelStatement().catch(close));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let index = 0;
      const result = await client.query<Value[]>({
        text: sql.replace(/\?/g, () => `$${++index}`),
        values: [...params],
        rowMode: 'array',
      });
      const names = result.fields.map((field) => field.name.toLowerCase());
      return result.rows.map((values) =>
        Object.fromEntries(names.map((name, column) => [name, values[column] ?? null])),
      );
    } catch (cause) {
      throw queryError(cause, options, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // The next statement must wait until the server has handled the cancel.
      await Promise.all(cancellations);
    }
  }

  let queue: Promise<unknown> = Promise.resolve();
  return {
    query(sql: string, params: readonly Value[] = [], queryOptions?: QueryOptions): Promise<Row[]> {
      const result = queue.then(() => execute(sql, params, queryOptions?.signal));
      queue = result.catch(() => undefined);
      return result;
    },
    close,
  };
}

function endpoint({ host, port }: PostgresOptions): string {
  return `${host}:${port}`;
}

function clientConfig(options: PostgresOptions): ClientConfig {
  const startup = ['-c default_transaction_read_only=on'];
  if (options.metadataSchema) {
    if (!PLAIN_IDENTIFIER.test(options.metadataSchema)) {
      throw new AantjeError(
        'INVALID_PROFILE',
        'The metadata schema must be a plain identifier: letters, digits, "_" and "$", not starting with a digit.',
      );
    }
    startup.push(`-c search_path=${escapeIdentifier(options.metadataSchema)}`);
  }
  return {
    host: options.host,
    port: options.port,
    database: options.database,
    user: options.user,
    // A function stops `pg` from falling back to PGPASSWORD and ~/.pgpass: the password comes from the profile only.
    password: () => {
      if (!options.password) {
        throw new AantjeError(
          'AUTH_FAILED',
          `${endpoint(options)} asks for a password, but none is stored for user "${options.user}".`,
        );
      }
      return options.password;
    },
    // Explicit, so PGSSLMODE and NODE_TLS_REJECT_UNAUTHORIZED cannot weaken it.
    ssl: options.ssl ? { rejectUnauthorized: true } : false,
    application_name: 'aantje',
    options: startup.join(' '),
    statement_timeout: options.statementTimeoutMs,
    connectionTimeoutMillis: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    // Firewalls and load balancers drop idle connections after a few minutes.
    keepAlive: true,
    keepAliveInitialDelayMillis: 30_000,
    types: typeParsers,
  };
}

function connectError(cause: unknown, options: PostgresOptions): AantjeError {
  if (cause instanceof AantjeError) {
    return cause;
  }
  if (cause instanceof DatabaseError && (cause.code === '28P01' || cause.code === '28000')) {
    return new AantjeError(
      'AUTH_FAILED',
      `Authentication failed on ${endpoint(options)}: ${cause.message}.`,
      {
        cause,
      },
    );
  }
  const message = cause === null || cause === undefined ? '' : messageOf(cause);
  const code = isErrnoException(cause) ? cause.code : undefined;
  let reason = message === '' ? (code ?? 'unknown error') : message;
  if (message === 'timeout expired') {
    reason = `no response within ${(options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000} s`;
  } else {
    reason = networkReason(cause) ?? reason;
  }
  return new AantjeError('CONNECTION_FAILED', `Cannot connect to ${endpoint(options)}: ${reason}.`, {
    cause,
  });
}

function queryError(cause: unknown, options: PostgresOptions, signal?: AbortSignal): AantjeError {
  if (signal?.aborted) {
    return queryCancelled(cause);
  }
  if (cause instanceof DatabaseError) {
    // 57014 is statement_timeout here; a cancel by the user returned above.
    if (cause.code === '57014') {
      return options.statementTimeoutMs
        ? queryTimedOut(options.statementTimeoutMs, cause)
        : new AantjeError(
            'TIMEOUT',
            'The catalog query exceeded the time limit of the server and was cancelled.',
            {
              cause,
            },
          );
    }
    // Classes 08 (connection exception) and 57P (shutdown, restart) end the session.
    if (!cause.code?.startsWith('08') && !cause.code?.startsWith('57P')) {
      return new AantjeError('QUERY_FAILED', `The catalog query failed: ${cause.message}`, { cause });
    }
  }
  return new AantjeError('CONNECTION_FAILED', `The connection to ${endpoint(options)} was lost.`, { cause });
}
