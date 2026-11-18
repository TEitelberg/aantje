import type { ColumnSummary } from '../grid/column-summary';
import { summarize } from '../grid/summary-queries';
import { newestSnapshotQuery } from './attach';
import { withWholeRelation } from './engine';
import type { DataAccess, TableRef } from './types';

/**
 * The summary of the columns of a table or view at the snapshot of `access`, for the pane of the data preview: SUMMARIZE
 * and its queries over all rows, in the read-only engine of the preview with its checks. A read of the newest snapshot
 * names the snapshot it read.
 */
export function summarizeRelation(
  access: DataAccess,
  table: TableRef,
  signal?: AbortSignal,
): Promise<ColumnSummary> {
  return withWholeRelation(access, table, signal, async (connection, relation) => {
    const run = async (sql: string): Promise<readonly (readonly unknown[])[]> =>
      (await connection.runAndReadAll(sql)).getRowsJson();
    const newest = access.snapshot ?? (await run(newestSnapshotQuery()))[0]?.[0];
    const found = await summarize(run, `SELECT * FROM ${relation}`);
    return {
      cover: {
        kind: 'table',
        rows: found.rows,
        ...(newest === null || newest === undefined ? {} : { snapshot: Number(newest) }),
        ...(found.sample === undefined ? {} : { sample: found.sample }),
      },
      columns: found.columns,
    };
  });
}
