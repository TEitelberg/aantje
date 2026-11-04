import type { SnapshotId } from '../catalog/model';
import type { NodeRef } from '../tree/refs';
import type { TableRef } from './types';

/** A table or view that the data commands (Top 1000 rows, notebook) act on. */
export interface Relation {
  readonly connectionId: string;
  readonly kind: 'table' | 'view';
  readonly table: TableRef;
}

/** Key of the grid panel of a relation at a snapshot; JSON, so no combination of names imitates another key. */
export function gridKey(relation: Relation, snapshot: SnapshotId | undefined): string {
  const { connectionId, table } = relation;
  return JSON.stringify([connectionId, table.schema, table.table, snapshot ?? 'latest']);
}

/**
 * Title of the grid panel; connection and snapshot tell apart same-named tables (a tree following the latest snapshot
 * passes the concrete id).
 */
export function gridTitle(
  relation: Relation,
  connectionName: string,
  snapshot: SnapshotId | undefined,
  limit: number,
): string {
  const { schema, table } = relation.table;
  return `${schema}.${table} (top ${limit}) · ${connectionName} @${snapshot ?? 'latest'}`;
}

/** Key of the grid panel of a table's changes; the range is part of it, so every range has its own panel. */
export function changesKey(
  relation: Relation,
  range: { readonly from: SnapshotId; readonly to: SnapshotId },
): string {
  const { connectionId, table } = relation;
  return JSON.stringify([connectionId, table.schema, table.table, 'changes', range.from, range.to]);
}

/** E.g. `shop.customers changes @16 → @18 · Lake`: the changes after the first snapshot up to the second. */
export function changesTitle(
  relation: Relation,
  connectionName: string,
  range: { readonly from: SnapshotId; readonly to: SnapshotId },
): string {
  const { schema, table } = relation.table;
  return `${schema}.${table} changes @${range.from} → @${range.to} · ${connectionName}`;
}

/** The table or view a tree node stands for; undefined for other nodes. */
export function relationOf(ref: NodeRef): Relation | undefined {
  switch (ref.kind) {
    case 'table':
      return {
        connectionId: ref.connectionId,
        kind: 'table',
        table: { schema: ref.schema.name, table: ref.table.name },
      };
    case 'view':
      return {
        connectionId: ref.connectionId,
        kind: 'view',
        table: { schema: ref.schema.name, table: ref.view.name },
      };
    default:
      return undefined;
  }
}
