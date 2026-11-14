import type { GrowthChange, SnapshotId } from '../catalog/model';
import { compareText } from '../order';
import { count, formatBytes, tableLabel } from '../shell/model';
import type { Card } from '../shell/model';
import { OTHER_LANE, buildModel } from '../snapshot-changes/model';
import type { Model } from '../snapshot-changes/model';
import { olderNote, windowSubtitle } from '../snapshot-changes/window';
import type { ScopedWindow } from '../snapshot-changes/window';

/**
 * What the extension reads and posts to the page; the page computes everything else. For a schema, `snapshots`,
 * `tables` and `changes` are those of its tables.
 */
export interface GrowthData extends ScopedWindow {
  /** The table that the page starts with; null for the whole lake. */
  readonly focus: number | null;
  /** For a schema: whether snapshots expired, judged on all snapshots read; the ones of the schema have gaps anyway. */
  readonly expired?: boolean;
  /** The tables of the newest snapshot; the changes name dropped ones (see `growthTableChoices`). */
  readonly tables: readonly GrowthTable[];
  /** What each snapshot did to each table; older, unread snapshots are summed up (`snapshot: null`). */
  readonly changes: readonly GrowthChange[];
  /** DuckLake keeps inlined rows in some tables that could not be counted. */
  readonly inlinedMore: boolean;
  /** The inlined rows could not be read at all. */
  readonly inlinedFailed: boolean;
}

interface GrowthTable {
  readonly id: number;
  readonly schema: string;
  readonly name: string;
}

export const METRICS = ['rows', 'bytes', 'files'] as const;
export type Metric = (typeof METRICS)[number];

export const METRIC_LABEL: Readonly<Record<Metric, string>> = {
  rows: 'Live rows',
  bytes: 'Data size',
  files: 'Data files',
};

type Totals = Readonly<Record<Metric, number>>;

export type GrowthXAxis = 'snapshot' | 'time';

export interface Step {
  readonly id: SnapshotId;
  readonly time: string;
  readonly author: string | null;
  readonly message: string | null;
  readonly changed: boolean;
  /** A file holds more than the snapshot, so the rows can be off (see `TableStats.approximate`). */
  readonly approximate: boolean;
  readonly total: Totals;
  /** The change since the previous step; for the first step, since the summed-up older snapshots. */
  readonly delta: Totals;
}

export interface TableChoice extends GrowthTable {
  /** `schema.table`, with `(dropped)` and the id when several dropped tables share the name. */
  readonly label: string;
}

export const growthModelOf = (data: GrowthData): Model => buildModel(data.snapshots, data.more);

/** The tables of the newest snapshot and the dropped ones that the snapshots name. */
export function growthTableChoices(data: GrowthData, model: Model): TableChoice[] {
  const current = new Set(data.tables.map(({ id }) => id));
  const gone = model.lanes.flatMap((lane) =>
    lane.tableId !== null && !current.has(lane.tableId) && lane.schema !== null
      ? [{ id: lane.tableId, schema: lane.schema, name: lane.name, label: tableLabel(lane) }]
      : [],
  );
  const dropped = gone.map((table) => ({
    ...table,
    label: `${table.label} (dropped${gone.filter(({ label }) => label === table.label).length > 1 ? ` #${table.id}` : ''})`,
  }));
  return [...data.tables.map((table) => ({ ...table, label: tableLabel(table) })), ...dropped].toSorted(
    (a, b) => compareText(a.label, b.label),
  );
}

const ZERO: Totals = { rows: 0, bytes: 0, files: 0 };

/** The state after each snapshot read, oldest first; a change at an unread snapshot counts from the next one. */
export function seriesOf(data: GrowthData, model: Model, table: number | undefined): Step[] {
  const own = data.changes
    .filter((change) => table === undefined || change.tableId === table)
    .toSorted((a, b) => (a.snapshot ?? -1) - (b.snapshot ?? -1));
  const lane = table === undefined ? undefined : `t${table}`;
  const changed = new Set(
    model.points
      .filter((point) => point.lane !== OTHER_LANE && (lane === undefined || point.lane === lane))
      .map((point) => point.snapshot),
  );
  let total: Totals = ZERO;
  let partial = 0;
  let next = 0;
  const take = (until: SnapshotId | null): void => {
    for (; next < own.length; next++) {
      const change = own[next] as GrowthChange;
      if (until === null ? change.snapshot !== null : (change.snapshot ?? -1) > until) {
        return;
      }
      total = {
        rows: total.rows + change.rows,
        bytes: total.bytes + change.sizeBytes,
        files: total.files + change.files,
      };
      partial += change.partialFiles;
    }
  };
  take(null);
  let before = total;
  return model.snapshots.map((snapshot): Step => {
    take(snapshot.id);
    const step: Step = {
      id: snapshot.id,
      time: snapshot.time,
      author: snapshot.author,
      message: snapshot.commitMessage,
      changed: changed.has(snapshot.id),
      approximate: partial > 0,
      total,
      delta: {
        rows: total.rows - before.rows,
        bytes: total.bytes - before.bytes,
        files: total.files - before.files,
      },
    };
    before = total;
    return step;
  });
}

export const formatMetric = (metric: Metric, value: number): string =>
  metric === 'bytes' ? formatBytes(value) : count(value);

export const formatDelta = (metric: Metric, delta: number): string =>
  delta === 0 ? '0' : `${delta > 0 ? '+' : '-'}${formatMetric(metric, Math.abs(delta))}`;

/** Marks the value with `~` when it is not exact. */
export const formatStep = (metric: Metric, step: Step): string =>
  `${step.approximate ? '~' : ''}${formatMetric(metric, step.total[metric])}`;

interface Summary {
  readonly first: Step;
  readonly last: Step;
  readonly highest: Step;
  /** Undefined when no step increased or decreased. */
  readonly increase?: Step;
  readonly decrease?: Step;
}

export function summarizeGrowth(steps: readonly Step[], metric: Metric): Summary | undefined {
  const [first] = steps;
  const last = steps.at(-1);
  if (!first || !last) {
    return undefined;
  }
  let highest = first;
  let increase: Step | undefined;
  let decrease: Step | undefined;
  for (const step of steps) {
    if (step.total[metric] > highest.total[metric]) {
      highest = step;
    }
    if (step.delta[metric] > (increase?.delta[metric] ?? 0)) {
      increase = step;
    }
    if (step.delta[metric] < (decrease?.delta[metric] ?? 0)) {
      decrease = step;
    }
  }
  return { first, last, highest, ...(increase ? { increase } : {}), ...(decrease ? { decrease } : {}) };
}

export function growthCards(steps: readonly Step[], metric: Metric): Card[] {
  const summary = summarizeGrowth(steps, metric);
  const at = (step: Step | undefined): string | undefined => (step ? `at @${step.id}` : undefined);
  const figure = (label: string, value: string, detail?: string): Card => ({
    label,
    value,
    ...(detail ? { detail } : {}),
    severity: 'ok',
  });
  return [
    figure(
      'Now',
      summary ? formatStep(metric, summary.last) : 'none',
      summary ? `at @${summary.last.id}` : undefined,
    ),
    figure(
      'Highest',
      summary ? formatMetric(metric, summary.highest.total[metric]) : 'none',
      at(summary?.highest),
    ),
    figure(
      'Largest increase',
      summary?.increase ? formatDelta(metric, summary.increase.delta[metric]) : 'none',
      at(summary?.increase),
    ),
    figure(
      'Largest decrease',
      summary?.decrease ? formatDelta(metric, summary.decrease.delta[metric]) : 'none',
      at(summary?.decrease),
    ),
    figure(
      'Snapshots',
      String(steps.length),
      `${steps.filter(({ changed }) => changed).length} changed the table`,
    ),
  ];
}

export const growthOlderNote = (data: GrowthData): string =>
  olderNote(
    data,
    'the first value is the state after the oldest snapshot shown, and its change is the change of that snapshot',
  );

/** Whether snapshots are missing between or ahead of the ones read, because they expired. */
export function hasExpired(data: GrowthData): boolean {
  return data.expired ?? expiredAmong(data.snapshots.map(({ id }) => id));
}

/** The ids are those of all snapshots that were read: the ones of one schema would have gaps without any expiry. */
export function expiredAmong(ids: readonly SnapshotId[]): boolean {
  const oldest = Math.min(...ids);
  return ids.length > 0 && (ids.length < Math.max(...ids) - oldest + 1 || oldest > 0);
}

export const EXPIRED_NOTE =
  'Some snapshots have expired and are gone from the catalog, so the history has gaps or starts late. What an expired snapshot changed shows at the next snapshot that is left.';

export const INLINED_NOTE =
  'The catalog keeps inlined rows in more tables than were read; the rows of the others are not counted.';

export const INLINED_FAILED_NOTE =
  'The inlined rows of the catalog could not be read; they are not counted, so the numbers can be too low.';

export const APPROXIMATE_NOTE =
  'Values marked ~ are not exact: a file holds more than the snapshot (a merged data file, or a delete file that collects the deletes of several snapshots), so its one row count covers later snapshots too.';

export const NO_DATA_NOTE = 'No snapshot read changed the table of the selection.';

export const growthScopeLabel = (choices: readonly TableChoice[], table: number | undefined): string =>
  table === undefined ? 'all tables' : (choices.find(({ id }) => id === table)?.label ?? `table #${table}`);

export const truncationNote = (shown: number, total: number): string =>
  `${shown} of ${total} snapshots are listed, the newest first. The chart has the others.`;

export const subtitle = (data: GrowthData): string => windowSubtitle(data);
