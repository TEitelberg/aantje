import { createTableNamed, quoteIdentifier } from '../catalog/ddl';
import type { SnapshotId } from '../catalog/model';
import type { SchemaDocument } from '../compare';
import { commentText } from '../ddl-script/names';
import { commentStatement } from '../ddl-script/statements';
import type { TableState } from '../ddl-script/table-state';
import {
  compareTables,
  countsText,
  differenceCounts,
  hasDifferences,
  mayHideRename,
  partitionText,
  RENAME_NOTE,
  sortText,
} from './model';
import type { TableDifferences } from './model';

/** One side of a comparison: a connected catalog at the snapshot that its tree shows. */
export interface Side {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly snapshot: SnapshotId;
  /** The tree shows a chosen snapshot instead of following the newest; a script says that it acts on the newest. */
  readonly pinned: boolean;
}

export interface TableSide extends Side {
  readonly table: TableState;
}

/** `lake · staging.orders`: the connection and the object of a side, on one line. */
export const sideName = (side: Side, object: string): string =>
  `${commentText(side.connectionName)} · ${commentText(object)}`;

/** `lake · staging.orders @56`: a side as titles name it. */
const sideTitle = (side: Side, object: string): string => `${sideName(side, object)} @${side.snapshot}`;

export interface TablesComparison {
  readonly differences: TableDifferences;
  /** `lake · staging.orders @56 ↔ lake · gold.orders @12`. */
  readonly title: string;
  /** The information message: what differs, by side (source and target), or that nothing does. */
  readonly summary: string;
  /** The DDL of both tables for the diff editor, also when nothing differs. */
  readonly documents: { readonly left: SchemaDocument; readonly right: SchemaDocument };
}

/**
 * The DDL of a table with its partitioning, sort order and comments, as the diff editor shows it; it is not run. The
 * names leave the schema out (the title of the diff names both sides), so that two equal tables show equal texts.
 */
function tableDocument(table: TableState): string {
  const name = quoteIdentifier(table.name);
  const partitioning = partitionText(table.partitioning);
  const sortOrder = sortText(table.sortOrder);
  return [
    createTableNamed([table.name], table.columns),
    ...(partitioning === null ? [] : [`ALTER TABLE ${name} SET PARTITIONED BY (${partitioning});`]),
    ...(sortOrder === null ? [] : [`ALTER TABLE ${name} SET SORTED BY (${sortOrder});`]),
    ...(table.comment === null ? [] : [commentStatement('TABLE', [table.name], table.comment)]),
    ...table.columns.flatMap(({ name: column, comment }) =>
      comment === null ? [] : [commentStatement('COLUMN', [table.name, column], comment)],
    ),
  ].join('\n');
}

const tableName = ({ table }: TableSide): string => `${table.schemaName}.${table.name}`;

/** Two tables, matched column by column by name: the counts by side and the two documents. */
export function compareTwoTables(left: TableSide, right: TableSide): TablesComparison {
  const differences = compareTables(left.table, right.table);
  const differs = hasDifferences(differences);
  const document = (side: TableSide): SchemaDocument => ({
    key: { connectionId: side.connectionId, tableId: side.table.id, snapshot: side.snapshot, full: true },
    text: tableDocument(side.table),
  });
  return {
    differences,
    title: `${sideTitle(left, tableName(left))} ↔ ${sideTitle(right, tableName(right))}`,
    summary: differs
      ? `The tables differ: ${countsText(differenceCounts(differences))}.${mayHideRename(differences) ? ` ${RENAME_NOTE}` : ''}`
      : 'The two tables do not differ.',
    documents: { left: document(left), right: document(right) },
  };
}
