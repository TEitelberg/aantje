import { describeChange, parseChanges } from '../catalog/changes';
import type { ResolvedAction, ResolvedChange, SnapshotActivity, SnapshotId } from '../catalog/model';
import { compareText } from '../order';
import { formatUtc, plural, tableLabel } from '../shell/model';
import { describeAction } from '../snapshot';

/** What the extension reads and posts to the page; the page computes everything else. */
export interface SnapshotReportData {
  readonly connection: string;
  /** Not necessarily among `snapshots`. */
  readonly latest: SnapshotId;
  /** Newest first. */
  readonly snapshots: readonly SnapshotActivity[];
  /** The catalog has older snapshots than these. */
  readonly more: boolean;
}

export type PointKind = 'insert' | 'update' | 'delete' | 'ddl' | 'maintenance';

export const POINT_KINDS: readonly PointKind[] = ['insert', 'update', 'delete', 'ddl', 'maintenance'];

export const SNAPSHOT_REPORT_KIND_LABEL: Readonly<Record<PointKind, string>> = {
  insert: 'Insert',
  update: 'Update',
  delete: 'Delete',
  ddl: 'Schema change',
  maintenance: 'Maintenance',
};

// Table lanes shown at most; the others stay behind the table filter.
const MAX_LANES = 30;

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

interface Lane {
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

function compareLanes(a: Lane, b: Lane): number {
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
    const actions = new Map<string, ResolvedAction[]>();
    for (const change of snapshot.changes) {
      const key = laneKey(change);
      actions.set(key, [...(actions.get(key) ?? []), change.action]);
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

export interface SnapshotReportFilter {
  /** Empty shows every lane. */
  readonly lanes: readonly string[];
  readonly kinds: readonly PointKind[];
  /** Both ends included; undefined for all snapshots read. */
  readonly range?: { readonly from: SnapshotId; readonly to: SnapshotId };
}

interface Column {
  readonly id: SnapshotId;
  readonly time: string;
}

export interface SnapshotReportView {
  /** Top to bottom: at most `MAX_LANES` tables and the other-objects lane. */
  readonly lanes: readonly Lane[];
  readonly omittedLanes: number;
  readonly points: readonly Point[];
  /** Oldest first. */
  readonly columns: readonly Column[];
  /** Snapshots that changed more than one lane; the chart joins them with a line. */
  readonly transactions: readonly SnapshotId[];
}

export function snapshotReportViewOf(model: Model, filter: SnapshotReportFilter): SnapshotReportView {
  const { range } = filter;
  const kinds = new Set(filter.kinds);
  const wanted = new Set(filter.lanes);
  const candidates = model.points.filter(
    (point) =>
      kinds.has(point.kind) &&
      (wanted.size === 0 || wanted.has(point.lane)) &&
      (!range || (point.snapshot >= range.from && point.snapshot <= range.to)),
  );
  const activity = new Map<string, number>();
  for (const point of candidates) {
    activity.set(point.lane, (activity.get(point.lane) ?? 0) + 1);
  }
  const active = model.lanes
    .filter((lane) => activity.has(lane.key))
    .map((lane) => ({ ...lane, activity: activity.get(lane.key) ?? 0 }))
    .toSorted(compareLanes);
  const tables = active.filter((lane) => lane.key !== OTHER_LANE);
  const lanes = [...tables.slice(0, MAX_LANES), ...active.filter((lane) => lane.key === OTHER_LANE)];
  const shown = new Set(lanes.map((lane) => lane.key));
  const points = candidates.filter((point) => shown.has(point.lane));
  const timeOf = new Map(model.snapshots.map((snapshot) => [snapshot.id, snapshot.time]));
  const bySnapshot = new Map<SnapshotId, string[]>();
  for (const point of points) {
    bySnapshot.set(point.snapshot, [...(bySnapshot.get(point.snapshot) ?? []), point.lane]);
  }
  return {
    lanes,
    omittedLanes: tables.length - Math.min(tables.length, MAX_LANES),
    points,
    columns: [...bySnapshot.keys()].map((id) => ({ id, time: timeOf.get(id) ?? '' })),
    transactions: [...bySnapshot].filter(([, laneKeys]) => laneKeys.length > 1).map(([snapshot]) => snapshot),
  };
}

interface TableChoice {
  readonly key: string;
  readonly name: string;
  readonly dropped: boolean;
}

interface SchemaChoices {
  /** Null for tables whose schema the catalog lacks. */
  readonly schema: string | null;
  readonly tables: readonly TableChoice[];
}

/** Table lanes grouped by schema, both in name order; the other-objects lane is not included. */
export function snapshotReportTableChoices(model: Model): SchemaChoices[] {
  const groups = new Map<string | null, TableChoice[]>();
  for (const lane of model.lanes) {
    if (lane.key !== OTHER_LANE) {
      groups.set(lane.schema, [
        ...(groups.get(lane.schema) ?? []),
        { key: lane.key, name: lane.name, dropped: lane.dropped },
      ]);
    }
  }
  return [...groups]
    .map(([schema, tables]) => ({ schema, tables: tables.toSorted((a, b) => compareText(a.name, b.name)) }))
    .toSorted((a, b) => compareText(a.schema ?? '', b.schema ?? ''));
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

/** The first changed tables for the list, then how many more there are. */
export function summaryOf(detail: SnapshotReportDetail): string {
  const shown = detail.tables.slice(0, 3).map((table) => table.label);
  const rest = detail.tables.length - shown.length + detail.others.length;
  return [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(', ');
}

export interface SnapshotReportDetail {
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

function nameOf(change: ResolvedChange): string | undefined {
  return change.name === null
    ? undefined
    : change.schemaName === null
      ? change.name
      : `${change.schemaName}.${change.name}`;
}

// An entry that is not understood is shown as stored.
function describeOther(change: ResolvedChange): string {
  const name = nameOf(change);
  if (change.object !== null && name !== undefined) {
    return `${describeAction(change.action, change.object)} ${name}`;
  }
  const [entry] = parseChanges(change.raw);
  return entry ? describeChange(entry) : change.raw;
}

/** The facts for the detail pane; undefined for a snapshot that was not read. */
export function snapshotReportDetailOf(
  model: Model,
  latest: SnapshotId,
  id: SnapshotId,
): SnapshotReportDetail | undefined {
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

/** The snapshots read are always the newest of the lake. */
export const snapshotReportOlderNote = (data: SnapshotReportData): string =>
  `The ${data.snapshots.length} newest snapshots are shown. Older ones are not read.`;

export const omittedLanesNote = (omitted: number): string =>
  `${plural(omitted, 'lane', 'lanes')} not shown: the ${MAX_LANES} busiest tables are drawn. Choose tables in the filter to see the others.`;
