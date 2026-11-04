/// <reference lib="dom" />
// DOM builders of the Growth report; user input comes back through callbacks.
import { actionButton, choiceSelect, dataTable, empty, note, tableRow, toolbar } from '../shell/blocks';
import { el } from '../shell/dom';
import { LIST_ROWS, formatUtc, shortUtc } from '../shell/model';
import type { GrowthActionRequest } from './actions';
import {
  APPROXIMATE_NOTE,
  EXPIRED_NOTE,
  INLINED_FAILED_NOTE,
  INLINED_NOTE,
  METRICS,
  METRIC_LABEL,
  NO_DATA_NOTE,
  formatDelta,
  formatStep,
  growthOlderNote,
  hasExpired,
  truncationNote,
} from './model';
import type { GrowthData, GrowthXAxis, Metric, Step, TableChoice } from './model';

export interface ListRow {
  readonly row: HTMLElement;
  readonly pick: HTMLElement;
}

interface DetailView {
  readonly steps: readonly Step[];
  readonly selected: number | undefined;
  readonly table: number | undefined;
  readonly metric: Metric;
  readonly scope: string;
}

interface FilterView {
  readonly choices: readonly TableChoice[];
  readonly table: number | undefined;
  readonly metric: Metric;
  readonly axis: GrowthXAxis;
}

interface FilterHandlers {
  readonly onTable: (table: number | undefined) => void;
  readonly onMetric: (metric: Metric) => void;
  readonly onAxis: (axis: GrowthXAxis) => void;
}

/** The heading and, when there are steps, the box that the chart is drawn into. */
export function growthPane(
  metric: Metric,
  scope: string,
  hasSteps: boolean,
): { readonly children: HTMLElement[]; readonly box: HTMLElement | undefined } {
  const heading = el('h2', undefined, `${METRIC_LABEL[metric]} of ${scope}`);
  if (!hasSteps) {
    return { children: [heading, empty('This catalog has no snapshots.')], box: undefined };
  }
  const box = el('div', 'chart');
  return { children: [heading, box], box };
}

export function noteChildren(data: GrowthData, steps: readonly Step[]): HTMLElement[] {
  return [
    ...(data.more ? [note(growthOlderNote(data))] : hasExpired(data) ? [note(EXPIRED_NOTE)] : []),
    ...(data.inlinedMore ? [note(INLINED_NOTE, 'warning')] : []),
    ...(data.inlinedFailed ? [note(INLINED_FAILED_NOTE, 'warning')] : []),
    ...(steps.some(({ approximate }) => approximate) ? [note(APPROXIMATE_NOTE)] : []),
    ...(steps.length > 0 && !steps.some(({ changed }) => changed) ? [note(NO_DATA_NOTE)] : []),
  ];
}

export function snapshotList(
  steps: readonly Step[],
  metric: Metric,
  onSelect: (id: number) => void,
): { readonly children: HTMLElement[]; readonly rows: Map<number, ListRow> } {
  const rows = new Map<number, ListRow>();
  const shown = steps.toReversed().slice(0, LIST_ROWS);
  const body = shown.map((step) => {
    const pick = el('button', 'pick', `@${step.id}`);
    pick.setAttribute('aria-label', `Snapshot ${step.id}. Select it to see its actions.`);
    pick.addEventListener('click', () => onSelect(step.id));
    const first = el('td');
    first.append(pick);
    const row = tableRow([
      first,
      shortUtc(step.time),
      el('td', 'number', formatStep(metric, step)),
      el('td', 'number', formatDelta(metric, step.delta[metric])),
      el('td', 'who', step.author ?? ''),
      el('td', 'who', step.message ?? ''),
    ]);
    rows.set(step.id, { row, pick });
    return row;
  });
  const children = [
    el('h2', undefined, 'Snapshots'),
    body.length === 0
      ? empty('This catalog has no snapshots.')
      : dataTable(['Snapshot', 'Time (UTC)', METRIC_LABEL[metric], 'Change', 'Author', 'Message'], body),
    ...(steps.length > shown.length ? [note(truncationNote(shown.length, steps.length))] : []),
  ];
  return { children, rows };
}

export function markRows(rows: ReadonlyMap<number, ListRow>, selected: number | undefined): void {
  for (const [id, { row, pick }] of rows) {
    row.className = id === selected ? 'selected' : '';
    pick.setAttribute('aria-pressed', String(id === selected));
  }
}

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, ask: (request: GrowthActionRequest) => void): HTMLElement[] {
  const { metric, table } = view;
  const step = view.steps.find(({ id }) => id === view.selected);
  if (!step) {
    return [note('Select a snapshot in the list or the chart to see its actions.')];
  }
  const who = [step.author, step.message].filter((part) => part !== null && part !== '');
  const actions = el('div', 'actions');
  actions.append(
    actionButton(`Show catalog at @${step.id}`, () => ask({ action: 'showCatalog', snapshot: step.id })),
    ...(table === undefined
      ? []
      : [
          actionButton(
            `Query at @${step.id}`,
            () => ask({ action: 'query', snapshot: step.id, table }),
            `Read ${view.scope} as it was at @${step.id}`,
          ),
        ]),
  );
  return [
    el('h2', undefined, `@${step.id} · ${formatUtc(step.time)}`),
    ...(who.length > 0 ? [el('p', 'who-line', who.join(' · '))] : []),
    el(
      'p',
      undefined,
      `${METRIC_LABEL[metric]}: ${formatStep(metric, step)} (${formatDelta(metric, step.delta[metric])})${step.changed ? '' : ' · this snapshot did not change the table of the selection'}`,
    ),
    actions,
  ];
}

function modes<Id extends string>(
  label: string,
  entries: readonly { readonly id: Id; readonly text: string }[],
  current: Id,
  apply: (id: Id) => void,
): HTMLElement {
  const box = el('div', 'axis');
  const buttons = entries.map(({ id, text }) => {
    const button = el('button', 'mode', text);
    button.setAttribute('aria-pressed', String(current === id));
    button.addEventListener('click', () => {
      for (const other of buttons) {
        other.setAttribute('aria-pressed', String(other === button));
      }
      apply(id);
    });
    return button;
  });
  box.append(`${label}: `, ...buttons);
  return box;
}

export function filters(view: FilterView, on: FilterHandlers): HTMLElement {
  const tableChoice = choiceSelect(
    'Table',
    'All tables',
    view.choices.map(({ id, label }) => ({ key: String(id), label })),
    view.table === undefined ? undefined : String(view.table),
    (key) => on.onTable(key === undefined ? undefined : Number(key)),
  );
  return toolbar(
    tableChoice.element,
    modes(
      'Show',
      METRICS.map((id) => ({ id, text: METRIC_LABEL[id] })),
      view.metric,
      on.onMetric,
    ),
    modes(
      'X axis',
      [
        { id: 'snapshot' as const, text: 'Snapshots' },
        { id: 'time' as const, text: 'Time' },
      ],
      view.axis,
      on.onAxis,
    ),
  );
}
