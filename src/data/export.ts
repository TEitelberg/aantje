import { scrubbed } from '../duckdb/messages';
import { AantjeError } from '../errors';
import { copyStatement, fileWriteFailure, needsColumns } from '../export/copy';
import type { ExportTarget } from '../export/copy';
import { withWholeRelation } from './engine';
import { secretsOf } from './errors';
import { gridColumns } from './grid-values';
import type { DataAccess, TableRef } from './types';

/**
 * Export: writes all rows of a table or view at the snapshot of `access` to the file of the target, in the read-only
 * engine of the data preview with its checks; the rows written. The file is written by the engine; the lake stays as it
 * was. CSV for Excel binds the relation first (`LIMIT 0`) to find its text columns.
 */
export function exportRelation(
  access: DataAccess,
  table: TableRef,
  target: ExportTarget,
  signal?: AbortSignal,
): Promise<number> {
  return withWholeRelation(access, table, signal, async (connection, relation) => {
    const query = `SELECT * FROM ${relation}`;
    const columns = needsColumns(target)
      ? gridColumns(await connection.runAndReadAll(`${query} LIMIT 0`))
      : [];
    try {
      const result = await connection.runAndReadAll(copyStatement(query, target, columns));
      return Number(result.rowsChanged);
    } catch (cause) {
      // A file that cannot be written is no failure to read the lake, which the errors of a read would suggest.
      const { line } = scrubbed(cause, secretsOf(access));
      const failure = fileWriteFailure(line, target.path);
      throw failure ? new AantjeError('QUERY_FAILED', failure, { cause: new Error(line) }) : cause;
    }
  });
}
