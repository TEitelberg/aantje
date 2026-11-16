import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { PREVIEW_LIMIT } from '../data/types';
import { DIFFERENCE, isCast } from './model';
import type { MatchedColumn } from './model';

// The queries of a compare. Every name is quoted; the only other text in them is the SQL type of a column, which
// comes from the catalog through `sqlType` (quoted field names) and is checked by a cast in an empty engine first.

/** A table in the engine of the compare. */
export interface TableAt {
  /** The alias of its lake in the engine. */
  readonly alias: string;
  readonly schema: string;
  readonly table: string;
}

export const tableName = (table: TableAt): string =>
  `${table.alias}.${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`;

/**
 * For each column of the target whose type differs: how many of its values are not NULL but do not cast to the type of
 * the source. DuckDB binds a cast between any two types (through text) and fails only on a value, so whether a column
 * casts is a question of its values.
 */
export function castFailuresQuery(target: TableAt, columns: readonly MatchedColumn[]): string {
  const failures = columns.map((column) => {
    const value = quoteIdentifier(column.target);
    return `count(*) FILTER (WHERE ${value} IS NOT NULL AND TRY_CAST(${value} AS ${column.sourceType}) IS NULL)`;
  });
  return `SELECT ${failures.join(', ')} FROM ${tableName(target)}`;
}

/** What a compare reads: the two tables, the compared columns (source order) and the key (source names). */
export interface CompareQuery {
  readonly source: TableAt;
  readonly target: TableAt;
  readonly columns: readonly MatchedColumn[];
  readonly key: readonly string[];
}

const sourceColumn = (index: number): string => `s${index}`;
const targetColumn = (index: number): string => `t${index}`;

// The two sides with their columns renamed by position; the target's are cast to the type of the source.
function sides({ source, target, columns }: CompareQuery): string {
  const sourceList = columns.map(
    (column, index) => `${quoteIdentifier(column.source)} AS ${sourceColumn(index)}`,
  );
  const targetList = columns.map(
    (column, index) =>
      `${isCast(column) ? `TRY_CAST(${quoteIdentifier(column.target)} AS ${column.sourceType})` : quoteIdentifier(column.target)} AS ${targetColumn(index)}`,
  );
  return `s AS (SELECT TRUE AS in_s, ${sourceList.join(', ')} FROM ${tableName(source)}), t AS (SELECT TRUE AS in_t, ${targetList.join(', ')} FROM ${tableName(target)})`;
}

const keyIndexes = (query: CompareQuery): number[] =>
  query.key.map((name) => query.columns.findIndex((column) => column.source === name));

/** The keys that more than one row has, on each side: a key must be unique to match rows one to one. */
export function duplicateKeysQuery(query: CompareQuery): string {
  const repeated = (side: string, column: (index: number) => string): string => {
    const keys = keyIndexes(query).map(column).join(', ');
    return `(SELECT count(*) FROM (SELECT ${keys} FROM ${side} GROUP BY ${keys} HAVING count(*) > 1))`;
  };
  return `WITH ${sides(query)} SELECT ${repeated('s', sourceColumn)}, ${repeated('t', targetColumn)}`;
}

// The kind of each joined row: 1 only in the source, 2 only in the target, 3 differs, 0 equal. NULL keys match each
// other and two NULLs are equal.
function keyed(query: CompareQuery): string {
  const keys = new Set(keyIndexes(query));
  const on = [...keys].map(
    (index) => `s.${sourceColumn(index)} IS NOT DISTINCT FROM t.${targetColumn(index)}`,
  );
  const others = query.columns
    .map((_, index) => index)
    .filter((index) => !keys.has(index))
    .map((index) => `${sourceColumn(index)} IS DISTINCT FROM ${targetColumn(index)}`);
  const differs = others.length === 0 ? '' : ` WHEN ${others.join(' OR ')} THEN 3`;
  return `WITH ${sides(query)}, j AS (SELECT *, CASE WHEN in_t IS NULL THEN 1 WHEN in_s IS NULL THEN 2${differs} ELSE 0 END AS kind FROM s FULL OUTER JOIN t ON ${on.join(' AND ')})`;
}

/** The counts of a compare with a key: only in the source, only in the target, different, equal. */
export function keyedCountsQuery(query: CompareQuery): string {
  return `${keyed(query)} SELECT count(*) FILTER (WHERE kind = 1), count(*) FILTER (WHERE kind = 2), count(*) FILTER (WHERE kind = 3), count(*) FILTER (WHERE kind = 0) FROM j`;
}

// The rows of the grid: the number of the difference, what it is, the side, and the values; one row more than the limit.
function gridRows(
  numbered: string,
  parts: readonly {
    kind: number;
    part: number;
    difference: string;
    side: string;
    column: (index: number) => string;
  }[],
  query: CompareQuery,
): string {
  const values = (column: (index: number) => string): string =>
    query.columns.map((_, index) => column(index)).join(', ');
  const selects = parts.map(
    ({ kind, part, difference, side, column }) =>
      `SELECT n, ${part} AS part, ${quoteLiteral(difference)} AS difference, ${quoteLiteral(side)} AS side, ${values(column)} FROM d WHERE kind = ${kind}`,
  );
  const names = query.columns.map(
    (column, index) => `${sourceColumn(index)} AS ${quoteIdentifier(column.source)}`,
  );
  return `${numbered} SELECT n AS "#", difference, side, ${names.join(', ')} FROM (${selects.join(' UNION ALL ')}) ORDER BY n, part LIMIT ${PREVIEW_LIMIT + 1}`;
}

/** The rows of a compare with a key, ordered by the key; of a row that differs the target's version comes first. */
export function keyedRowsQuery(query: CompareQuery): string {
  const order = keyIndexes(query).map((index) => `coalesce(${sourceColumn(index)}, ${targetColumn(index)})`);
  const numbered = `${keyed(query)}, d AS (SELECT row_number() OVER (ORDER BY ${order.join(', ')}) AS n, * FROM j WHERE kind <> 0)`;
  return gridRows(
    numbered,
    [
      { kind: 1, part: 0, difference: DIFFERENCE.onlyInSource, side: 'source', column: sourceColumn },
      { kind: 2, part: 0, difference: DIFFERENCE.onlyInTarget, side: 'target', column: targetColumn },
      { kind: 3, part: 0, difference: DIFFERENCE.different, side: 'target', column: targetColumn },
      { kind: 3, part: 1, difference: DIFFERENCE.different, side: 'source', column: sourceColumn },
    ],
    query,
  );
}

// Without a key every row is a whole: what one side has more often than the other (EXCEPT ALL, duplicates count). The
// target's columns take the names of the source's, so that both sides are one shape.
function whole(query: CompareQuery): string {
  const asSource = query.columns
    .map((_, index) => `${targetColumn(index)} AS ${sourceColumn(index)}`)
    .join(', ');
  const sourceColumns = query.columns.map((_, index) => sourceColumn(index)).join(', ');
  return `WITH ${sides(query)}, sv AS (SELECT ${sourceColumns} FROM s), tv AS (SELECT ${asSource} FROM t), so AS (SELECT * FROM sv EXCEPT ALL SELECT * FROM tv), tn AS (SELECT * FROM tv EXCEPT ALL SELECT * FROM sv)`;
}

/** The counts of a compare of whole rows: only in the source, only in the target, 0 different, equal. */
export function wholeCountsQuery(query: CompareQuery): string {
  return `${whole(query)} SELECT (SELECT count(*) FROM so), (SELECT count(*) FROM tn), 0, (SELECT count(*) FROM sv) - (SELECT count(*) FROM so)`;
}

/** The rows of a compare of whole rows, ordered by all columns. */
export function wholeRowsQuery(query: CompareQuery): string {
  const all = query.columns.map((_, index) => sourceColumn(index));
  const numbered = `${whole(query)}, x AS (SELECT 1 AS kind, * FROM so UNION ALL SELECT 2 AS kind, * FROM tn), d AS (SELECT row_number() OVER (ORDER BY ${[...all, 'kind'].join(', ')}) AS n, * FROM x)`;
  return gridRows(
    numbered,
    [
      { kind: 1, part: 0, difference: DIFFERENCE.onlyInSource, side: 'source', column: sourceColumn },
      { kind: 2, part: 0, difference: DIFFERENCE.onlyInTarget, side: 'target', column: sourceColumn },
    ],
    query,
  );
}
