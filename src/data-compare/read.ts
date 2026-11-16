import type * as Duckdb from '@duckdb/node-api';
import { AantjeError } from '../errors';
import { gridColumns, toGridValue } from '../data/grid-values';
import { withLakes } from '../data/lakes';
import type { LakeSide } from '../data/lakes';
import { PREVIEW_LIMIT } from '../data/types';
import type { DataAccess, GridData, RowKind } from '../data/types';
import { isCast, isSafeType, planColumns, rowKindOf, summaryLine } from './model';
import type { ColumnMatch, ColumnPlan, CompareCounts, CompareSide, MatchedColumn } from './model';
import {
  castFailuresQuery,
  duplicateKeysQuery,
  keyedCountsQuery,
  keyedRowsQuery,
  wholeCountsQuery,
  wholeRowsQuery,
} from './sql';
import type { CompareQuery, TableAt } from './sql';

/** A side of a compare with what reading it needs: the access at its snapshot and the data path of its lake. */
export interface ReadSide extends CompareSide {
  readonly access: DataAccess;
  readonly dataPath: string | null;
}

export type CompareOutcome =
  | {
      readonly kind: 'compared';
      readonly plan: ColumnPlan;
      readonly counts: CompareCounts;
      readonly data: GridData;
    }
  /** The key repeats: how many keys have more than one row on each side. */
  | { readonly kind: 'duplicate-keys'; readonly source: number; readonly target: number }
  /** A key column of the target has values that do not cast to the type of the source. */
  | { readonly kind: 'key-not-cast'; readonly columns: readonly MatchedColumn[] };

const SOURCE = 'source';
const TARGET = 'target';

/**
 * Compares the rows of two tables in one read-only engine with both lakes, each at its snapshot (one lake when both
 * tables are in one connection). A column of the target whose type differs is compared after a cast to the type of the
 * source when all its values cast; otherwise it is left out (`plan.notCast`). With a key the rows are matched by it;
 * without one whole rows are compared. The counts are exact; the grid holds at most `PREVIEW_LIMIT` rows and never
 * splits the two versions of a row that differs.
 */
export async function compareTables(
  source: ReadSide,
  target: ReadSide,
  match: ColumnMatch,
  key: readonly string[],
  signal?: AbortSignal,
): Promise<CompareOutcome> {
  if (match.matched.length === 0) {
    throw new AantjeError('QUERY_FAILED', 'The two tables have no column in common to compare.');
  }
  const same = source.connectionId === target.connectionId;
  const sourceRef = { schema: source.schema, table: source.table };
  const targetRef = { schema: target.schema, table: target.table };
  const lakes: LakeSide[] = same
    ? [
        {
          access: source.access,
          alias: SOURCE,
          scope: source.dataPath,
          atSnapshot: true,
          tables: [sourceRef, targetRef],
        },
      ]
    : [
        {
          access: source.access,
          alias: SOURCE,
          scope: source.dataPath,
          atSnapshot: true,
          tables: [sourceRef],
        },
        {
          access: target.access,
          alias: TARGET,
          scope: target.dataPath,
          atSnapshot: true,
          tables: [targetRef],
        },
      ];
  const sourceAt = { alias: SOURCE, ...sourceRef };
  const targetAt = { alias: same ? SOURCE : TARGET, ...targetRef };
  return withLakes(lakes, signal, 'Comparing the tables', async (connection) => {
    const plan = await planOn(connection, targetAt, match);
    const keyNotCast = plan.notCast.filter((column) => key.includes(column.source));
    if (keyNotCast.length > 0) {
      return { kind: 'key-not-cast', columns: keyNotCast };
    }
    if (plan.compared.length === 0) {
      throw new AantjeError(
        'QUERY_FAILED',
        'No column of the target can be compared: the values of every shared column of another type do not cast to the type of the source.',
      );
    }
    const query: CompareQuery = { source: sourceAt, target: targetAt, columns: plan.compared, key };
    if (key.length > 0) {
      const [repeated] = (await connection.runAndReadAll(duplicateKeysQuery(query))).getRowsJson();
      const inSource = Number(repeated?.[0] ?? 0);
      const inTarget = Number(repeated?.[1] ?? 0);
      if (inSource > 0 || inTarget > 0) {
        return { kind: 'duplicate-keys', source: inSource, target: inTarget };
      }
    }
    return { kind: 'compared', plan, ...(await readDifferences(connection, query, targetRef)) };
  });
}

// The plan of the compare on the engine: a column whose type differs is compared when every value of the target casts.
async function planOn(
  connection: Duckdb.DuckDBConnection,
  target: TableAt,
  match: ColumnMatch,
): Promise<ColumnPlan> {
  // A type text that is not plain SQL is never cast: the column is left out without a query.
  const casts = match.matched.filter(
    (column) => isCast(column) && isSafeType(column.sourceType) && isSafeType(column.targetType),
  );
  const failures =
    casts.length === 0
      ? []
      : ((await connection.runAndReadAll(castFailuresQuery(target, casts))).getRowsJson()[0] ?? []);
  const casting = new Set(casts.filter((_, index) => Number(failures[index] ?? 0) === 0));
  return planColumns(match, (column) => casting.has(column));
}

// The exact counts, then the rows of the grid, one more than the limit.
async function readDifferences(
  connection: Duckdb.DuckDBConnection,
  query: CompareQuery,
  table: GridData['table'],
): Promise<{ counts: CompareCounts; data: GridData }> {
  const started = performance.now();
  const keyed = query.key.length > 0;
  const [counted] = (
    await connection.runAndReadAll(keyed ? keyedCountsQuery(query) : wholeCountsQuery(query))
  ).getRowsJson();
  const counts: CompareCounts = {
    onlyInSource: Number(counted?.[0] ?? 0),
    onlyInTarget: Number(counted?.[1] ?? 0),
    different: Number(counted?.[2] ?? 0),
    equal: Number(counted?.[3] ?? 0),
  };
  const reader = await connection.runAndReadAll(keyed ? keyedRowsQuery(query) : wholeRowsQuery(query));
  const read = reader.getRowsJson().map((row) => row.map(toGridValue));
  const more = read.length > PREVIEW_LIMIT;
  const kept = read.slice(0, PREVIEW_LIMIT).flatMap((row) => {
    const kind = rowKindOf(row[1], row[2]);
    return kind === undefined ? [] : [{ row, kind }];
  });
  // The two versions of a row that differs stay together.
  if (more && kept.at(-1)?.kind === 'update-before') kept.pop();
  const kinds: RowKind[] = kept.map(({ kind }) => kind);
  return {
    counts,
    data: {
      table,
      columns: gridColumns(reader),
      rows: kept.map(({ row }) => row),
      limit: PREVIEW_LIMIT,
      truncated: more,
      elapsedMs: Math.round(performance.now() - started),
      rowKinds: kinds,
      rowMode: 'compare',
      summary: summaryLine(counts, query.key, kept.length),
    },
  };
}
