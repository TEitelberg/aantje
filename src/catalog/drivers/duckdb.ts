import { open } from 'node:fs/promises';
import type * as Duckdb from '@duckdb/node-api';
import { interruptRepeatedly, loadEngine } from '../../data/open-lake';
import type { Engine } from '../../data/open-lake';
import { AantjeError, isErrnoException, messageOf } from '../../errors';
import type { Driver, QueryOptions, Row, Value } from './driver';
import { catalogClosed, NO_ENGINE_ADVICE, queryLimits, track } from './limits';

interface DuckdbOptions {
  /** DuckDB file that holds the `ducklake_*` tables. */
  readonly path: string;
  /** Maximum duration of one query in milliseconds. */
  readonly statementTimeoutMs?: number;
}

/** Opens the catalog file read-only; each query gets its own connection so an interrupt cannot hit another. */
export async function openDuckdb({ path, statementTimeoutMs }: DuckdbOptions): Promise<Driver> {
  await assertReadable(path);
  const engine = await loadEngine(NO_ENGINE_ADVICE);
  const instance = await engine.DuckDBInstance.create(path, {
    access_mode: 'READ_ONLY',
    // A catalog file can come from anywhere: its views must not be able to read other files or the network.
    enable_external_access: 'false',
  }).catch((cause: unknown) => {
    throw openError(path, cause);
  });

  const shutdown = new AbortController();
  const inflight = new Set<Promise<unknown>>();

  async function execute(sql: string, params: readonly Value[], signal?: AbortSignal): Promise<Row[]> {
    const { cancel, cancelled } = queryLimits(shutdown.signal, signal, statementTimeoutMs);
    if (cancel.aborted) throw cancelled();

    const connection = await instance.connect();
    let stopInterrupt: (() => void) | undefined;
    const interrupt = (): void => {
      connection.interrupt();
      stopInterrupt ??= interruptRepeatedly(connection);
    };
    try {
      if (cancel.aborted) throw cancelled();
      cancel.addEventListener('abort', interrupt, { once: true });
      const result = await connection.run(sql, [...params]);
      try {
        return (await result.getRowObjects()).map((row) => toRow(engine, row));
      } finally {
        result.closeSync();
      }
    } catch (cause) {
      throw cancel.aborted ? cancelled() : queryError(cause);
    } finally {
      stopInterrupt?.();
      cancel.removeEventListener('abort', interrupt);
      connection.closeSync();
    }
  }

  return {
    query(sql: string, params: readonly Value[] = [], options?: QueryOptions): Promise<Row[]> {
      if (shutdown.signal.aborted) {
        return Promise.reject(catalogClosed());
      }
      return track(inflight, execute(sql, params, options?.signal));
    },
    async close(): Promise<void> {
      shutdown.abort();
      await Promise.allSettled(inflight);
      instance.closeSync();
    },
  };
}

// On Windows DuckDB's exclusive write handle blocks plain readers (EBUSY). Elsewhere only DuckDB sees the lock (see
// `openError`).
async function assertReadable(path: string): Promise<void> {
  try {
    await (await open(path, 'r')).close();
  } catch (cause) {
    const code = isErrnoException(cause) ? cause.code : undefined;
    throw code === 'EBUSY'
      ? lockedError(path, cause)
      : new AantjeError('FILE_NOT_FOUND', `Cannot read "${path}": ${code ?? 'unknown error'}.`, { cause });
  }
}

function lockedError(path: string, cause: unknown): AantjeError {
  return new AantjeError(
    'LOCKED',
    `"${path}" is in use by another application that has it open for writing, for example a notebook or script that attached the DuckLake. Close it there (or detach the catalog), then connect again.`,
    { cause },
  );
}

function openError(path: string, cause: unknown): AantjeError {
  const message = messageOf(cause);
  if (message.includes('Could not set lock on file')) return lockedError(path, cause);
  // A SQLite file makes DuckDB load its sqlite extension, which disabled external access forbids.
  const foreign =
    message.includes('not a valid DuckDB database file') ||
    message.includes('Loading external extensions is disabled');
  return new AantjeError(
    'CONNECTION_FAILED',
    foreign
      ? `"${path}" is not a valid DuckDB database file.`
      : `Cannot open "${path}" as a DuckDB database: ${message}`,
    { cause },
  );
}

function queryError(cause: unknown): AantjeError {
  return cause instanceof AantjeError
    ? cause
    : new AantjeError('QUERY_FAILED', `The catalog query failed: ${messageOf(cause)}`, { cause });
}

export function toRow(engine: Engine, object: Record<string, Duckdb.DuckDBValue>): Row {
  const row: Record<string, Value> = {};
  for (const [key, value] of Object.entries(object)) {
    row[key.toLowerCase()] = toValue(engine, value);
  }
  return row;
}

function toValue(engine: Engine, value: Duckdb.DuckDBValue): Value {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value;
  }
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) {
      throw new AantjeError(
        'QUERY_FAILED',
        `The catalog returned the integer ${value}, which is larger than the largest exactly representable number (${Number.MAX_SAFE_INTEGER}).`,
      );
    }
    return number;
  }
  if (value instanceof engine.DuckDBTimestampValue || value instanceof engine.DuckDBTimestampTZValue) {
    // BigInt division truncates toward zero; before 1970 the millisecond must round down.
    const { micros } = value;
    return new Date(Number(micros / 1000n - (micros % 1000n < 0n ? 1n : 0n))).toISOString();
  }
  if (value instanceof engine.DuckDBDateValue) {
    return new Date(value.days * 86_400_000).toISOString();
  }
  if (value instanceof engine.DuckDBDecimalValue) {
    return value.toDouble();
  }
  return String(value);
}
