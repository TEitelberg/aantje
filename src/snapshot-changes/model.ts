import { describeAction, describeChange, parseChanges } from '../catalog/changes';
import type { ResolvedAction, ResolvedChange, SnapshotActivity, SnapshotId } from '../catalog/model';
import { groupBy } from '../order';
import { formatUtc, tableLabel } from '../shell/model';

// What the reports of snapshots by time (Snapshot Report, Activity, Growth) share: the kind of each change, a lane per
// table, and the facts of one snapshot.

export type PointKind = 'insert' | 'update' | 'delete' | 'ddl' | 'maintenance';

export const POINT_KINDS: readonly PointKind[] = ['insert', 'update', 'delete', 'ddl', 'maintenance'];

export const KIND_LABEL: Readonly<Record<PointKind, string>> = {
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
  ddl: 'Schema change',
  maintenance: 'Maintenance',
};

/** The lane of changes that belong to no table: schemas, views, macros, tags, expired snapshots. */
export const OTHER_LANE = 'other';
export const OTHER_LABEL = 'Schema / views / macros';

const KIND_OF_ACTION: Readonly<Record<ResolvedAction, PointKind>> = {
  created: 'ddl',
  dropped: 'ddl',
  altered: 'ddl',
  renamed: 'ddl',
  unknown: 'ddl',
  inserted: 'insert',
  inlined_insert: 'insert',
  deleted: 'delete',
  inlined_delete: 'delete',
  flushed_inlined: 'maintenance',
  compacted: 'maintenance',
  merged: 'maintenance',
  rewritten: 'maintenance',
  expired: 'maintenance',
};

const DATA_ACTIONS: readonly ResolvedAction[] = ['inserted', 'deleted', 'inlined_insert', 'inlined_delete'];

// A schema change wins over data; insert and delete together are an update.
function kindOf(actions: readonly ResolvedAction[]): PointKind {
  const kinds = new Set(actions.map((action) => KIND_OF_ACTION[action]));
  if (kinds.has('ddl')) {
    return 'ddl';
  }
  if (kinds.has('insert') && kinds.has('delete')) {
    return 'update';
  }
  return kinds.has('insert') ? 'insert' : kinds.has('delete') ? 'delete' : 'maintenance';
}

const laneKey = (change: ResolvedChange): string =>
  change.object === 'table' && change.objectId !== null ? `t${change.objectId}` : OTHER_LANE;

export interface Lane {
  readonly key: string;
  readonly tableId: number | null;
  /** Null for the other-objects lane and for a table whose name the catalog lacks. */
  readonly schema: string | null;
  readonly name: string;
  readonly dropped: boolean;
  readonly activity: number;
}

export interface Point {
  readonly snapshot: SnapshotId;
  readonly lane: string;
  readonly kind: PointKind;
  readonly actions: readonly ResolvedAction[];
}

export interface Model {
  /** Oldest first. */
  readonly snapshots: readonly SnapshotActivity[];
  /** The catalog has older snapshots than these. */
  readonly more: boolean;
  /** The snapshots that created and dropped each table lane, as far as the snapshots read tell. */
  readonly lifetimes: ReadonlyMap<string, { readonly created?: SnapshotId; readonly dropped?: SnapshotId }>;
  /** Busiest first, the other-objects lane last. */
  readonly lanes: readonly Lane[];
  /** Oldest snapshot first, then in lane order. */
  readonly points: readonly Point[];
}

/** The order of the lanes: the busiest first, the other-objects lane last, ties by name. */
export function compareLanes(a: Lane, b: Lane): number {
  return (
    Number(a.key === OTHER_LANE) - Number(b.key === OTHER_LANE) ||
    b.activity - a.activity ||
    (tableLabel(a) < tableLabel(b) ? -1 : tableLabel(a) > tableLabel(b) ? 1 : 0) ||
    (a.tableId ?? 0) - (b.tableId ?? 0)
  );
}

/** A table keeps one lane across a rename, named as in its newest snapshot. */
export function buildModel(snapshots: readonly SnapshotActivity[], more = false): Model {
  const ordered = snapshots.toSorted((a, b) => a.id - b.id);
  const names = new Map<string, { schema: string | null; name: string }>();
  const lifetimes = new Map<string, { created?: SnapshotId; dropped?: SnapshotId }>();
  const activity = new Map<string, number>();
  const points: Point[] = [];
  for (const snapshot of ordered) {
    const actions = groupBy(snapshot.changes, laneKey, (change) => change.action);
    for (const change of snapshot.changes) {
      const key = laneKey(change);
      if (key !== OTHER_LANE) {
        if (change.name !== null) {
          names.set(key, { schema: change.schemaName, name: change.name });
        }
        if (change.action === 'created') {
          lifetimes.set(key, { ...lifetimes.get(key), created: snapshot.id });
        } else if (change.action === 'dropped') {
          lifetimes.set(key, { ...lifetimes.get(key), dropped: snapshot.id });
        }
      }
    }
    for (const [lane, list] of actions) {
      const unique = [...new Set(list)];
      points.push({ snapshot: snapshot.id, lane, kind: kindOf(unique), actions: unique });
      activity.set(lane, (activity.get(lane) ?? 0) + 1);
    }
  }
  const lanes = [...activity].map(([key, count]): Lane => {
    const tableId = key === OTHER_LANE ? null : Number(key.slice(1));
    const named = names.get(key);
    return {
      key,
      tableId,
      schema: named?.schema ?? null,
      name: key === OTHER_LANE ? OTHER_LABEL : (named?.name ?? `table #${tableId}`),
      dropped: lifetimes.get(key)?.dropped !== undefined,
      activity: count,
    };
  });
  return { snapshots: ordered, more, lifetimes, lanes: lanes.toSorted(compareLanes), points };
}

/** Whether the table exists at the snapshot; an unknown creation or drop counts as none. */
export function tableExistsAt(model: Model, key: string, snapshot: SnapshotId): boolean {
  const { created, dropped } = model.lifetimes.get(key) ?? {};
  return (created === undefined || snapshot >= created) && (dropped === undefined || snapshot < dropped);
}

export interface DetailTable {
  readonly key: string;
  readonly tableId: number;
  /** Null when the catalog lacks the names, because the snapshots that named the table expired. */
  readonly schema: string | null;
  readonly name: string | null;
  readonly label: string;
  readonly actions: readonly string[];
  readonly exists: boolean;
  /** Inserted or deleted rows, inlined ones included. */
  readonly dataChange: boolean;
}

export interface SnapshotDetail {
  readonly id: SnapshotId;
  readonly time: string;
  readonly timeText: string;
  readonly author: string | null;
  readonly message: string | null;
  readonly tables: readonly DetailTable[];
  readonly others: readonly string[];
  /** The next older snapshot read, else the preceding number when older ones exist; undefined for the oldest. */
  readonly previous: SnapshotId | undefined;
  readonly hasLatest: boolean;
}

/** The first changed tables for the list, then how many more there are. */
export function summaryOf(detail: SnapshotDetail): string {
  const shown = detail.tables.slice(0, 3).map((table) => table.label);
  const rest = detail.tables.length - shown.length + detail.others.length;
  return [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ');
}

// An entry that is not understood is shown as stored.
function describeOther(change: ResolvedChange): string {
  if (change.object !== null && change.name !== null) {
    return `${describeAction(change.action, change.object)} ${tableLabel({ schema: change.schemaName, name: change.name })}`;
  }
  const [entry] = parseChanges(change.raw);
  return entry ? describeChange(entry) : change.raw;
}

/** The facts of one snapshot for a detail pane or a document; undefined for a snapshot that was not read. */
export function detailOf(model: Model, latest: SnapshotId, id: SnapshotId): SnapshotDetail | undefined {
  const snapshot = model.snapshots.find((candidate) => candidate.id === id);
  if (!snapshot) {
    return undefined;
  }
  const tables = new Map<
    string,
    { schema: string | null; name: string | null; tableId: number; actions: ResolvedAction[] }
  >();
  const others: string[] = [];
  for (const change of snapshot.changes) {
    const key = laneKey(change);
    if (key === OTHER_LANE || change.objectId === null) {
      others.push(describeOther(change));
      continue;
    }
    const known = tables.get(key);
    tables.set(key, {
      schema: change.schemaName,
      name: change.name,
      tableId: change.objectId,
      actions: [...(known?.actions ?? []), change.action],
    });
  }
  return {
    id,
    time: snapshot.time,
    timeText: formatUtc(snapshot.time),
    author: snapshot.author,
    message: snapshot.commitMessage,
    tables: [...tables].map(([key, table]) => ({
      key,
      tableId: table.tableId,
      schema: table.schema,
      name: table.name,
      label:
        table.name === null
          ? `table #${table.tableId}`
          : tableLabel({ schema: table.schema, name: table.name }),
      actions: [...new Set(table.actions)].map((action) => describeAction(action, 'table')),
      exists: !table.actions.includes('dropped'),
      dataChange: table.actions.some((action) => DATA_ACTIONS.includes(action)),
    })),
    others,
    previous:
      model.snapshots.findLast((candidate) => candidate.id < id)?.id ??
      (model.more && id > 0 ? id - 1 : undefined),
    hasLatest: id < latest,
  };
}
