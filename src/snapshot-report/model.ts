import type { SnapshotId } from '../catalog/model';
import { compareText, groupBy } from '../order';
import { plural } from '../shell/model';
import { OTHER_LANE, compareLanes } from '../snapshot-changes/model';
import type { Lane, Model, Point, PointKind } from '../snapshot-changes/model';
import { olderNote } from '../snapshot-changes/window';
import type { SnapshotWindow } from '../snapshot-changes/window';

/** What the extension reads and posts to the page: the newest snapshots of the lake; the page computes everything else. */
export type SnapshotReportData = SnapshotWindow;

// Table lanes shown at most; the others stay behind the table filter.
const MAX_LANES = 30;

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
  const bySnapshot = groupBy(
    points,
    (point) => point.snapshot,
    (point) => point.lane,
  );
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

/** The snapshots read are always the newest of the lake. */
export const snapshotReportOlderNote = (data: SnapshotReportData): string => olderNote(data);

export const omittedLanesNote = (omitted: number): string =>
  `${plural(omitted, 'lane', 'lanes')} not shown: the ${MAX_LANES} busiest tables are drawn. Choose tables in the filter to see the others.`;
