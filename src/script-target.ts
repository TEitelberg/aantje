import type { MaintenanceKind } from './maintenance';
import type { NodeRef } from './tree/refs';

/** A table as the reports name it; a report may add statistics, which the script templates read from the node. */
export interface ReportTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  readonly rows?: number;
  readonly files?: number;
  readonly sizeBytes?: number;
}

/** The node a maintenance script targets: the plan's table, or the lake when it has none. */
export function scriptTarget(
  connectionId: string,
  plan: { readonly kind: MaintenanceKind; readonly table?: ReportTable },
): { readonly kind: MaintenanceKind; readonly ref: NodeRef } {
  const { table } = plan;
  if (!table) {
    return { kind: plan.kind, ref: { kind: 'connection', connectionId } };
  }
  return {
    kind: plan.kind,
    ref: {
      kind: 'table',
      connectionId,
      schema: { id: table.schemaId, name: table.schema, comment: null },
      table: {
        id: table.id,
        schemaId: table.schemaId,
        name: table.name,
        comment: null,
        stats: { rows: table.rows ?? 0, files: table.files ?? 0, sizeBytes: table.sizeBytes ?? 0 },
      },
    },
  };
}
