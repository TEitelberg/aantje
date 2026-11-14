import type { SnapshotId } from '../catalog/model';
import type { Subject } from '../time-travel';
import { schemaHistoryDetailOf } from './model';
import type { SchemaHistoryDetail, SchemaHistoryData } from './model';

// The page names an action by id, never a command.
export type SchemaHistoryActionId = 'showCatalog' | 'compareSchema' | 'query' | 'scriptAlter';

type Against = 'previous' | 'latest';

export interface SchemaHistoryCompareTarget {
  readonly against: Against;
  readonly snapshot: SnapshotId;
}

/** The previous and the newest schema version to compare with, where the table exists. */
export function schemaHistoryCompareTargets(
  detail: SchemaHistoryDetail,
  latest: SnapshotId,
): SchemaHistoryCompareTarget[] {
  return [
    ...(detail.previous === null ? [] : [{ against: 'previous', snapshot: detail.previous } as const]),
    ...(detail.hasLatest ? [{ against: 'latest', snapshot: latest } as const] : []),
  ];
}

/** What the webview asks for; the protocol guards have checked the shape. */
export interface SchemaHistoryActionRequest {
  readonly action: SchemaHistoryActionId;
  readonly snapshot?: number | undefined;
  readonly against?: Against | undefined;
}

export type SchemaHistoryPlan =
  | { readonly action: 'showCatalog'; readonly snapshot: SnapshotId }
  | {
      readonly action: 'compareSchema';
      readonly subject: Subject;
      readonly from: SnapshotId;
      readonly to: SnapshotId;
    }
  | { readonly action: 'query'; readonly subject: Subject; readonly snapshot: SnapshotId }
  | { readonly action: 'scriptAlter'; readonly subject: Subject };

/** The plan for a request, or undefined when the sent data does not offer it. */
export function planSchemaHistoryAction(
  data: SchemaHistoryData,
  request: SchemaHistoryActionRequest,
): SchemaHistoryPlan | undefined {
  const subject: Subject | undefined =
    data.schema === null
      ? undefined
      : { kind: 'table', id: data.tableId, schemaName: data.schema, name: data.name };
  if (request.action === 'scriptAlter') {
    return subject && data.exists ? { action: 'scriptAlter', subject } : undefined;
  }
  const detail = request.snapshot === undefined ? undefined : schemaHistoryDetailOf(data, request.snapshot);
  if (!detail) {
    return undefined;
  }
  switch (request.action) {
    case 'showCatalog':
      return { action: 'showCatalog', snapshot: detail.snapshot.id };
    case 'query':
      return subject && detail.snapshot.exists
        ? { action: 'query', subject, snapshot: detail.snapshot.id }
        : undefined;
    case 'compareSchema': {
      const target = schemaHistoryCompareTargets(detail, data.latest).find(
        ({ against }) => against === request.against,
      );
      return (
        subject &&
        target && {
          action: 'compareSchema',
          subject,
          from: Math.min(detail.snapshot.id, target.snapshot),
          to: Math.max(detail.snapshot.id, target.snapshot),
        }
      );
    }
  }
}
