// The script of the sort-order tip. Names are quoted identifiers and never appear in a comment.
import { quoteIdentifier } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import { HEADER, tableScript } from '../maintenance/scripts';
import type { DeletedFiles } from '../catalog/model';
import { count, formatBytes } from '../shell/model';

const relation = (schema: string, table: string): string =>
  `${LAKE}.${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

/**
 * Sets the sort order and writes the rows that are there again in that order: DuckLake applies a sort order only to
 * what it writes from then on. The INSERT reads the snapshot that the transaction starts from, so it writes back
 * exactly the rows that the DELETE removes, whatever was committed before the script ran (checked on DuckDB 2.0).
 */
export function sortScript(
  schema: string,
  table: string,
  column: string,
  figures: { readonly rows: number; readonly bytes: number; readonly replaces: boolean },
): string {
  const name = relation(schema, table);
  return [
    `-- Sort order: the table is written sorted by one column, so that a filter on that column can skip files and row groups.`,
    `-- DuckLake applies a sort order to what it writes from now on. The transaction writes the rows that are there again, in that order:`,
    `-- ${count(figures.rows)} rows, ${formatBytes(figures.bytes)}. The files they are in now stay until Expire Snapshots and Clean Up Old Files remove them.`,
    ...(figures.replaces ? ['-- The new sort order replaces the one the table has.'] : []),
    `-- Run it in a read/write SQL session.`,
    `ALTER TABLE ${name} SET SORTED BY (${quoteIdentifier(column)});`,
    'BEGIN TRANSACTION;',
    `SET VARIABLE aantje_snapshot = (SELECT id FROM ${LAKE}.current_snapshot());`,
    `DELETE FROM ${name};`,
    `INSERT INTO ${name} SELECT * FROM ${name} AT (VERSION => getvariable('aantje_snapshot'));`,
    'COMMIT;',
    'RESET VARIABLE aantje_snapshot;',
    '',
  ].join('\n');
}

/** The maintenance a table needs, as the Maintenance Advisor writes it. */
export type TableMaintenanceKind = 'merge' | 'rewrite' | 'flush';

/** The maintenance script of one table: the steps in the Advisor's order, under the maintenance header. */
export function maintenanceScript(
  schema: string,
  table: string,
  steps: readonly { readonly kind: TableMaintenanceKind; readonly deleted?: DeletedFiles | null }[],
): string {
  return [
    HEADER,
    ...steps.flatMap(({ kind, deleted }) => ['', ...tableScript(kind, schema, table, deleted)]),
    '',
  ].join('\n');
}
