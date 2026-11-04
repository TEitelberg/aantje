import type { SnapshotId } from '../catalog/model';
import type { NodeRef } from '../tree/refs';

/** The table that Show Statistics acts on: a table node, or the Statistics folder of a table. */
export interface StatisticsTarget {
  readonly connectionId: string;
  readonly tableId: number;
  readonly schema: string;
  readonly table: string;
}

export function statisticsTargetOf(ref: NodeRef): StatisticsTarget | undefined {
  if (ref.kind === 'table' || (ref.kind === 'folder' && ref.folder === 'statistics')) {
    return {
      connectionId: ref.connectionId,
      tableId: ref.table.id,
      schema: ref.schema.name,
      table: ref.table.name,
    };
  }
  return undefined;
}

/** Identifies the statistics report of a table at a snapshot. JSON, so that no combination of ids can imitate another key. */
export function statisticsKey({ connectionId, tableId }: StatisticsTarget, snapshot: SnapshotId): string {
  return JSON.stringify([connectionId, tableId, snapshot]);
}

/** `Statistics of shop.events @56 · Lake`: the names are the ones the tree shows at that snapshot. */
export function statisticsTitle(
  { schema, table }: StatisticsTarget,
  connectionName: string,
  snapshot: SnapshotId,
): string {
  return `Statistics of ${schema}.${table} @${snapshot} · ${connectionName}`;
}
