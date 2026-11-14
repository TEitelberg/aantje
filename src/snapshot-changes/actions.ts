import type { SnapshotId } from '../catalog/model';
import type { TableRef } from '../data/types';
import type { Subject } from '../time-travel';
import { buildModel, detailOf, tableExistsAt } from './model';
import type { DetailTable, SnapshotDetail } from './model';
import type { SnapshotWindow } from './window';

/** The actions on a snapshot; the page names one by id, never a command. */
export type SnapshotActionId =
  'showCatalog' | 'showLatest' | 'rowsChanged' | 'compareSchema' | 'compareSnapshots' | 'query';

type Against = 'previous' | 'latest' | 'other';

export interface CompareTarget {
  readonly against: Against;
  readonly snapshot: SnapshotId;
}

/** Previous, latest and picked snapshots to compare with; `exists` drops those that lack the table. */
export function compareTargets(
  detail: SnapshotDetail,
  latest: SnapshotId,
  other: SnapshotId | undefined,
  exists: (snapshot: SnapshotId) => boolean = () => true,
): CompareTarget[] {
  return [
    ...(detail.previous === undefined ? [] : [{ against: 'previous', snapshot: detail.previous } as const]),
    ...(detail.hasLatest ? [{ against: 'latest', snapshot: latest } as const] : []),
    ...(other !== undefined && other !== detail.id ? [{ against: 'other', snapshot: other } as const] : []),
  ].filter((target) => exists(target.snapshot));
}

/** Whether the table exists and the catalog still knows its names. */
export const isReadable = (table: DetailTable): boolean =>
  table.exists && table.name !== null && table.schema !== null;

/** Needs an earlier snapshot to compare with and a data change. */
export const showsRows = (detail: SnapshotDetail, table: DetailTable): boolean =>
  isReadable(table) && table.dataChange && detail.previous !== undefined;

export type SnapshotPlan =
  | { readonly action: 'showCatalog'; readonly snapshot: SnapshotId }
  | { readonly action: 'showLatest' }
  | { readonly action: 'rowsChanged'; readonly snapshot: SnapshotId; readonly table: TableRef }
  | {
      readonly action: 'compareSchema';
      readonly subject: Subject;
      readonly from: SnapshotId;
      readonly to: SnapshotId;
    }
  | { readonly action: 'compareSnapshots'; readonly from: SnapshotId; readonly to: SnapshotId }
  | { readonly action: 'query'; readonly subject: Subject; readonly snapshot: SnapshotId };

/** What the webview asks for; the protocol guards have checked the shape. */
export interface SnapshotActionRequest {
  readonly action: SnapshotActionId;
  readonly snapshot?: number | undefined;
  readonly table?: number | undefined;
  readonly against?: Against | undefined;
  readonly other?: number | undefined;
}

const ordered = (a: SnapshotId, b: SnapshotId) => ({ from: Math.min(a, b), to: Math.max(a, b) });

/** The plan for a request, or undefined when the sent snapshots do not offer it. */
export function planSnapshotAction(
  data: Pick<SnapshotWindow, 'latest' | 'snapshots' | 'more'>,
  request: SnapshotActionRequest,
): SnapshotPlan | undefined {
  if (request.action === 'showLatest') {
    return { action: 'showLatest' };
  }
  const model = buildModel(data.snapshots, data.more);
  const detail = request.snapshot === undefined ? undefined : detailOf(model, data.latest, request.snapshot);
  if (!detail) {
    return undefined;
  }
  if (request.action === 'showCatalog') {
    return { action: 'showCatalog', snapshot: detail.id };
  }
  const table =
    request.table === undefined
      ? undefined
      : detail.tables.find((candidate) => candidate.tableId === request.table);
  const other =
    request.against === 'other' && data.snapshots.some(({ id }) => id === request.other)
      ? request.other
      : undefined;
  const targetOf = (exists?: (snapshot: SnapshotId) => boolean) =>
    compareTargets(detail, data.latest, other, exists).find(({ against }) => against === request.against);
  if (request.action === 'compareSnapshots') {
    const target = targetOf();
    return target && { action: 'compareSnapshots', ...ordered(detail.id, target.snapshot) };
  }
  if (!table || !isReadable(table) || table.schema === null || table.name === null) {
    return undefined;
  }
  const subject: Subject = { kind: 'table', id: table.tableId, schemaName: table.schema, name: table.name };
  switch (request.action) {
    case 'rowsChanged':
      return showsRows(detail, table)
        ? { action: 'rowsChanged', snapshot: detail.id, table: { schema: table.schema, table: table.name } }
        : undefined;
    case 'compareSchema': {
      const target = targetOf((snapshot) => tableExistsAt(model, table.key, snapshot));
      return target && { action: 'compareSchema', subject, ...ordered(detail.id, target.snapshot) };
    }
    case 'query':
      return { action: 'query', subject, snapshot: detail.id };
  }
}
