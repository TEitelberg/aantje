// The chart of a result: which column goes where (the choice), its defaults, and the data that a chart of the loaded
// rows draws. Pure, for the page (grid-client.js offers the choices) and for plan-client.js, which draws with ECharts.
import type { GridColumn, GridValue } from '../data/types';

/** The kinds of chart, in the order of the menu, with their names. */
export const CHART_TYPES = [
  ['bar', 'Bar'],
  ['bar-horizontal', 'Bar, horizontal'],
  ['bar-stacked', 'Bar, stacked'],
  ['line', 'Line'],
  ['area', 'Area, stacked'],
  ['scatter', 'Scatter'],
  ['bubble', 'Bubble'],
  ['pie', 'Pie'],
  ['donut', 'Donut'],
  ['combo', 'Bar and line'],
  ['heatmap', 'Heatmap'],
  ['histogram', 'Histogram'],
  ['boxplot', 'Box plot'],
  ['calendar', 'Calendar heatmap'],
] as const;

export type ChartType = (typeof CHART_TYPES)[number][0];

/** How the values of rows that share an X become one point. */
export const AGGREGATES = ['none', 'sum', 'count', 'avg', 'min', 'max'] as const;

export type Aggregate = (typeof AGGREGATES)[number];

/** Which column goes where. Columns go by name; `x` null is the row number. */
export interface ChartChoice {
  readonly type: ChartType;
  readonly x: string | null;
  readonly y: readonly string[];
  /** A column whose values split the rows into series; for a heatmap, its rows. */
  readonly series: string | null;
  /** The size of a bubble. */
  readonly size: string | null;
  readonly aggregate: Aggregate;
}

/** What the controls of a kind of chart are used for. */
export interface ChartUse {
  readonly x: boolean;
  /** How many Y columns the chart draws; `Infinity` for one series each. */
  readonly y: number;
  readonly series: boolean;
  readonly size: boolean;
  readonly aggregate: boolean;
}

const USES: Readonly<Record<ChartType, ChartUse>> = {
  bar: { x: true, y: Infinity, series: true, size: false, aggregate: true },
  'bar-horizontal': { x: true, y: Infinity, series: true, size: false, aggregate: true },
  'bar-stacked': { x: true, y: Infinity, series: true, size: false, aggregate: true },
  line: { x: true, y: Infinity, series: true, size: false, aggregate: true },
  area: { x: true, y: Infinity, series: true, size: false, aggregate: true },
  scatter: { x: true, y: Infinity, series: true, size: false, aggregate: false },
  bubble: { x: true, y: 1, series: true, size: true, aggregate: false },
  pie: { x: true, y: 1, series: false, size: false, aggregate: true },
  donut: { x: true, y: 1, series: false, size: false, aggregate: true },
  combo: { x: true, y: 2, series: false, size: false, aggregate: true },
  heatmap: { x: true, y: 1, series: true, size: false, aggregate: true },
  histogram: { x: false, y: 1, series: false, size: false, aggregate: false },
  boxplot: { x: true, y: 1, series: false, size: false, aggregate: false },
  calendar: { x: true, y: 1, series: false, size: false, aggregate: true },
};

export const chartUse = (type: ChartType): ChartUse => USES[type];

/** The kinds of chart whose points come from the rows of one X: Aggregate in DuckDB can make them from all rows. */
export const aggregates = (type: ChartType): boolean => USES[type].aggregate;

/** The role of a column in a chart: a number, a moment in time, a category, or something it cannot draw. */
export type ColumnRole = 'number' | 'time' | 'category' | 'other';

/** The DuckDB types of a date or a moment, which a time axis draws. */
export const TIME_TYPE = /^(DATE|TIMESTAMP(_S|_MS|_NS)?|TIMESTAMP WITH TIME ZONE|TIMESTAMPTZ)$/;

export function roleOf(column: Pick<GridColumn, 'type' | 'kind'>): ColumnRole {
  if (column.kind === 'number') return 'number';
  if (column.kind === 'nested') return 'other';
  return TIME_TYPE.test(column.type) ? 'time' : 'category';
}

/** The rows of a result as the page has them. */
export type Rows = readonly (readonly GridValue[])[];

/**
 * The chart that appears without a click: X the first date or time column, else the first text column, else the row
 * number; Y the first number that is not X; a line over time, bars over categories. Without any number the chart
 * counts the rows of each X. Rows that share an X are summed.
 */
export function defaultChoice(columns: readonly GridColumn[], rows: Rows): ChartChoice {
  const roles = columns.map(roleOf);
  const time = roles.indexOf('time');
  const category = roles.indexOf('category');
  const xIndex = time >= 0 ? time : category;
  const x = columns[xIndex]?.name ?? null;
  const y = columns.find((_, index) => roles[index] === 'number' && index !== xIndex)?.name;
  const repeats = xIndex >= 0 && new Set(rows.map((row) => row[xIndex] ?? null)).size < rows.length;
  return {
    type: x !== null && roles[xIndex] === 'category' ? 'bar' : 'line',
    x,
    y: y === undefined ? [] : [y],
    series: null,
    size: null,
    aggregate: y === undefined && x !== null ? 'count' : repeats ? 'sum' : 'none',
  };
}

/**
 * A choice made for another result (an earlier run of the editor) applied to these columns: what still exists by name
 * stays, the rest comes from the defaults. Undefined when nothing of it fits.
 */
export function adoptChoice(
  remembered: ChartChoice,
  columns: readonly GridColumn[],
  rows: Rows,
): ChartChoice | undefined {
  const named = (name: string | null): GridColumn | undefined =>
    name === null ? undefined : columns.find((column) => column.name === name);
  const fallback = defaultChoice(columns, rows);
  const x = remembered.x === null ? null : named(remembered.x)?.name;
  const y = remembered.y.filter((name) => {
    const column = named(name);
    return column !== undefined && roleOf(column) === 'number';
  });
  if (x === undefined && y.length === 0) return undefined;
  return {
    type: remembered.type,
    x: x === undefined ? fallback.x : x,
    y: y.length > 0 || remembered.aggregate === 'count' ? y : fallback.y,
    series: named(remembered.series)?.name ?? null,
    size: named(remembered.size)?.name ?? null,
    aggregate: remembered.aggregate,
  };
}
