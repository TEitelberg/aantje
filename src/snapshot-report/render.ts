/// <reference lib="dom" />
// DOM builders of the snapshot report; user input comes back through callbacks.
import {
  actionButton,
  kindBoxes,
  modeGroup,
  rangeFields,
  toolbar as filterToolbar,
  withMembers,
} from '../shell/blocks';
import { el } from '../shell/dom';
import type { SnapshotActionRequest } from '../snapshot-changes/actions';
import { detailPane } from '../snapshot-changes/detail';
import { KIND_LABEL, OTHER_LABEL, OTHER_LANE, POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import type { SnapshotReportXAxis } from './chart-options';
import { snapshotReportTableChoices } from './model';
import type { SnapshotReportView } from './model';
import type { TabId } from './state';

const LANE_PX = 28;
const CHART_EXTRA_PX = 140;
const CHART_MIN_PX = 240;

interface DetailView {
  readonly model: Model;
  readonly latest: number;
  readonly selected: number | undefined;
  readonly other: number | undefined;
  /** The tab that shows the pane: its hints name the chart or the table. */
  readonly tab: TabId;
}

interface DetailHandlers {
  readonly onAction: (request: SnapshotActionRequest) => void;
  readonly onClearOther: () => void;
}

/** The page replaces the whole value on every change. */
export interface Choices {
  readonly lanes: ReadonlySet<string>;
  readonly kinds: ReadonlySet<PointKind>;
  readonly range: { readonly from: number; readonly to: number };
  readonly axis: SnapshotReportXAxis;
}

interface FilterHandlers {
  readonly onChange: (next: Choices) => void;
}

interface ChartHandlers {
  readonly onAxis: (axis: SnapshotReportXAxis) => void;
  readonly onAction: (request: SnapshotActionRequest) => void;
}

const HINT: Readonly<Record<TabId, string>> = {
  chart: 'Select a snapshot in the chart to see what it changed.',
  snapshots: 'Select a snapshot in the table to see what it changed.',
};

const SECOND_HINT: Readonly<Record<TabId, string>> = {
  chart: 'Ctrl-click another snapshot in the chart to compare with it.',
  snapshots: 'Ctrl-click another snapshot in the table, or press Ctrl and Enter on it, to compare with it.',
};

export function emptyPlot(snapshotCount: number): HTMLElement {
  return el('p', 'empty', emptyText(snapshotCount));
}

/** Why nothing is drawn or listed: the catalog has no snapshots, or the filters leave none. */
export const emptyText = (snapshotCount: number): string =>
  snapshotCount === 0
    ? 'This catalog has no snapshots.'
    : 'No snapshot in this range changed the chosen tables with the chosen kinds of change.';

/** The height of the chart: a row per lane plus the legend, the axis and the zoom. */
export const chartHeight = (laneCount: number): number =>
  Math.max(CHART_MIN_PX, laneCount * LANE_PX + CHART_EXTRA_PX);

/** The column nearest to a click: by index on the order axis, by time on the time axis. */
export function columnAt(view: SnapshotReportView, axis: SnapshotReportXAxis, x: number): number | undefined {
  if (axis === 'order') {
    return view.columns[Math.min(Math.max(Math.round(x), 0), view.columns.length - 1)]?.id;
  }
  return view.columns.reduce<{ id: number; distance: number } | undefined>((best, column) => {
    const distance = Math.abs(Date.parse(column.time) - x);
    return !best || distance < best.distance ? { id: column.id, distance } : best;
  }, undefined)?.id;
}

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, on: DetailHandlers): HTMLElement[] {
  const second = el('p', 'note');
  second.append(
    view.other === undefined ? SECOND_HINT[view.tab] : `Second snapshot for comparisons: @${view.other}. `,
  );
  if (view.other !== undefined) {
    const clear = el('button', 'action', 'Clear');
    clear.addEventListener('click', on.onClearOther);
    second.append(clear);
  }
  return detailPane(
    {
      ...view,
      tableQueries: true,
      notes: [second],
      hint: HINT[view.tab],
    },
    on.onAction,
  );
}

function tablesFilter(model: Model, current: () => Choices, on: FilterHandlers): HTMLElement {
  const filter = el('details', 'filter');
  const summary = el('summary');
  const body = el('div', 'choices');
  const syncs: (() => void)[] = [];
  const refresh = (): void => {
    const { size } = current().lanes;
    summary.textContent = size === 0 ? 'Tables: all' : `Tables: ${size} chosen`;
    for (const sync of syncs) {
      sync();
    }
  };
  const choice = (text: string, keys: readonly string[], className = 'check'): HTMLLabelElement => {
    const label = el('label', className);
    const input = el('input');
    input.type = 'checkbox';
    const sync = (): void => {
      input.checked = keys.every((key) => current().lanes.has(key));
    };
    sync();
    syncs.push(sync);
    input.addEventListener('change', () => {
      on.onChange({ ...current(), lanes: withMembers(current().lanes, keys, input.checked) });
      refresh();
    });
    label.append(input, text);
    return label;
  };
  const all = el('button', 'action', 'All tables');
  all.addEventListener('click', () => {
    on.onChange({ ...current(), lanes: new Set() });
    refresh();
  });
  body.append(all);
  for (const group of snapshotReportTableChoices(model)) {
    const section = el('div', 'schema');
    section.append(
      choice(
        group.schema ?? 'No schema name',
        group.tables.map((table) => table.key),
      ),
      ...group.tables.map((table) =>
        choice(table.dropped ? `${table.name} (dropped)` : table.name, [table.key], 'check table'),
      ),
    );
    body.append(section);
  }
  if (model.lanes.some((lane) => lane.key === OTHER_LANE)) {
    body.append(choice(OTHER_LABEL, [OTHER_LANE]));
  }
  refresh();
  filter.append(summary, body);
  return filter;
}

/**
 * The filters above the tabs, which the chart and the table both follow: tables, kinds of change and the range.
 * `current` is read on every change: the bar outlives the choices it was built with.
 */
export function filterBar(model: Model, current: () => Choices, on: FilterHandlers): HTMLElement {
  const first = model.snapshots[0]?.id ?? 0;
  const last = model.snapshots.at(-1)?.id ?? 0;
  return filterToolbar(
    tablesFilter(model, current, on),
    kindBoxes(
      POINT_KINDS,
      KIND_LABEL,
      () => current().kinds,
      (kinds) => on.onChange({ ...current(), kinds }),
    ),
    ...rangeFields(
      first,
      last,
      (end) => current().range[end],
      (end, next) => on.onChange({ ...current(), range: { ...current().range, [end]: next } }),
    ),
  );
}

/** What belongs to the chart only: its x axis, and Show latest snapshot. */
export function chartBar(axis: SnapshotReportXAxis, on: ChartHandlers): HTMLElement {
  const bar = filterToolbar(
    modeGroup(
      'X axis',
      [
        { value: 'order' as const, text: 'Order' },
        { value: 'time' as const, text: 'Time' },
      ],
      axis,
      on.onAxis,
      { className: 'axis', shown: true },
    ),
    actionButton('Show latest snapshot', () => on.onAction({ action: 'showLatest' })),
  );
  bar.setAttribute('aria-label', 'Chart');
  return bar;
}
