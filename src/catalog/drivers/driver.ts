/** A value in a result row. */
export type Value = string | number | boolean | null;

/** One result row; keys are the lower-cased column names. */
export type Row = Readonly<Record<string, Value>>;

export interface QueryOptions {
  /** Aborts a running query where the engine supports it (PostgreSQL, DuckDB, Quack; SQLite only checks it first). */
  readonly signal?: AbortSignal;
}

/**
 * Read-only metadata database access: `?` placeholders, lower-cased columns, INTEGER/BIGINT as `number`, ISO 8601
 * dates, `AantjeError` failures.
 */
export interface Driver {
  query(sql: string, params?: readonly Value[], options?: QueryOptions): Promise<Row[]>;
  close(): Promise<void>;
}
