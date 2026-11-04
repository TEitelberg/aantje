/// <reference lib="dom" />
// DOM builders of the snapshot report; user input comes back through callbacks.
import { actionButton, note, rangeField, scrollable, toolbar as filterBar } from '../shell/blocks';
import { el } from '../shell/dom';
import { withoutUtc } from '../shell/model';
import { snapshotReportCompareTargets, isReadable, showsRows } from './actions';
import type { SnapshotReportActionRequest, SnapshotReportCompareTarget } from './actions';
import type { SnapshotReportXAxis } from './chart-options';
import {
  SNAPSHOT_REPORT_KIND_LABEL,
  OTHER_LABEL,
  OTHER_LANE,
  POINT_KINDS,
  snapshotReportDetailOf,
  snapshotReportTableChoices,
  summaryOf,
  tableExistsAt,
} from './model';
import type { SnapshotReportDetail, DetailTable, Model, PointKind, SnapshotReportView } from './model';

const LANE_PX = 28;
const CHART_EXTRA_PX = 140;
const CHART_MIN_PX = 240;

export interface ListRow {
  readonly row: HTMLElement;
  readonly pick: HTMLElement;
}

interface DetailView {
  readonly model: Model;
  readonly latest: number;
  readonly selected: number | undefined;
  readonly other: number | undefined;
}

interface DetailHandlers {
  readonly onAction: (request: SnapshotReportActionRequest) => void;
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
  readonly onAction: (request: SnapshotReportActionRequest) => void;
}

const withMembers = <T>(set: ReadonlySet<T>, members: readonly T[], on: boolean): Set<T> => {
  const next = new Set(set);
  for (const member of members) {
    if (on) {
      next.add(member);
    } else {
      next.delete(member);
    }
  }
  return next;
};

const whoOf = (snapshot: SnapshotReportDetail): string[] =>
  [snapshot.author, snapshot.message].filter((part): part is string => part !== null && part !== '');

// Only the picked second snapshot travels as its id.
const against = (
  target: SnapshotReportCompareTarget,
): Pick<SnapshotReportActionRequest, 'against' | 'other'> =>
  target.against === 'other' ? { against: 'other', other: target.snapshot } : { against: target.against };

const targetLabel = ({ against: kind, snapshot }: SnapshotReportCompareTarget): string =>
  kind === 'other' ? `@${snapshot}` : `${kind} @${snapshot}`;

export function emptyPlot(snapshotCount: number): HTMLElement {
  return el(
    'p',
    'empty',
    snapshotCount === 0
      ? 'This catalog has no snapshots.'
      : 'No snapshot in this range changed the chosen tables with the chosen kinds of change.',
  );
}

/** ECharts draws into the box and writes the text for assistive technology into it. */
export function chartBox(laneCount: number): HTMLElement {
  const box = el('div', 'chart');
  box.style.height = `${Math.max(CHART_MIN_PX, laneCount * LANE_PX + CHART_EXTRA_PX)}px`;
  return box;
}

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

export function markRows(
  rows: ReadonlyMap<number, ListRow>,
  selected: number | undefined,
  other: number | undefined,
): void {
  for (const [id, { row, pick }] of rows) {
    row.className = [id === selected ? 'selected' : '', id === other ? 'other' : '']
      .filter(Boolean)
      .join(' ');
    pick.setAttribute('aria-pressed', String(id === selected));
  }
}

export function snapshotList(
  view: SnapshotReportView,
  model: Model,
  latest: number,
  onSelect: (id: number, extend: boolean) => void,
): { readonly children: HTMLElement[]; readonly rows: Map<number, ListRow> } {
  const rows = new Map<number, ListRow>();
  const head = el('tr');
  for (const heading of ['Snapshot', 'Time (UTC)', 'Author and message', 'Changes']) {
    head.append(el('th', undefined, heading));
  }
  const thead = el('thead');
  thead.append(head);
  const tbody = el('tbody');
  for (const column of view.columns.toReversed()) {
    const snapshot = snapshotReportDetailOf(model, latest, column.id);
    if (!snapshot) {
      continue;
    }
    const pick = el('button', 'pick', `@${snapshot.id}`);
    pick.setAttribute(
      'aria-label',
      `Snapshot ${snapshot.id}. Press Ctrl and Enter to choose it as the second snapshot of a comparison.`,
    );
    pick.addEventListener('click', (event) => onSelect(snapshot.id, event.ctrlKey || event.metaKey));
    const first = el('td');
    first.append(pick);
    const row = el('tr');
    row.append(
      first,
      el('td', undefined, withoutUtc(snapshot.timeText)),
      el('td', 'who', whoOf(snapshot).join(' · ')),
      el('td', undefined, summaryOf(snapshot)),
    );
    rows.set(snapshot.id, { row, pick });
    tbody.append(row);
  }
  const table = el('table');
  table.append(thead, tbody);
  return { children: [el('h2', undefined, 'Snapshots'), scrollable(table)], rows };
}

function tableRow(
  snapshot: SnapshotReportDetail,
  table: DetailTable,
  view: DetailView,
  ask: (request: SnapshotReportActionRequest) => void,
): HTMLElement {
  const button = (label: string, request: SnapshotReportActionRequest, description?: string) =>
    actionButton(label, () => ask(request), description);
  const row = el('li', 'table-row');
  const actions = el('div', 'actions');
  if (isReadable(table)) {
    const at = { snapshot: snapshot.id, table: table.tableId };
    if (showsRows(snapshot, table)) {
      actions.append(
        button(
          'Rows changed',
          { action: 'rowsChanged', ...at },
          `Show the rows of ${table.label} that @${snapshot.id} changed`,
        ),
      );
    }
    actions.append(button('Query...', { action: 'query', ...at }, `Query ${table.label} at @${snapshot.id}`));
    const targets = snapshotReportCompareTargets(snapshot, view.latest, view.other, (id) =>
      tableExistsAt(view.model, table.key, id),
    );
    if (targets.length > 0) {
      actions.append(el('span', 'label', 'Schema vs'));
    }
    for (const target of targets) {
      const text = targetLabel(target);
      actions.append(
        button(
          text,
          { action: 'compareSchema', ...at, ...against(target) },
          `Compare the schema of ${table.label} at @${snapshot.id} with ${text}`,
        ),
      );
    }
  }
  row.append(el('span', 'name', table.label), el('span', 'what', table.actions.join(', ')), actions);
  return row;
}

function snapshotActions(
  snapshot: SnapshotReportDetail,
  view: DetailView,
  ask: (request: SnapshotReportActionRequest) => void,
): HTMLElement {
  const targets = snapshotReportCompareTargets(snapshot, view.latest, view.other);
  const wide = el('div', 'actions');
  wide.append(
    actionButton(`Show catalog at @${snapshot.id}`, () =>
      ask({ action: 'showCatalog', snapshot: snapshot.id }),
    ),
    ...(targets.length > 0 ? [el('span', 'label', 'Compare the catalog with')] : []),
    ...targets.map((target) =>
      actionButton(
        targetLabel(target),
        () => ask({ action: 'compareSnapshots', snapshot: snapshot.id, ...against(target) }),
        `Compare the catalog at @${snapshot.id} with ${targetLabel(target)}`,
      ),
    ),
  );
  return wide;
}

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, on: DetailHandlers): HTMLElement[] {
  const snapshot =
    view.selected === undefined ? undefined : snapshotReportDetailOf(view.model, view.latest, view.selected);
  if (!snapshot) {
    return [note('Select a snapshot in the chart or in the list to see what it changed.')];
  }
  const who = whoOf(snapshot);
  const tables = el('ul', 'tables');
  tables.append(...snapshot.tables.map((table) => tableRow(snapshot, table, view, on.onAction)));
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
  const others = el('ul', 'others');
  others.append(...snapshot.others.map((text) => el('li', undefined, text)));
  return [
    el('h2', undefined, `@${snapshot.id} · ${snapshot.timeText}`),
    ...(who.length > 0 ? [el('p', 'who', who.join(' · '))] : []),
    snapshotActions(snapshot, view, on.onAction),
    second,
    ...(snapshot.tables.length > 0 ? [el('h3', undefined, 'Tables'), tables] : []),
    ...(snapshot.others.length > 0 ? [el('h3', undefined, OTHER_LABEL), others] : []),
  ];
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

function checkbox(text: string, checked: boolean, apply: (on: boolean) => void): HTMLLabelElement {
  const label = el('label', 'check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => apply(input.checked));
  label.append(input, text);
  return label;
}

/** `current` is read on every change: the toolbar outlives the choices it was built with. */
export function toolbar(model: Model, current: () => Choices, on: ToolbarHandlers): HTMLElement {
  const kindBox = el('div', 'kinds');
  kindBox.append(
    ...POINT_KINDS.map((kind) =>
      checkbox(SNAPSHOT_REPORT_KIND_LABEL[kind], current().kinds.has(kind), (checked) =>
        on.onChange({ ...current(), kinds: withMembers(current().kinds, [kind], checked) }),
      ),
    ),
  );
  const first = model.snapshots[0]?.id ?? 0;
  const last = model.snapshots.at(-1)?.id ?? 0;
  const number = (label: string, end: 'from' | 'to'): HTMLLabelElement =>
    rangeField(
      label,
      first,
      last,
      () => current().range[end],
      (next) => on.onChange({ ...current(), range: { ...current().range, [end]: next } }),
    );
  const mode = (id: SnapshotReportXAxis, text: string): HTMLButtonElement => {
    const choice = el('button', 'mode', text);
    choice.setAttribute('aria-pressed', String(current().axis === id));
    choice.addEventListener('click', () => {
      for (const sibling of modes) {
        sibling.setAttribute('aria-pressed', String(sibling === choice));
      }
      on.onChange({ ...current(), axis: id });
    });
    return choice;
  };
  const modes = [mode('order', 'Order'), mode('time', 'Time')];
  const axisBox = el('div', 'axis');
  axisBox.append('X axis: ', ...modes);
  return filterBar(
    tablesFilter(model, current, on),
    kindBox,
    number('From', 'from'),
    number('To', 'to'),
    axisBox,
    actionButton('Show latest snapshot', () => on.onAction({ action: 'showLatest' })),
  );
}
