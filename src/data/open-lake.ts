import type * as Duckdb from '@duckdb/node-api';
import { EXTENSION_TIMEOUT_MS, interruptRepeatedly, MAX_TIMEOUT_MS } from '../duckdb/engine';
import type { Engine } from '../duckdb/engine';
import { EXTENSION_HINT } from '../duckdb/messages';
import { AantjeError, messageOf } from '../errors';
import type { Phase } from './errors';
import { instanceOptions, removeTemporaryFiles } from './instance';
import type { DataAccess } from './types';

/** Closes every handle even if one throws, removes the temporary files, then rethrows the first failure. */
export function closeAll(
  handles: readonly ({ closeSync(): void } | undefined)[],
  temporary: { readonly temp_directory: string },
): void {
  const failures: unknown[] = [];
  for (const handle of handles) {
    try {
      handle?.closeSync();
    } catch (failure) {
      failures.push(failure);
    }
  }
  removeTemporaryFiles(temporary);
  if (failures.length > 0) throw failures[0];
}

/** The engine with the lake attached, as `use` gets it. */
interface OpenLake {
  readonly instance: Duckdb.DuckDBInstance;
  readonly connection: Duckdb.DuckDBConnection;
  readonly temporary: { readonly temp_directory: string };
}

/** Turns the failure into the error the caller gets; `connection` is there once the instance was opened. */
export type OpenFailure = (
  cause: unknown,
  phase: Phase,
  connection: Duckdb.DuckDBConnection | undefined,
) => Error | Promise<Error>;

/** What every open of the lake needs. */
interface Opening {
  readonly engine: Engine;
  readonly access: DataAccess;
  readonly signal: AbortSignal | undefined;
  readonly setup: readonly string[];
  /** The text of the `ABORTED` error. */
  readonly cancelledText: string;
  /** Starts the text of the `TIMEOUT` error of the attach (`access.timeoutMs`). */
  readonly activity: string;
  readonly fail: OpenFailure;
}

export interface LakeOpening<T> extends Opening {
  /** `access.timeoutMs` ends with the setup: `use` runs several statements and limits each of them itself. */
  readonly limitSetupOnly?: boolean;
  readonly use: (lake: OpenLake) => T | Promise<T>;
}

export interface SessionOpening<T> extends Opening {
  /** Runs one setup statement; default `connection.run(sql)`. */
  readonly run?: (connection: Duckdb.DuckDBConnection, sql: string) => Promise<unknown>;
  /**
   * The attach locks the catalog file until the instance closes, so a cancel during the attach is reported only then.
   */
  readonly lockingFile?: boolean;
  /** Gets a second connection that parses while the first runs a statement. What it returns keeps both open. */
  readonly use: (lake: OpenLake & { readonly parser: Duckdb.DuckDBConnection }) => T | Promise<T>;
}

/**
 * Opens a fresh in-memory DuckDB, runs the setup, then `use`, and closes everything on every path. Extension install
 * has its own time limit, `access.timeoutMs` covers attach and `use` (the attach only with `limitSetupOnly`).
 */
export function withOpenLake<T>(opening: LakeOpening<T>): Promise<T> {
  return guardedOpen(opening, {
    connectParser: () => Promise.resolve(undefined),
    run: (connection, sql) => connection.run(sql),
    use: (lake) => opening.use(lake),
    keepOpen: false,
    lockingFile: false,
    limitSetupOnly: opening.limitSetupOnly ?? false,
  });
}

/**
 * Opens the engine of a SQL session like `withOpenLake`, with a second connection for parsing, and keeps both open
 * when `use` returns; a failure or a cancel closes everything. `access.timeoutMs` covers the attach.
 */
export function openLakeSession<T>(opening: SessionOpening<T>): Promise<T> {
  return guardedOpen(opening, {
    connectParser: (instance) => instance.connect(),
    run: opening.run ?? ((connection, sql) => connection.run(sql)),
    use: (lake, parser) => opening.use({ ...lake, parser }),
    keepOpen: true,
    lockingFile: opening.lockingFile ?? false,
    limitSetupOnly: false,
  });
}

/** Where the two opens differ: a read closes when `use` ends, a SQL session stays open with a second connection. */
interface Lifecycle<T, P extends Duckdb.DuckDBConnection | undefined> {
  /** Opens the parser connection of a session before the setup; a read has none. */
  readonly connectParser: (instance: Duckdb.DuckDBInstance) => Promise<P>;
  readonly run: (connection: Duckdb.DuckDBConnection, sql: string) => Promise<unknown>;
  readonly use: (lake: OpenLake, parser: P) => T | Promise<T>;
  /** What `use` returns keeps the instance open; otherwise everything closes when `use` ends. */
  readonly keepOpen: boolean;
  readonly lockingFile: boolean;
  readonly limitSetupOnly: boolean;
}

/** The cancel of one open: the caller's signal, or the time limit with its `TIMEOUT` error as the reason. */
interface Cancel {
  readonly limit: AbortController;
  readonly signal: AbortSignal;
  readonly error: () => AantjeError;
  /** Set when the first statement after the extensions starts: from then on the attach may lock the catalog file. */
  readonly attaching: { value: boolean };
}

/** A close that fails after a successful read: the caller turns it into the error of the call. */
interface LateFailure {
  closeFailure?: { readonly cause: unknown; readonly phase: Phase };
}

async function guardedOpen<T, P extends Duckdb.DuckDBConnection | undefined>(
  opening: Opening,
  lifecycle: Lifecycle<T, P>,
): Promise<T> {
  const limit = new AbortController();
  const signal = AbortSignal.any(opening.signal ? [opening.signal, limit.signal] : [limit.signal]);
  const cancel: Cancel = {
    limit,
    signal,
    error: () =>
      signal.reason instanceof AantjeError
        ? signal.reason
        : new AantjeError('ABORTED', opening.cancelledText),
    attaching: { value: false },
  };
  if (signal.aborted) throw cancel.error();

  const released = new Promise<never>((_, reject) => {
    signal.addEventListener(
      'abort',
      () => {
        if (!(cancel.attaching.value && lifecycle.lockingFile)) reject(cancel.error());
      },
      { once: true },
    );
  });

  async function open(): Promise<T> {
    const late: LateFailure = {};
    const value = await attempt(opening, lifecycle, cancel, late);
    if (late.closeFailure) {
      throw await opening.fail(late.closeFailure.cause, late.closeFailure.phase, undefined);
    }
    return value;
  }

  return Promise.race([open(), released]);
}

async function attempt<T, P extends Duckdb.DuckDBConnection | undefined>(
  opening: Opening,
  lifecycle: Lifecycle<T, P>,
  cancel: Cancel,
  late: LateFailure,
): Promise<T> {
  const { engine, access, setup, fail } = opening;
  let phase: Phase = 'extension';
  let clock: NodeJS.Timeout | undefined;
  let stopInterrupt: (() => void) | undefined;
  let instance: Duckdb.DuckDBInstance | undefined;
  let connection: Duckdb.DuckDBConnection | undefined;
  let parser: P | undefined;
  let kept = false;
  let failed = false;
  const temporary = instanceOptions(access);
  const startClock = (ms: number, message: string): void => {
    clearTimeout(clock);
    clock = setTimeout(
      () => cancel.limit.abort(new AantjeError('TIMEOUT', message)),
      Math.min(ms, MAX_TIMEOUT_MS),
    );
    clock.unref();
  };
  const interrupt = (): void => {
    if (connection) stopInterrupt ??= interruptRepeatedly(connection);
  };
  try {
    cancel.signal.addEventListener('abort', interrupt, { once: true });
    const extensionMs = access.extensionTimeoutMs ?? EXTENSION_TIMEOUT_MS;
    startClock(
      extensionMs,
      `Installing the DuckDB extensions exceeded the time limit of ${extensionMs / 1000} s and was cancelled. ${EXTENSION_HINT}`,
    );
    const created = await engine.DuckDBInstance.create(':memory:', temporary);
    instance = created;
    const main = await created.connect();
    connection = main;
    const second = await lifecycle.connectParser(created);
    parser = second;
    for (const sql of setup) {
      if (cancel.signal.aborted) throw cancel.error();
      if (phase === 'extension' && !/^(INSTALL|LOAD) /.test(sql)) {
        phase = 'setup';
        cancel.attaching.value = true;
        clearTimeout(clock);
        if (access.timeoutMs !== undefined) {
          startClock(
            access.timeoutMs,
            `${opening.activity} exceeded the time limit of ${access.timeoutMs / 1000} s and was cancelled.`,
          );
        }
      }
      await lifecycle.run(main, sql);
    }
    if (lifecycle.limitSetupOnly) clearTimeout(clock);
    if (cancel.signal.aborted) throw cancel.error();
    phase = 'query';
    const value = await lifecycle.use({ instance: created, connection: main, temporary }, second);
    if (lifecycle.keepOpen) {
      if (cancel.signal.aborted) throw cancel.error();
      kept = true;
    }
    return value;
  } catch (cause) {
    failed = true;
    if (cancel.signal.aborted) throw cancel.error();
    throw await fail(cause, phase, connection);
  } finally {
    clearTimeout(clock);
    stopInterrupt?.();
    cancel.signal.removeEventListener('abort', interrupt);
    if (!kept) {
      try {
        closeAll([parser, connection, instance], temporary);
      } catch (closing) {
        // A throw here would replace the error above, which `fail` has already scrubbed of secrets, with the raw one
        // of the engine. Only a close that fails after a successful read is the error of the call.
        access.log?.warn(`The DuckDB engine did not close cleanly: ${messageOf(closing)}`);
        if (!failed) late.closeFailure = { cause: closing, phase };
      }
    }
  }
}
