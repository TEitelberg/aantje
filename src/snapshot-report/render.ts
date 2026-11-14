/// <reference lib="dom" />
// DOM builders of the snapshot report; user input comes back through callbacks.
import {
  actionButton,
  dataTable,
  kindBoxes,
  modeGroup,
  pickCell,
  rangeFields,
  tableRow,
  toolbar as filterBar,
  withMembers,
} from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import { el } from '../shell/dom';
import { whoText, withoutUtc } from '../shell/model';
import type { SnapshotActionRequest } from '../snapshot-changes/actions';
import { detailPane } from '../snapshot-changes/detail';
import {
  KIND_LABEL,
  OTHER_LABEL,
  OTHER_LANE,
  POINT_KINDS,
  detailOf,
  summaryOf,
} from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import type { SnapshotReportXAxis } from './chart-options';
import { snapshotReportTableChoices } from './model';
import type { SnapshotReportView } from './model';

const LANE_PX = 28;
const CHART_EXTRA_PX = 140;
const CHART_MIN_PX = 240;

interface DetailView {
  readonly model: Model;
  readonly latest: number;
  readonly selected: number | undefined;
  readonly other: number | undefined;
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

interface ToolbarHandlers {
  readonly onChange: (next: Choices) => void;
  readonly onAction: (request: SnapshotActionRequest) => void;
}

export function emptyPlot(snapshotCount: number): HTMLElement {
  return el(
    'p',
    'empty',
    snapshotCount === 0
      ? 'This catalog has no snapshots.'
      : 'No snapshot in this range changed the chosen tables with the chosen kinds of change.',
  );
}

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

export function snapshotList(
  view: SnapshotReportView,
  model: Model,
  latest: number,
  onSelect: (id: number, extend: boolean) => void,
): { readonly children: HTMLElement[]; readonly rows: Map<number, ListRow> } {
  const rows = new Map<number, ListRow>();
  const body = view.columns.toReversed().flatMap((column) => {
    const snapshot = detailOf(model, latest, column.id);
    if (!snapshot) {
      return [];
    }
    const { cell, pick } = pickCell(
      `@${snapshot.id}`,
      `Snapshot ${snapshot.id}. Press Ctrl and Enter to choose it as the second snapshot of a comparison.`,
      (event) => onSelect(snapshot.id, event.ctrlKey || event.metaKey),
    );
    const row = tableRow([
      cell,
      withoutUtc(snapshot.timeText),
      el('td', 'who', whoText(snapshot.author, snapshot.message)),
      summaryOf(snapshot),
    ]);
    rows.set(snapshot.id, { row, pick });
    return [row];
  });
  return {
    children: [
      el('h2', undefined, 'Snapshots'),
      dataTable(['Snapshot', 'Time (UTC)', 'Author and message', 'Changes'], body),
    ],
    rows,
  };
}

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, on: DetailHandlers): HTMLElement[] {
  const second = el('p', 'note');
  second.append(
    view.other === undefined
      ? 'Ctrl-click another snapshot in the chart, or press Ctrl and Enter on it in the list, to compare with it.'
      : `Second snapshot for comparisons: @${view.other}. `,
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
      hint: 'Select a snapshot in the chart or in the list to see what it changed.',
    },
    on.onAction,
  );
}

function tablesFilter(model: Model, current: () => Choices, on: ToolbarHandlers): HTMLElement {
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

/** `current` is read on every change: the toolbar outlives the choices it was built with. */
export function toolbar(model: Model, current: () => Choices, on: ToolbarHandlers): HTMLElement {
  const first = model.snapshots[0]?.id ?? 0;
  const last = model.snapshots.at(-1)?.id ?? 0;
  return filterBar(
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
    modeGroup(
      'X axis',
      [
        { value: 'order' as const, text: 'Order' },
        { value: 'time' as const, text: 'Time' },
      ],
      current().axis,
      (axis) => on.onChange({ ...current(), axis }),
      { className: 'axis', shown: true },
    ),
    actionButton('Show latest snapshot', () => on.onAction({ action: 'showLatest' })),
  );
}
