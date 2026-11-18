import type { SnapshotId } from '../catalog/model';
import type { Subject } from '../time-travel';
import { comparePoints } from './model';
import type { SchemaHistoryData } from './model';

// The page names an action by id, never a command.
export type SchemaHistoryActionId = 'compareSchema' | 'scriptAlter';

/** What the webview asks for; the protocol guards have checked the shape. */
export interface SchemaHistoryActionRequest {
  readonly action: SchemaHistoryActionId;
  /** The two snapshots of the comparison; Compare Schema only. */
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

export type SchemaHistoryPlan =
  | {
      readonly action: 'compareSchema';
      readonly subject: Subject;
      readonly from: SnapshotId;
      readonly to: SnapshotId;
    }
  | { readonly action: 'scriptAlter'; readonly subject: Subject };

/** Whether the page offers Compare Schema: two different snapshots of the comparison at which the table exists. */
export function canCompareSchema(data: SchemaHistoryData, from: SnapshotId, to: SnapshotId): boolean {
  const points = comparePoints(data);
  const exists = (id: SnapshotId): boolean => points.some((point) => point.id === id && point.exists);
  return from !== to && exists(from) && exists(to);
}

/** The plan for a request, or undefined when the sent data does not offer it. */
export function planSchemaHistoryAction(
  data: SchemaHistoryData,
  request: SchemaHistoryActionRequest,
): SchemaHistoryPlan | undefined {
  const subject: Subject | undefined =
    data.schema === null
      ? undefined
      : { kind: 'table', id: data.tableId, schemaName: data.schema, name: data.name };
  if (!subject) {
    return undefined;
  }
  if (request.action === 'scriptAlter') {
    return data.exists ? { action: 'scriptAlter', subject } : undefined;
  }
  const { from, to } = request;
  return from !== undefined && to !== undefined && canCompareSchema(data, from, to)
    ? { action: 'compareSchema', subject, from: Math.min(from, to), to: Math.max(from, to) }
    : undefined;
}
