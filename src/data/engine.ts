import type * as Duckdb from '@duckdb/node-api';
import { AantjeError } from '../errors';
import type { SnapshotId } from '../catalog/model';
import {
  changeColumnsQuery,
  changeCountsQuery,
  changesQuery,
  columnsQuery,
  dataPathQuery,
  newestSnapshotQuery,
  nextSnapshotQuery,
  previewQuery,
  setupStatements,
} from './attach';
import { rowKindOf, summariseChanges, summaryLine } from './changes';
import type { ChangesSummary } from './changes';
import { loadEngine } from '../duckdb/engine';
import { dataError, MISSING_LOCAL_FILE, MISSING_OBJECT, secretsOf } from './errors';
import type { CatalogFacts } from './errors';
import { gridColumns, toGridValue, typeOf } from './grid-values';
import { maskSecrets } from '../secrets';
import { withOpenLake } from './open-lake';
import { CHANGE_COLUMNS, PREVIEW_LIMIT } from './types';
import { guardRelation } from './guard';
import type { GuardOptions } from './guard';
import type { DataAccess, GridData, RelationColumn, TableRef } from './types';

/**
 * Reads a table's first rows in a private in-memory DuckDB with the DuckLake attached read-only; `signal` covers the
 * call.
 */
export function previewTable(access: DataAccess, table: TableRef, signal?: AbortSignal): Promise<GridData> {
  return withLake(access, table, signal, async (connection) => {
    const started = performance.now();
    const reader = await connection.runAndReadAll(previewQuery(table));
    const all = reader.getRowsJson().map((row) => row.map(toGridValue));
    return {
      table,
      columns: gridColumns(reader),
      rows: all.slice(0, PREVIEW_LIMIT),
      limit: PREVIEW_LIMIT,
      truncated: all.length > PREVIEW_LIMIT,
      elapsedMs: Math.round(performance.now() - started),
    };
  });
}

export interface ChangesResult {
  /** The first `PREVIEW_LIMIT` change rows as a grid with row kinds and a summary line. */
  readonly data: GridData;
  /** Counted over all changes of the range, not only the rows of `data`. */
  readonly summary: ChangesSummary;
}

/**
 * Rows a table gained, lost or changed after snapshot `from` up to `to` (inclusive), via `table_changes`; an expired
 * `from` starts at the next existing snapshot, no-op updates are dropped.
 */
export async function readChanges(
  access: DataAccess,
  table: TableRef,
  range: { readonly from: SnapshotId; readonly to: SnapshotId },
  signal?: AbortSignal,
): Promise<ChangesResult> {
  const { from, to } = range;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) {
    throw new AantjeError(
      'QUERY_FAILED',
      `The changes of "${table.schema}.${table.table}" need two snapshots, the second after the first (got @${from} and @${to}).`,
    );
  }
  return withLake(
    access,
    table,
    signal,
    async (connection) => {
      const started = performance.now();
      // table_changes is inclusive and refuses an expired start, so begin at the first existing snapshot after `from`.
      // A missing `to` still gets the error that names it.
      const next = (await connection.runAndReadAll(nextSnapshotQuery(from))).getRowsJson()[0]?.[0];
      const start = next === null || next === undefined ? to : Number(next);
      const columns = (await connection.runAndReadAll(changeColumnsQuery(table, start, to))).columnNames();
      const reader = await connection.runAndReadAll(changesQuery(table, start, to, columns));
      const read = reader.getRowsJson().map((row) => row.map(toGridValue));
      const more = read.length > PREVIEW_LIMIT;
      // A row of a change type this version does not know is left out; the summary counts them over the range.
      const known = read
        .flatMap((row) => {
          const kind = rowKindOf(row[CHANGE_COLUMNS - 1]);
          return kind === undefined ? [] : [{ row, kind }];
        })
        .slice(0, PREVIEW_LIMIT);
      if (more && known.at(-1)?.kind === 'update-before') {
        known.pop();
      }
      const rows = known.map(({ row }) => row);
      const groups = (
        await connection.runAndReadAll(changeCountsQuery(table, start, to, columns))
      ).getRowsJson();
      const summary = summariseChanges(
        groups.map(([snapshot, changeType, count]) => ({
          snapshot: Number(snapshot),
          changeType: typeof changeType === 'string' ? changeType : '',
          rows: Number(count),
        })),
        range,
        more,
      );
      return {
        data: {
          table,
          columns: gridColumns(reader),
          rows,
          limit: PREVIEW_LIMIT,
          truncated: more,
          elapsedMs: Math.round(performance.now() - started),
          rowKinds: known.map(({ kind }) => kind),
          summary: summaryLine(summary, rows.length),
        },
        summary,
      };
    },
    // The read uses table_changes over the range, which also reads data and delete files of older snapshots.
    { range: { from, to } },
  );
}

/**
 * The columns of a table or view as DuckDB resolves them. Binding a view's SQL opens files of table functions such as
 * `read_csv`, so call it for a view only after the user trusted the connection.
 */
export function describeRelation(
  access: DataAccess,
  table: TableRef,
  signal?: AbortSignal,
): Promise<readonly RelationColumn[]> {
  return withLake(access, table, signal, async (connection) => {
    // Types come from the result as in the grid: DESCRIBE quotes struct field names only where required, so the tree
    // and grid header would differ. DESCRIBE supplies only nullability (its third column, 'YES' / 'NO').
    const result = await connection.runAndReadAll(columnsQuery(table));
    const described = (await connection.runAndReadAll(`DESCRIBE ${columnsQuery(table)}`)).getRowsJson();
    return result.columnNames().map((name, index): RelationColumn => ({
      name,
      type: typeOf(result, index),
      nullable: (described[index]?.[2] ?? 'YES') !== 'NO',
    }));
  });
}

/**
 * Runs the checks that come before a read and reads nothing: for code that hands a relation to an engine of the user
 * (the notebook) and must not do so for one that aantje refuses to read.
 */
export function checkRelation(access: DataAccess, table: TableRef, signal?: AbortSignal): Promise<void> {
  return withLake(access, table, signal, () => Promise.resolve());
}

async function withLake<T>(
  access: DataAccess,
  table: TableRef,
  signal: AbortSignal | undefined,
  query: (connection: Duckdb.DuckDBConnection) => Promise<T>,
  guard: Pick<GuardOptions, 'range'> = {},
): Promise<T> {
  const subject = `"${table.schema}.${table.table}"`;
  return withOpenLake({
    engine: await loadEngine(),
    access,
    signal,
    setup: setupStatements(access),
    cancelledText: `Reading ${subject} was cancelled.`,
    activity: `Reading ${subject}`,
    use: async ({ connection }) => {
      // One transaction for the checks and the read: both see the snapshot that the first statement pins, so an author
      // of the catalog cannot swap a view or a file path between them (on PostgreSQL, where the writer is not locked out).
      await connection.run('BEGIN TRANSACTION');
      try {
        // Before the first statement that binds the relation: a view's SQL runs with the user's rights, and a file path
        // is an address. Trust follows what is read at this snapshot; an untrusted view is refused for the caller to ask.
        await guardRelation(connection, table, access.snapshot, {
          trusted: access.viewsTrusted,
          range: guard.range,
          storage: access.storage?.config,
        });
        return await query(connection);
      } finally {
        // Also after a failure, which leaves the transaction aborted; the error handler asks the connection more.
        await connection.run('ROLLBACK').catch(() => undefined);
      }
    },
    fail: async (cause, phase, connection) => {
      if (cause instanceof AantjeError) {
        return cause;
      }
      // A gone file reads differently at an older snapshot, so ask for the newest.
      const facts =
        connection &&
        phase === 'query' &&
        (MISSING_OBJECT.test(String(cause)) || MISSING_LOCAL_FILE.test(String(cause)))
          ? await catalogFacts(connection, access)
          : {};
      return dataError(cause, phase, access, table, facts);
    },
  });
}

/** Facts for error messages only; what the catalog cannot answer is left out. Exported for its test. */
export async function catalogFacts(
  connection: Pick<Duckdb.DuckDBConnection, 'runAndReadAll'>,
  access: DataAccess,
): Promise<CatalogFacts> {
  const first = async (sql: string): Promise<unknown> => {
    try {
      return (await connection.runAndReadAll(sql)).getRowsJson()[0]?.[0];
    } catch {
      return undefined;
    }
  };
  const newest = access.snapshot === undefined ? undefined : await first(newestSnapshotQuery());
  const dataPath = await first(dataPathQuery());
  return {
    ...(newest === null || newest === undefined ? {} : { newest: Number(newest) }),
    ...(typeof dataPath === 'string' ? { dataPath: maskSecrets(dataPath, secretsOf(access)) } : {}),
  };
}
