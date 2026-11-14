import type { Row, Value } from '../drivers/driver';
import type { Query } from '../queries/shared';
import { toIsoUtc } from '../timestamp';

/** Runs a statement; the signal stops it where the engine can. */
export type Run = (query: Query, signal?: AbortSignal) => Promise<Row[]>;

/**
 * Like `Run` for tables an older catalog may lack: `QUERY_FAILED` gives undefined, other errors (lock, timeout) pass
 * on.
 */
export type Attempt = (query: Query, signal?: AbortSignal) => Promise<Row[] | undefined>;

/**
 * Runs the statement that `build` makes with the commit columns of `ducklake_snapshot_changes` (author, commit
 * message), or without them on a catalog that lacks them.
 */
export type WithCommits = (build: (commitColumns: boolean) => Query, signal?: AbortSignal) => Promise<Row[]>;

/** Drivers return INTEGER and BIGINT as numbers; an unrepresentable value fails instead of rounding. */
export function toNumber(value: Value | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected a number but the catalog returned ${String(value)}.`);
  }
  return value;
}

export function toNumberOrNull(value: Value | undefined): number | null {
  return value === null ? null : toNumber(value);
}

export function toText(value: Value | undefined): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected text but the catalog returned ${String(value)}.`);
  }
  return value;
}

export function toTextOrNull(value: Value | undefined): string | null {
  return value === null ? null : toText(value);
}

/** SQLite returns 0/1, PostgreSQL and DuckDB booleans. */
export function toBoolean(value: Value | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 0 || value === 1) {
    return value === 1;
  }
  throw new Error(`Expected a boolean but the catalog returned ${String(value)}.`);
}

export function toIsoUtcOrNull(value: Value | undefined): string | null {
  return value === null || value === undefined ? null : toIsoUtc(toText(value));
}
