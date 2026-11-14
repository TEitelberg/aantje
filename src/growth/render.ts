/// <reference lib="dom" />
// DOM builders of the Growth report; user input comes back through callbacks.
import {
  actionButton,
  choiceSelect,
  dataTable,
  empty,
  modeGroup,
  note,
  pickCell,
  tableRow,
  toolbar,
  whoLine,
} from '../shell/blocks';
import type { ListRow } from '../shell/blocks';
import type { ChartSet } from '../shell/chart-set';
import type { ChartOption } from '../shell/chart-option';
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

/** The heading and, when there are steps, the box of the chart; a click on a point picks its step. */
export function growthPane(
  metric: Metric,
  scope: string,
  chart: {
    readonly charts: ChartSet;
    readonly option: ChartOption;
    readonly onItemClick: (index: number) => void;
  },
  hasSteps: boolean,
): HTMLElement[] {
  const heading = el('h2', undefined, `${METRIC_LABEL[metric]} of ${scope}`);
  return hasSteps
    ? [heading, chart.charts.box(chart.option, { onItemClick: chart.onItemClick })]
    : [heading, empty('This catalog has no snapshots.')];
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
    const { cell, pick } = pickCell(`@${step.id}`, `Snapshot ${step.id}. Select it to see its actions.`, () =>
      onSelect(step.id),
    );
    const row = tableRow([
      cell,
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

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, ask: (request: GrowthActionRequest) => void): HTMLElement[] {
  const { metric, table } = view;
  const step = view.steps.find(({ id }) => id === view.selected);
  if (!step) {
    return [note('Select a snapshot in the list or the chart to see its actions.')];
  }
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
    ...whoLine(step.author, step.message),
    el(
      'p',
      undefined,
      `${METRIC_LABEL[metric]}: ${formatStep(metric, step)} (${formatDelta(metric, step.delta[metric])})${step.changed ? '' : ' · this snapshot did not change the table of the selection'}`,
    ),
    actions,
  ];
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
    modeGroup(
      'Show',
      METRICS.map((value) => ({ value, text: METRIC_LABEL[value] })),
      view.metric,
      on.onMetric,
      { className: 'axis', shown: true },
    ),
    modeGroup(
      'X axis',
      [
        { value: 'snapshot' as const, text: 'Snapshots' },
        { value: 'time' as const, text: 'Time' },
      ],
      view.axis,
      on.onAxis,
      { className: 'axis', shown: true },
    ),
  );
}
