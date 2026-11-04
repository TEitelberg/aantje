import type * as Duckdb from '@duckdb/node-api';
import { AantjeError, messageOf } from '../errors';
import { EXTENSION_HINT } from './errors';
import type { Phase } from './errors';
import { instanceOptions, removeTemporaryFiles } from './instance';
import type { DataAccess } from './types';

export type Engine = typeof Duckdb;

/** Longest delay a timer accepts; a longer one makes `setTimeout` fire at once. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Installing the extensions may download about 40 MB, so it gets its own limit. */
export const EXTENSION_TIMEOUT_MS = 5 * 60_000;

const INTERRUPT_INTERVAL_MS = 50;

/** Loads the native binding on first use so the rest works where none exists; `advice` ends the error sentence. */
export async function loadEngine(advice = '; reading table data needs it.'): Promise<Engine> {
  try {
    return await import('@duckdb/node-api');
  } catch (cause) {
    throw new AantjeError(
      'CONNECTION_FAILED',
      `The native DuckDB engine could not be loaded on this platform (${process.platform}-${process.arch}). Install the aantje build for this platform${advice}`,
      { cause },
    );
  }
}

/** Repeats the interrupt until stopped, because the engine drops one that arrives before the statement starts. */
export function interruptRepeatedly(connection: Pick<Duckdb.DuckDBConnection, 'interrupt'>): () => void {
  const repeat = setInterval(() => connection.interrupt(), INTERRUPT_INTERVAL_MS);
  repeat.unref();
  return () => clearInterval(repeat);
}

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

/** `WithParser` is the type of `GuardedOpen.parser`: the second connection exists exactly when it is `true`. */
interface OpenLake<WithParser extends boolean> {
  readonly instance: Duckdb.DuckDBInstance;
  readonly connection: Duckdb.DuckDBConnection;
  readonly temporary: { readonly temp_directory: string };
  readonly parser: WithParser extends true ? Duckdb.DuckDBConnection : undefined;
}

export interface GuardedOpen<T, WithParser extends boolean = false> {
  readonly engine: Engine;
  readonly access: DataAccess;
  readonly signal: AbortSignal | undefined;
  readonly setup: readonly string[];
  /** Runs one setup statement; default `connection.run(sql)`. */
  readonly run?: (connection: Duckdb.DuckDBConnection, sql: string) => Promise<unknown>;
  /** Opens a second connection before the setup, e.g. for parsing while the first runs a statement. */
  readonly parser?: WithParser;
  /** The text of the `ABORTED` error. */
  readonly cancelledText: string;
  /** Starts the text of the `TIMEOUT` error of the attach (`access.timeoutMs`). */
  readonly activity: string;
  /**
   * The attach locks the catalog file until the instance closes, so a cancel during the attach is reported only then.
   */
  readonly lockingFile?: boolean;
  /** Keeps the instance open after `use` returns; otherwise everything closes when `use` ends. */
  readonly keepOpen?: boolean;
  /** `access.timeoutMs` ends with the setup: `use` runs several statements and limits each of them itself. */
  readonly limitSetupOnly?: boolean;
  readonly use: (lake: OpenLake<WithParser>) => T | Promise<T>;
  /** Turns the failure into the error the caller gets; `connection` is there once the instance was opened. */
  readonly fail: (
    cause: unknown,
    phase: Phase,
    connection: Duckdb.DuckDBConnection | undefined,
  ) => Error | Promise<Error>;
}

/**
 * Opens a fresh in-memory DuckDB, runs the setup, then `use`. Extension install has its own time limit,
 * `access.timeoutMs` covers attach and `use` (the attach only with `limitSetupOnly`); everything closes on every path unless `keepOpen`.
 */
export async function guardedOpen<T, WithParser extends boolean = false>(
  opening: GuardedOpen<T, WithParser>,
): Promise<T> {
  const { engine, access, signal, setup, fail } = opening;
  // A time limit aborts `limit` with its `TIMEOUT` error as reason; a user abort has another.
  const limit = new AbortController();
  const cancel = AbortSignal.any(signal ? [signal, limit.signal] : [limit.signal]);
  const cancelled = (): AantjeError =>
    cancel.reason instanceof AantjeError ? cancel.reason : new AantjeError('ABORTED', opening.cancelledText);
  if (cancel.aborted) throw cancelled();

  let attaching = false;
  const released = new Promise<never>((_, reject) => {
    cancel.addEventListener(
      'abort',
      () => {
        if (!(attaching && opening.lockingFile)) reject(cancelled());
      },
      { once: true },
    );
  });

  // A close that fails after a successful read: the caller turns it into the error of the call.
  async function open(): Promise<T> {
    const late: { closeFailure?: { readonly cause: unknown; readonly phase: Phase } } = {};
    const value = await attempt(late);
    if (late.closeFailure) {
      throw await fail(late.closeFailure.cause, late.closeFailure.phase, undefined);
    }
    return value;
  }

  async function attempt(late: {
    closeFailure?: { readonly cause: unknown; readonly phase: Phase };
  }): Promise<T> {
    let phase: Phase = 'extension';
    let clock: NodeJS.Timeout | undefined;
    let stopInterrupt: (() => void) | undefined;
    let instance: Duckdb.DuckDBInstance | undefined;
    let connection: Duckdb.DuckDBConnection | undefined;
    let parser: Duckdb.DuckDBConnection | undefined;
    let kept = false;
    let failed = false;
    const temporary = instanceOptions(access);
    const startClock = (ms: number, message: string): void => {
      clearTimeout(clock);
      clock = setTimeout(
        () => limit.abort(new AantjeError('TIMEOUT', message)),
        Math.min(ms, MAX_TIMEOUT_MS),
      );
      clock.unref();
    };
    const interrupt = (): void => {
      if (connection) stopInterrupt ??= interruptRepeatedly(connection);
    };
    try {
      cancel.addEventListener('abort', interrupt, { once: true });
      const extensionMs = access.extensionTimeoutMs ?? EXTENSION_TIMEOUT_MS;
      startClock(
        extensionMs,
        `Installing the DuckDB extensions exceeded the time limit of ${extensionMs / 1000} s and was cancelled. ${EXTENSION_HINT}`,
      );
      const created = await engine.DuckDBInstance.create(':memory:', temporary);
      instance = created;
      const main = await created.connect();
      connection = main;
      parser = opening.parser ? await created.connect() : undefined;
      for (const sql of setup) {
        if (cancel.aborted) throw cancelled();
        if (phase === 'extension' && !/^(INSTALL|LOAD) /.test(sql)) {
          phase = 'setup';
          attaching = true;
          clearTimeout(clock);
          if (access.timeoutMs !== undefined) {
            startClock(
              access.timeoutMs,
              `${opening.activity} exceeded the time limit of ${access.timeoutMs / 1000} s and was cancelled.`,
            );
          }
        }
        await (opening.run ? opening.run(main, sql) : main.run(sql));
      }
      if (opening.limitSetupOnly) clearTimeout(clock);
      if (cancel.aborted) throw cancelled();
      phase = 'query';
      // `parser` was opened exactly when `opening.parser` is true, which `WithParser` records.
      const value = await opening.use({
        instance: created,
        connection: main,
        parser,
        temporary,
      } as OpenLake<WithParser>);
      if (opening.keepOpen) {
        if (cancel.aborted) throw cancelled();
        kept = true;
      }
      return value;
    } catch (cause) {
      failed = true;
      if (cancel.aborted) throw cancelled();
      throw await fail(cause, phase, connection);
    } finally {
      clearTimeout(clock);
      stopInterrupt?.();
      cancel.removeEventListener('abort', interrupt);
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

  return Promise.race([open(), released]);
}
