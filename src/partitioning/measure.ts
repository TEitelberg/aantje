// The read-only measurements of Suggest Partitioning, on a session of the lake: distinct values and NULLs of the
// candidate columns, the partitions of each unit of time, and the largest partition of a suggestion.
import { quoteIdentifier } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import type { LakeSession } from '../data/lake-session';
import type { GridValue } from '../data/types';
import { TEMPORAL_UNITS, isTemporal } from './model';
import type { ColumnMeasure, TemporalUnit } from './model';

/** The table in the session of the lake. */
export const relation = (schema: string, table: string): string =>
  `${LAKE}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

const number = (value: GridValue | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The rows of the table, and the distinct values and non-NULL values of each column, in one scan. */
export function distinctStatement(schema: string, table: string, columns: readonly string[]): string {
  const parts = columns.flatMap((column) => {
    const name = quoteIdentifier(column);
    return [`approx_count_distinct(${name})`, `count(${name})`];
  });
  return `SELECT ${['count(*)', ...parts].join(', ')} FROM ${relation(schema, table)}`;
}

/** The truncation of a time to a unit; `year` as the year, the others as the start of the unit. */
const truncated = (name: string, unit: TemporalUnit): string =>
  unit === 'year' ? `year(${name})` : `date_trunc('${unit}', ${name})`;

/** The partitions of each unit of a date or timestamp column (a date has no hours). */
export function unitStatement(schema: string, table: string, column: string, type: string): string {
  const name = quoteIdentifier(column);
  const units = TEMPORAL_UNITS.filter((unit) => unit !== 'hour' || type !== 'date');
  return `SELECT ${units.map((unit) => `count(DISTINCT ${truncated(name, unit)})`).join(', ')} FROM ${relation(schema, table)}`;
}

/**
 * The partition keys as expressions DuckDB evaluates: `bucket(n, c)` is a transform of DuckLake only, so its dry run
 * uses `hash(c) % n`, which spreads the values as evenly, into other buckets.
 */
export function keyExpression(key: string): string {
  const bucket = /^bucket\((\d+), (".*")\)$/s.exec(key);
  return bucket ? `hash(${bucket[2] ?? ''}) % ${bucket[1] ?? '1'}` : key;
}

/** The rows of the largest partition that the keys would give. */
export function largestStatement(schema: string, table: string, keys: readonly string[]): string {
  return `SELECT CAST(max(n) AS BIGINT) FROM (SELECT count(*) AS n FROM ${relation(schema, table)} GROUP BY ${keys.map(keyExpression).join(', ')})`;
}

/** Measures the columns; the rows are those of the table at the newest snapshot. */
export async function measureColumns(
  session: LakeSession,
  table: { readonly schema: string; readonly name: string },
  columns: readonly { readonly name: string; readonly type: string }[],
  limitMs: number,
): Promise<{ readonly rows: number; readonly measures: ColumnMeasure[] }> {
  const [values] = await session.rows(
    distinctStatement(
      table.schema,
      table.name,
      columns.map(({ name }) => name),
    ),
    limitMs,
  );
  const rows = number(values?.[0]);
  const measures: ColumnMeasure[] = [];
  for (const [index, column] of columns.entries()) {
    const distinct = number(values?.[1 + index * 2]);
    const nulls = rows - number(values?.[2 + index * 2]);
    if (!isTemporal(column.type)) {
      measures.push({ column: column.name, type: column.type, distinct, nulls });
      continue;
    }
    const [counts] = await session.rows(
      unitStatement(table.schema, table.name, column.name, column.type),
      limitMs,
    );
    const units = Object.fromEntries(
      TEMPORAL_UNITS.filter((unit) => unit !== 'hour' || column.type !== 'date').map((unit, at) => [
        unit,
        number(counts?.[at]),
      ]),
    );
    measures.push({ column: column.name, type: column.type, distinct, nulls, units });
  }
  return { rows, measures };
}

/** The share of the rows in the largest partition of the keys. */
export async function largestShare(
  session: LakeSession,
  table: { readonly schema: string; readonly name: string },
  keys: readonly string[],
  rows: number,
  limitMs: number,
): Promise<number> {
  const [largest] = await session.rows(largestStatement(table.schema, table.name, keys), limitMs);
  return rows === 0 ? 0 : number(largest?.[0]) / rows;
}
