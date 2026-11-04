import type * as Duckdb from '@duckdb/node-api';
import { quackSecretStatement, quackUri } from '../../data/attach';
import { EXTENSION_HINT, firstLine, quackProblem } from '../../data/errors';
import { EXTENSION_TIMEOUT_MS, loadEngine, MAX_TIMEOUT_MS } from '../../data/open-lake';
import type { Engine } from '../../data/open-lake';
import { AantjeError, messageOf } from '../../errors';
import { maskSecrets } from '../../secrets';
import { quoteLiteral } from '../ddl';
import type { Driver, QueryOptions, Row, Value } from './driver';
import { toRow } from './duckdb';
import { catalogClosed, NO_ENGINE_ADVICE, queryCancelled, queryLimits, track } from './limits';

export interface QuackOptions {
  readonly host: string;
  readonly port: number;
  /** The token of the server; it appears in `CREATE SECRET` only. */
  readonly token?: string;
  /** TLS; without `fingerprint` the certificate is checked against the system trust store. */
  readonly ssl: boolean;
  /** SHA-256 fingerprint of the server certificate (`AB:CD:...`). */
  readonly fingerprint?: string;
  /** Maximum duration of one query, and of the attach, in milliseconds. */
  readonly statementTimeoutMs?: number;
  /** DuckDB `extension_directory`; undefined keeps the DuckDB default (the extension downloads on first use). */
  readonly extensionDirectory?: string;
  /** Test seam, not a setting: a stand-in for the native engine, to play a server that restarts or hangs. */
  readonly engine?: Engine;
}

const CATALOG = 'metadata';
// How long `close` waits for the interrupted queries; one on a server that hangs ignores the interrupt.
const CLOSE_GRACE_MS = 3000;

/**
 * The statements that attach the served catalog on a fresh in-memory DuckDB and lock the instance. The attach is not
 * read-only: DuckDB 2.0.0 accepts `READ_ONLY` for Quack without enforcing it, and newer quack builds refuse it. The
 * lock is the protection: the instance reaches this one server and nothing else, no file and no other extension,
 * whatever statement runs on it, and the reader sends fixed SELECTs only. Exported for its tests.
 */
export function quackSetup(options: QuackOptions): string[] {
  const uri = quackUri(options);
  // A pin needs TLS; quack refuses SSL_FINGERPRINT together with DISABLE_SSL true.
  const pin = options.ssl && options.fingerprint !== undefined;
  const attachOptions = [
    `DISABLE_SSL ${!options.ssl}`,
    ...(pin ? [`SSL_FINGERPRINT ${quoteLiteral(options.fingerprint ?? '')}`] : []),
  ];
  const endpoint = `${options.ssl ? 'https' : 'http'}://${options.host}:${options.port}/quack`;
  // Quack sends its requests through httpfs, which the ATTACH would otherwise install and load on its own.
  return [
    'INSTALL quack',
    'LOAD quack',
    'INSTALL httpfs',
    'LOAD httpfs',
    ...(options.token ? [quackSecretStatement(uri, options.token)] : []),
    `ATTACH ${quoteLiteral(uri)} AS ${CATALOG} (${attachOptions.join(', ')})`,
    `SET allowed_paths = [${quoteLiteral(endpoint)}]`,
    'SET enable_external_access = false',
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    'SET lock_configuration = true',
  ];
}

/**
 * `sql` with every `?` replaced by its value as a SQL literal: the quack extension of DuckDB 2.0.0 loses the bound
 * parameters of a statement that reads its tables. The reader writes `?` only where a value goes, never inside a
 * literal or a comment; the PostgreSQL driver numbers them the same way. Exported for its tests.
 */
export function inlineParameters(sql: string, params: readonly Value[]): string {
  let index = 0;
  const inlined = sql.replace(/\?/g, () => literal(params[index++] ?? null));
  if (index !== params.length) {
    throw new AantjeError(
      'QUERY_FAILED',
      `The catalog query has ${index} placeholders for ${params.length} values.`,
    );
  }
  return inlined;
}

function literal(value: Value): string {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return quoteLiteral(value);
  if (!Number.isFinite(value)) {
    throw new AantjeError(
      'QUERY_FAILED',
      `The catalog query got the value ${value}, which is not a number in SQL.`,
    );
  }
  // In parentheses, so that a minus before the placeholder and the sign cannot form a comment (`--`).
  return value < 0 ? `(${value})` : String(value);
}

/** What the attaches of one driver share. */
interface Link {
  readonly engine: Engine;
  readonly options: QuackOptions;
  /** `host:port`, as messages name the server. */
  readonly endpoint: string;
  readonly secrets: readonly string[];
  readonly shutdown: AbortController;
  /** Engine calls that may outlive the call that started them; no instance is closed while one runs. */
  readonly work: Set<Promise<unknown>>;
  readonly opened: Set<Duckdb.DuckDBInstance>;
}

/**
 * Attaches the catalog that a DuckDB server serves over Quack. Queries take turns, each on its own connection of one
 * locked in-memory instance; one is given up when its limit or signal fires, because an interrupt does not reach a
 * server that hangs, and the engine call ends on its own later. When the server lost the connection (it was restarted
 * or went away), the next query attaches again, and a query that met a restart runs once more.
 */
export async function openQuack(options: QuackOptions): Promise<Driver> {
  const secrets = options.token ? [options.token] : [];
  const link: Link = {
    engine: options.engine ?? (await loadEngine(NO_ENGINE_ADVICE)),
    options,
    // A token pasted into the host field must not show up in a message either.
    endpoint: maskSecrets(`${options.host}:${options.port}`, secrets),
    secrets,
    shutdown: new AbortController(),
    work: new Set(),
    opened: new Set(),
  };
  let attached = attach(link);
  await attached;
  let live = true;

  const connect = (): Promise<Duckdb.DuckDBInstance> => {
    if (!live) {
      live = true;
      attached = attach(link);
      attached.catch(() => {
        live = false;
      });
    }
    return attached;
  };

  // The quack client runs the statements of all connections of an attach on one connection to the server, where a
  // statement that starts while another runs supersedes it; so the queries take turns. A query that is given up passes
  // its turn on, although its engine call may still run.
  let previous: Promise<unknown> = Promise.resolve();
  async function inTurn<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    const before = previous;
    let release = (): void => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    previous = Promise.all([before, done]);
    try {
      const waiting = AbortSignal.any([link.shutdown.signal, signal].filter((s) => s !== undefined));
      await unlessCancelled(before, waiting, () => queryCancelled());
      return await run();
    } finally {
      release();
    }
  }

  async function execute(
    sql: string,
    params: readonly Value[],
    signal: AbortSignal | undefined,
    again: boolean,
  ): Promise<Row[]> {
    const text = inlineParameters(sql, params);
    const outcome = { restarted: false };
    try {
      return await inTurn(signal, async () => {
        // The time limit counts from the turn, not from the call.
        const { cancel, cancelled } = queryLimits(
          link.shutdown.signal,
          signal,
          link.options.statementTimeoutMs,
        );
        if (cancel.aborted) throw cancelled();
        const pending = connect();
        const instance = await unlessCancelled(pending, cancel, cancelled);
        try {
          return await unlessCancelled(
            track(link.work, read(link, instance, text, cancel)),
            cancel,
            cancelled,
          );
        } catch (cause) {
          const message = cause instanceof AantjeError ? '' : messageOf(cause);
          if (quackProblem(message)?.reconnect && attached === pending && live) {
            live = false;
            retire(link, instance);
          }
          outcome.restarted = /Invalid connection id/.test(message) && !cancel.aborted;
          throw queryError(link, cause);
        }
      });
    } catch (error) {
      // A restarted server is back, so the query can run on a new attach right away.
      if (again && outcome.restarted) {
        return execute(sql, params, signal, false);
      }
      throw error;
    }
  }

  return {
    query(sql: string, params: readonly Value[] = [], queryOptions?: QueryOptions): Promise<Row[]> {
      if (link.shutdown.signal.aborted) {
        return Promise.reject(catalogClosed());
      }
      return execute(sql, params, queryOptions?.signal, true);
    },
    close: () => close(link),
  };
}

// A fresh locked instance with the catalog attached; the extension install and the attach have their own limits.
async function attach(link: Link): Promise<Duckdb.DuckDBInstance> {
  const { engine, options, endpoint } = link;
  const instance = await engine.DuckDBInstance.create(':memory:', {
    allow_persistent_secrets: 'false',
    ...(options.extensionDirectory ? { extension_directory: options.extensionDirectory } : {}),
  }).catch((cause: unknown) => {
    throw openError(link, cause, 'setup');
  });
  link.opened.add(instance);
  const limit = new AbortController();
  let clock: NodeJS.Timeout | undefined;
  const startClock = (ms: number | undefined, message: string): void => {
    clearTimeout(clock);
    if (ms === undefined) return;
    clock = setTimeout(() => limit.abort(new AantjeError('TIMEOUT', message)), Math.min(ms, MAX_TIMEOUT_MS));
    clock.unref();
  };
  let phase: 'extension' | 'setup' = 'extension';
  startClock(
    EXTENSION_TIMEOUT_MS,
    `Installing the DuckDB extensions quack and httpfs exceeded the time limit of ${EXTENSION_TIMEOUT_MS / 1000} s and was cancelled. ${EXTENSION_HINT}`,
  );
  const setup = track(
    link.work,
    (async () => {
      const connection = await instance.connect();
      try {
        for (const sql of quackSetup(options)) {
          if (phase === 'extension' && !/^(INSTALL|LOAD) /.test(sql)) {
            phase = 'setup';
            const ms = options.statementTimeoutMs;
            startClock(
              ms,
              `Connecting to ${endpoint} exceeded the time limit of ${(ms ?? 0) / 1000} s and was cancelled.`,
            );
          }
          await connection.run(sql);
        }
      } finally {
        connection.closeSync();
      }
    })(),
  );
  const cancel = AbortSignal.any([link.shutdown.signal, limit.signal]);
  try {
    await unlessCancelled(setup, cancel, () =>
      cancel.reason instanceof AantjeError ? cancel.reason : queryCancelled(),
    );
    return instance;
  } catch (cause) {
    retire(link, instance);
    throw cause instanceof AantjeError ? cause : openError(link, cause, phase);
  } finally {
    clearTimeout(clock);
  }
}

async function read(
  link: Link,
  instance: Duckdb.DuckDBInstance,
  sql: string,
  cancel: AbortSignal,
): Promise<Row[]> {
  const connection = await instance.connect();
  const interrupt = (): void => connection.interrupt();
  cancel.addEventListener('abort', interrupt, { once: true });
  try {
    await connection.run(`USE ${CATALOG}`);
    const result = await connection.run(sql);
    try {
      return (await result.getRowObjects()).map((row) => toRow(link.engine, row));
    } finally {
      result.closeSync();
    }
  } finally {
    cancel.removeEventListener('abort', interrupt);
    connection.closeSync();
  }
}

async function close(link: Link): Promise<void> {
  if (link.shutdown.signal.aborted) return;
  link.shutdown.abort();
  const pending = Promise.allSettled([...link.work]);
  let grace: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    pending.then(() => true),
    new Promise<boolean>((resolve) => {
      grace = setTimeout(() => resolve(false), CLOSE_GRACE_MS);
      grace.unref();
    }),
  ]);
  clearTimeout(grace);
  const closeAll = (): void => [...link.opened].forEach((instance) => closeQuietly(link, instance));
  if (settled) closeAll();
  else void pending.then(closeAll);
}

// Closes the instance once the engine calls that run now have ended.
function retire(link: Link, instance: Duckdb.DuckDBInstance): void {
  void Promise.allSettled([...link.work]).then(() => closeQuietly(link, instance));
}

function closeQuietly(link: Link, instance: Duckdb.DuckDBInstance): void {
  link.opened.delete(instance);
  try {
    instance.closeSync();
  } catch {
    // Nothing is left to release.
  }
}

function scrubbed(link: Link, cause: unknown): string {
  return firstLine(maskSecrets(messageOf(cause), link.secrets));
}

function openError(link: Link, cause: unknown, phase: 'extension' | 'setup'): AantjeError {
  const message = scrubbed(link, cause);
  const safe = { cause: new Error(message) };
  if (phase === 'extension') {
    return new AantjeError(
      'CONNECTION_FAILED',
      `The DuckDB extensions quack and httpfs, which read a Quack server, could not be installed or loaded (${message}). ${EXTENSION_HINT}`,
      safe,
    );
  }
  const problem = quackProblem(message);
  return problem?.code === 'AUTH_FAILED'
    ? new AantjeError('AUTH_FAILED', `Authentication failed on ${link.endpoint}: ${problem.reason}.`, safe)
    : new AantjeError(
        'CONNECTION_FAILED',
        `Cannot connect to ${link.endpoint}: ${problem?.reason ?? message}.`,
        safe,
      );
}

function queryError(link: Link, cause: unknown): AantjeError {
  if (cause instanceof AantjeError) return cause;
  const message = scrubbed(link, cause);
  const problem = quackProblem(message);
  const safe = { cause: new Error(message) };
  return problem
    ? new AantjeError(problem.code, `The catalog query on ${link.endpoint} failed: ${problem.reason}.`, safe)
    : new AantjeError('QUERY_FAILED', `The catalog query failed: ${message}`, safe);
}

/** `work`, or a rejection with `cancelled()` as soon as `cancel` fires; the engine call then goes on alone. */
function unlessCancelled<T>(work: Promise<T>, cancel: AbortSignal, cancelled: () => AantjeError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(cancelled());
    if (cancel.aborted) stop();
    cancel.addEventListener('abort', stop, { once: true });
    work.then(resolve, reject).finally(() => cancel.removeEventListener('abort', stop));
  });
}
