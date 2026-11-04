import type { SnapshotReportPlan as ReportPlan } from '../snapshot-report/actions';
import { growthModelOf, growthTableChoices } from './model';
import type { GrowthData } from './model';

// The page names an action by id, never a command.
type ActionId = 'showCatalog' | 'query';

/** What the webview asks for; the protocol guards have checked the shape. */
export interface GrowthActionRequest {
  readonly action: ActionId;
  readonly snapshot?: number | undefined;
  /** Only `query` has a table. */
  readonly table?: number | undefined;
}

type Plan = Extract<ReportPlan, { readonly action: 'showCatalog' | 'query' }>;

/** The plan for a request, or undefined for an unknown snapshot or table. */
export function planGrowthAction(data: GrowthData, request: GrowthActionRequest): Plan | undefined {
  const snapshot = data.snapshots.find(({ id }) => id === request.snapshot)?.id;
  if (snapshot === undefined) {
    return undefined;
  }
  if (request.action === 'showCatalog') {
    return request.table === undefined ? { action: 'showCatalog', snapshot } : undefined;
  }
  const table = growthTableChoices(data, growthModelOf(data)).find(({ id }) => id === request.table);
  return table
    ? {
        action: 'query',
        subject: { kind: 'table', id: table.id, schemaName: table.schema, name: table.name },
        snapshot,
      }
    : undefined;
}
