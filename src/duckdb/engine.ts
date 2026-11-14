import type * as Duckdb from '@duckdb/node-api';
import { AantjeError } from '../errors';

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
