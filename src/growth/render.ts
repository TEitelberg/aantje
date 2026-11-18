/// <reference lib="dom" />
// DOM builders of the Growth report; user input comes back through callbacks.
import { actionButton, choiceSelect, empty, modeGroup, note, toolbar, whoLine } from '../shell/blocks';
import type { ChartSet } from '../shell/chart-set';
import type { ChartOption } from '../shell/chart-option';
import { el } from '../shell/dom';
import { formatUtc } from '../shell/model';
import type { GrowthActionRequest } from './actions';
import {
  APPROXIMATE_NOTE,
  INLINED_FAILED_NOTE,
  INLINED_NOTE,
  METRICS,
  METRIC_LABEL,
  NO_DATA_NOTE,
  formatDelta,
  formatStep,
  growthOlderNote,
} from './model';
import type { GrowthData, GrowthXAxis, Metric, Step, TableChoice } from './model';
import type { TabId } from './state';

/** The height of the chart; a little more than the charts of the other reports, for the steps of a long history. */
const CHART_PX = 400;

interface DetailView {
  readonly steps: readonly Step[];
  readonly selected: number | undefined;
  readonly table: number | undefined;
  readonly metric: Metric;
  readonly scope: string;
  /** The tab that shows the pane: its hint names the chart or the table. */
  readonly tab: TabId;
}

interface FilterView {
  readonly choices: readonly TableChoice[];
  readonly table: number | undefined;
  readonly metric: Metric;
}

interface FilterHandlers {
  readonly onTable: (table: number | undefined) => void;
  readonly onMetric: (metric: Metric) => void;
}

const HINT: Readonly<Record<TabId, string>> = {
  chart: 'Select a snapshot in the chart to see its actions.',
  snapshots: 'Select a snapshot in the table to see its actions.',
};

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
    ? [heading, chart.charts.box(chart.option, { height: CHART_PX, onItemClick: chart.onItemClick })]
    : [heading, empty('This catalog has no snapshots.')];
}

export function noteChildren(data: GrowthData, steps: readonly Step[]): HTMLElement[] {
  return [
    ...(data.more ? [note(growthOlderNote(data))] : []),
    ...(data.inlinedMore ? [note(INLINED_NOTE, 'warning')] : []),
    ...(data.inlinedFailed ? [note(INLINED_FAILED_NOTE, 'warning')] : []),
    ...(steps.some(({ approximate }) => approximate) ? [note(APPROXIMATE_NOTE)] : []),
    ...(steps.length > 0 && !steps.some(({ changed }) => changed) ? [note(NO_DATA_NOTE)] : []),
  ];
}

/** The pane of the selected snapshot, or the hint to select one. */
export function detailChildren(view: DetailView, ask: (request: GrowthActionRequest) => void): HTMLElement[] {
  const { metric, table } = view;
  const step = view.steps.find(({ id }) => id === view.selected);
  if (!step) {
    return [note(HINT[view.tab])];
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

/** The filters above the tabs: the table, and the value of the key figures and the chart. */
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
  );
}

/** What belongs to the chart only: its x axis. */
export function axisBar(axis: GrowthXAxis, onAxis: (axis: GrowthXAxis) => void): HTMLElement {
  const bar = toolbar(
    modeGroup(
      'X axis',
      [
        { value: 'snapshot' as const, text: 'Snapshots' },
        { value: 'time' as const, text: 'Time' },
      ],
      axis,
      onAxis,
      { className: 'axis', shown: true },
    ),
  );
  bar.setAttribute('aria-label', 'Chart');
  return bar;
}
