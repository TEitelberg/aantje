/// <reference lib="dom" />
// The Chart tab of a result set (grid-client.js): the choices above, a note, and the drawing, which plan-client.js
// makes with ECharts. The rules of the choices are in result-chart.ts, the data in chart-data.ts. Nothing here writes
// markup.
import { el } from '../shell/dom';
import { count, groupedPlural } from '../shell/numbers';
import type { GridColumn, GridValue } from '../data/types';
import { saveAs } from './grid-view';
import type { HostPort } from './grid-view';
import type { AggregateState, ChartMemory } from './protocol';
import {
  adoptChoice,
  AGGREGATES,
  aggregates,
  CHART_TYPES,
  chartUse,
  defaultChoice,
  roleOf,
} from './result-chart';
import type { ChartChoice, ChartType } from './result-chart';
import type { ResultTab } from './result-tab';

/** What a Chart tab shows: the rows of one result set and what the page knows of its statement. */
export interface ChartInput {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridValue[])[];
  /** More rows exist than were loaded. */
  readonly truncated: boolean;
  /** The place of the result set in the run. */
  readonly set: number;
  /** The statement only reads: Aggregate in DuckDB may run it again. */
  readonly readsOnly: boolean;
  /** The name of a saved picture, without its extension. */
  readonly fileStem: string;
}

export interface ChartViewTab extends ResultTab {
  /** The answer of the extension to Aggregate in DuckDB. */
  receive(choice: ChartChoice, state: AggregateState): void;
  /** The choice that the chart draws now. */
  choice(): ChartChoice;
}

// The last choice on this page; a new run of the editor starts from it. The extension keeps it per editor as well.
let memory: ChartMemory | undefined;

/** The chart that the page remembers: the last one chosen on it, else the one the extension kept for the editor. */
export function chartMemory(host: HostPort): ChartMemory | undefined {
  memory ??= host.settings().chart;
  return memory;
}

/** Notes whether the chart was the tab chosen last, and the choice; the extension keeps it for the next page. */
export function rememberChart(host: HostPort, next: ChartMemory): void {
  memory = next;
  host.post({ type: 'chart', memory: next });
}

const sameChoice = (a: ChartChoice, b: ChartChoice): boolean => JSON.stringify(a) === JSON.stringify(b);

function labelled(text: string, control: HTMLElement, title: string): HTMLLabelElement {
  const label = el('label', 'choice');
  label.title = title;
  label.append(el('span', undefined, text), control);
  return label;
}

function select(options: readonly (readonly [string, string])[], value: string): HTMLSelectElement {
  const element = el('select');
  for (const [key, text] of options) {
    const option = el('option', undefined, text);
    option.value = key;
    element.append(option);
  }
  element.value = value;
  return element;
}

function button(text: string, title: string, run: () => void): HTMLButtonElement {
  const made = el('button', undefined, text);
  made.title = title;
  made.addEventListener('click', run);
  return made;
}

const ROW_NUMBER = '\u0000row';
const NONE = '\u0000none';

/** The controls of the choice; `changed` gets what the user changed. */
interface Controls {
  readonly element: HTMLElement;
  readonly copyPng: HTMLButtonElement;
  readonly savePng: HTMLButtonElement;
  /** Shows the choice and enables what the kind of chart uses. */
  show(choice: ChartChoice): void;
}

function chartControls(
  columns: readonly GridColumn[],
  first: ChartChoice,
  changed: (next: Partial<ChartChoice>) => void,
): Controls {
  const named = (role: (column: GridColumn) => boolean): [string, string][] =>
    columns.filter(role).map(({ name }) => [name, name]);
  const numbers = named((column) => roleOf(column) === 'number');
  const type = select(CHART_TYPES, first.type);
  const x = select(
    [[ROW_NUMBER, '(row number)'], ...named((column) => roleOf(column) !== 'other')],
    ROW_NUMBER,
  );
  const series = select(
    [[NONE, '(none)'], ...named((column) => roleOf(column) === 'category' || roleOf(column) === 'time')],
    NONE,
  );
  const size = select([[NONE, '(none)'], ...numbers], NONE);
  const aggregate = select(
    AGGREGATES.map((name) => [name, name]),
    first.aggregate,
  );
  // Y takes several columns: a list of check boxes that opens below its summary.
  const yPick = el('details', 'y-pick');
  const ySummary = el('summary');
  const yList = el('div', 'y-list');
  const yBoxes = numbers.map(([name]) => {
    const box = el('input');
    box.type = 'checkbox';
    const label = el('label');
    label.append(box, el('span', undefined, name));
    yList.append(label);
    box.addEventListener('change', () =>
      changed({ y: yBoxes.filter(({ box: other }) => other.checked).map(({ name: checked }) => checked) }),
    );
    return { name, box };
  });
  yPick.append(ySummary, yList);
  const yLabel = el('span', 'choice');
  yLabel.title = 'The columns with numbers that the chart draws; several give several series';
  yLabel.append(el('span', undefined, 'Y'), yPick);
  const pick = (value: string): string | null => (value === ROW_NUMBER || value === NONE ? null : value);
  type.addEventListener('change', () => changed({ type: type.value as ChartType }));
  x.addEventListener('change', () => changed({ x: pick(x.value) }));
  series.addEventListener('change', () => changed({ series: pick(series.value) }));
  size.addEventListener('change', () => changed({ size: pick(size.value) }));
  aggregate.addEventListener('change', () =>
    changed({ aggregate: aggregate.value as ChartChoice['aggregate'] }),
  );
  const copyPng = button('Copy as PNG', 'Copy the chart to the clipboard as a picture', () => undefined);
  const savePng = button('Save as PNG', 'Save the chart as a PNG file', () => undefined);
  const element = el('div', 'chart-choices');
  element.append(
    labelled('Type', type, 'The kind of chart'),
    labelled('X', x, 'The column along the axis; for a pie its values are the slices'),
    yLabel,
    labelled(
      'Series',
      series,
      'A column whose values split the rows into series of their own colour; for a heatmap the rows',
    ),
    labelled('Size', size, 'The column with the size of each bubble'),
    labelled('Aggregate', aggregate, 'How the rows that share an X become one point'),
    copyPng,
    savePng,
  );
  return {
    element,
    copyPng,
    savePng,
    show: (choice) => {
      const use = chartUse(choice.type);
      type.value = choice.type;
      x.value = choice.x ?? ROW_NUMBER;
      series.value = choice.series ?? NONE;
      size.value = choice.size ?? NONE;
      aggregate.value = choice.aggregate;
      for (const { name, box } of yBoxes) box.checked = choice.y.includes(name);
      ySummary.textContent = choice.y.length === 0 ? '(none)' : choice.y.join(', ');
      x.disabled = !use.x;
      series.disabled = !use.series;
      size.disabled = !use.size;
      aggregate.disabled = !use.aggregate;
    },
  };
}

/** A new kind of chart: one that combines rows starts with a sum, or a count without a number; the others draw each row. */
function withType(choice: ChartChoice, type: ChartType): ChartChoice {
  const combines = chartUse(type).aggregate;
  const aggregate = !combines
    ? 'none'
    : choice.aggregate !== 'none'
      ? choice.aggregate
      : choice.y.length === 0
        ? 'count'
        : 'sum';
  return { ...choice, type, aggregate };
}

type Aggregated = { readonly choice: ChartChoice; readonly state: AggregateState } | undefined;

/** The Chart tab of a result set; it draws once it is on the page. */
export function chartView(host: HostPort, input: ChartInput): ChartViewTab {
  const { columns, rows } = input;
  const remembered = chartMemory(host)?.choice;
  let choice: ChartChoice =
    (remembered && adoptChoice(remembered, columns, rows)) ?? defaultChoice(columns, rows);
  let aggregated: Aggregated;
  let drawn: { resize(): void; dispose(): void; png(): string } | undefined;
  let placed = false;
  const controls = chartControls(columns, choice, (next) => change(next));
  const note = el('div', 'chart-note');
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const box = el('div', 'chart-box');
  const view = el('div', 'chart-view');
  view.append(controls.element, note, box);

  function noteLine(text: string, ...buttons: HTMLButtonElement[]): void {
    note.replaceChildren(el('span', undefined, text), ...buttons);
    note.hidden = false;
  }

  function aggregateInDuckDb(): void {
    aggregated = { choice, state: { status: 'running' } };
    host.post({ type: 'aggregate', set: input.set, choice });
    rowsNote();
  }

  /** What the note says about the rows: loaded only, or all of them from DuckDB. */
  function rowsNote(): void {
    const state = aggregated?.state;
    if (state?.status === 'done') {
      const first = state.truncated ? ' (the first ones only)' : '';
      noteLine(
        `Aggregated by DuckDB over all rows of the result: ${groupedPlural(state.rows.length, 'point')}${first}.`,
      );
    } else if (state?.status === 'running') {
      noteLine(
        'DuckDB runs the statement again and aggregates all its rows...',
        button('Cancel', 'Stop the aggregation', () => host.post({ type: 'cancelCompute' })),
      );
    } else if (state?.status === 'failed') {
      noteLine(state.message);
    } else if (!input.truncated) {
      note.hidden = true;
    } else {
      const loaded = `The chart draws the ${count(rows.length)} rows that were loaded; the result has more.`;
      if (!input.readsOnly) {
        noteLine(`${loaded} The statement does more than read, so aantje does not run it again.`);
      } else if (!aggregates(choice.type) || choice.x === null || choice.aggregate === 'none') {
        noteLine(
          `${loaded} Choose X and how to combine its rows (Aggregate) to aggregate all rows in DuckDB.`,
        );
      } else {
        const title =
          'Run the statement again in the session of the editor and aggregate all its rows by X in DuckDB';
        noteLine(loaded, button('Aggregate in DuckDB', title, aggregateInDuckDb));
      }
    }
  }

  function draw(): void {
    if (!placed) return;
    drawn?.dispose();
    drawn = undefined;
    const drawer = window.aantjePlan?.drawResultChart;
    if (!drawer) {
      box.replaceChildren(el('div', 'summary', 'The chart cannot be drawn on this page.'));
      return;
    }
    const done = aggregated?.state.status === 'done' ? aggregated.state : undefined;
    // The rows of DuckDB are combined already: one per X, the count in a column of its own.
    const result = done
      ? drawer(box, {
          columns: done.columns,
          rows: done.rows,
          choice: { ...choice, aggregate: 'none', y: choice.aggregate === 'count' ? ['count'] : choice.y },
        })
      : drawer(box, { columns, rows, choice });
    drawn = result.chart;
    controls.copyPng.disabled = controls.savePng.disabled = drawn === undefined;
    if (!result.advice) {
      rowsNote();
      return;
    }
    const { suggest } = result.advice;
    const better = suggest && CHART_TYPES.find(([key]) => key === suggest)?.[1];
    const offer =
      suggest && better
        ? [
            button(`Draw as ${better}`, 'Switch to this kind of chart', () =>
              change(withType(choice, suggest)),
            ),
          ]
        : [];
    noteLine(result.advice.text, ...offer);
  }

  function change(next: Partial<ChartChoice>): void {
    choice = next.type && next.type !== choice.type ? withType(choice, next.type) : { ...choice, ...next };
    if (aggregated && !sameChoice(aggregated.choice, choice)) aggregated = undefined;
    controls.show(choice);
    rememberChart(host, { choice, open: true });
    draw();
  }

  async function copyPicture(): Promise<void> {
    const png = drawn?.png();
    if (!png) return;
    try {
      const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) }),
      ]);
      noteLine('Copied the chart as a picture.');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      noteLine(`The picture could not be copied: ${reason}. Save it as PNG instead.`);
    }
  }

  controls.savePng.addEventListener('click', () => {
    const png = drawn?.png();
    if (png) saveAs(host, 'png', png, input.fileStem);
  });
  controls.copyPng.addEventListener('click', () => void copyPicture());
  const observer = new ResizeObserver(() => drawn?.resize());
  observer.observe(box);
  controls.show(choice);
  rowsNote();
  return {
    elements: [view],
    placed: () => {
      placed = true;
      if (drawn) drawn.resize();
      else draw();
    },
    dispose: () => {
      observer.disconnect();
      drawn?.dispose();
    },
    choice: () => choice,
    receive: (asked, state) => {
      if (!sameChoice(asked, choice)) return;
      aggregated = { choice: asked, state };
      if (state.status === 'running') rowsNote();
      else draw();
    },
  };
}
