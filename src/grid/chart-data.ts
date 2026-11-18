// The data that a chart of the loaded rows draws, or the advice why it is not drawn. Pure, for plan-client.js; the
// choice and its defaults are in result-chart.ts, the values in chart-values.ts.
import type { GridColumn, GridValue } from '../data/types';
import { cartesian } from './chart-cartesian';
import { aggregatedValue, groupBy, indexes, label, LIMITS, nameOf, numberOf } from './chart-values';
import type { ChartAdvice, Columns, PreparedChart, Value } from './chart-values';
import { chartUse, roleOf } from './result-chart';
import type { Aggregate, ChartChoice, Rows } from './result-chart';

export function prepareChart(
  columns: readonly GridColumn[],
  rows: Rows,
  choice: ChartChoice,
): PreparedChart | ChartAdvice {
  const at = indexes(columns, choice);
  const use = chartUse(choice.type);
  const counting = use.aggregate && choice.aggregate === 'count';
  const ys = at.y.slice(0, use.y === Infinity ? undefined : use.y);
  if (ys.length === 0 && !counting) {
    return { text: 'Choose a column with numbers for Y.' };
  }
  if (rows.length === 0) return { text: 'The result has no rows to draw.' };
  switch (choice.type) {
    case 'histogram':
      return histogram(columns, rows, ys[0] ?? -1);
    case 'boxplot':
      return boxplot(columns, rows, at.x, ys[0] ?? -1);
    case 'pie':
    case 'donut':
      return pie(columns, rows, choice, at.x, ys[0]);
    case 'heatmap':
      return heatmap(columns, rows, choice, at, ys[0]);
    case 'calendar':
      return calendar(columns, rows, choice, at.x, ys[0]);
    default:
      if (choice.type === 'combo' && ys.length < 2 && !counting) {
        return { text: 'Bar and line needs two columns for Y: the bars, then the line on a second axis.' };
      }
      return cartesian(columns, rows, choice, at, counting ? [] : ys);
  }
}

/** The values of each X combined: Pie, Calendar and Heatmap draw one value per X (and row). */
function combined(
  rows: Rows,
  key: (row: readonly GridValue[], index: number) => string,
  y: number | undefined,
  how: Aggregate,
): { readonly key: string; readonly value: Value | null; readonly rows: number }[] {
  const keyed = rows.map((row, index) => ({ row, key: key(row, index) }));
  return [...groupBy(keyed, ({ key: name }) => name)].map(([name, group]) => {
    const groupRows = group.map(({ row }) => row);
    const value =
      how === 'none'
        ? group.length === 1
          ? (numberOf(groupRows[0]?.[y ?? -1] ?? null) ?? null)
          : null
        : aggregatedValue(groupRows, y, how);
    return { key: name, value, rows: group.length };
  });
}

function pie(
  columns: readonly GridColumn[],
  rows: Rows,
  choice: ChartChoice,
  x: number,
  y: number | undefined,
): PreparedChart | ChartAdvice {
  const xColumn = columns[x];
  if (!xColumn) return { text: 'Choose a column for X: its values are the slices.' };
  const groups = combined(rows, (row) => label(row[x] ?? null, xColumn), y, choice.aggregate);
  if (choice.aggregate === 'none' && groups.some((group) => group.rows > 1)) {
    return { text: 'X repeats. Choose how to combine the rows of each slice (Aggregate).' };
  }
  if (groups.length > LIMITS.slices) {
    return { text: `${groups.length} slices are too many for a pie. Bars show them better.`, suggest: 'bar' };
  }
  return {
    kind: 'pie',
    donut: choice.type === 'donut',
    name: y === undefined ? 'count' : nameOf(columns, y),
    slices: groups.flatMap(({ key, value }) => (value && value.value >= 0 ? [{ name: key, value }] : [])),
  };
}

function heatmap(
  columns: readonly GridColumn[],
  rows: Rows,
  choice: ChartChoice,
  at: Columns,
  y: number | undefined,
): PreparedChart | ChartAdvice {
  const xColumn = columns[at.x];
  const rowColumn = columns[at.series];
  if (!xColumn || !rowColumn) {
    return { text: 'A heatmap needs two categories: X for the columns and Series for the rows.' };
  }
  const xs = [...new Set(rows.map((row) => label(row[at.x] ?? null, xColumn)))];
  const ys = [...new Set(rows.map((row) => label(row[at.series] ?? null, rowColumn)))];
  if (xs.length * ys.length > LIMITS.heatmapCells) {
    return {
      text: `${xs.length} by ${ys.length} cells are too many for a heatmap. Choose columns with fewer values.`,
    };
  }
  const groups = combined(
    rows,
    (row) => JSON.stringify([label(row[at.x] ?? null, xColumn), label(row[at.series] ?? null, rowColumn)]),
    y,
    choice.aggregate,
  );
  if (choice.aggregate === 'none' && groups.some((group) => group.rows > 1)) {
    return { text: 'A cell has more than one row. Choose how to combine them (Aggregate).' };
  }
  const xPlace = new Map(xs.map((name, index) => [name, index]));
  const yPlace = new Map(ys.map((name, index) => [name, index]));
  return {
    kind: 'heatmap',
    name: y === undefined ? 'count' : nameOf(columns, y),
    xName: xColumn.name,
    yName: rowColumn.name,
    xs,
    ys,
    cells: groups.flatMap(({ key, value }) => {
      const [xName, yName] = JSON.parse(key) as [string, string];
      const xIndex = xPlace.get(xName);
      const yIndex = yPlace.get(yName);
      return value && xIndex !== undefined && yIndex !== undefined ? [{ x: xIndex, y: yIndex, value }] : [];
    }),
  };
}

function calendar(
  columns: readonly GridColumn[],
  rows: Rows,
  choice: ChartChoice,
  x: number,
  y: number | undefined,
): PreparedChart | ChartAdvice {
  const xColumn = columns[x];
  if (!xColumn || roleOf(xColumn) !== 'time') {
    return { text: 'A calendar heatmap needs a date or timestamp column for X.' };
  }
  const dated = rows.filter((row) => row[x] !== null && /^\d{4}-\d\d-\d\d/.test(String(row[x])));
  const days = combined(dated, (row) => String(row[x]).slice(0, 10), y, choice.aggregate);
  if (choice.aggregate === 'none' && days.some((day) => day.rows > 1)) {
    return {
      text: 'A day has more than one row. Choose how to combine them (Aggregate), for example count.',
    };
  }
  const years = [...new Set(days.map(({ key }) => Number(key.slice(0, 4))))].toSorted((a, b) => a - b);
  if (years.length > LIMITS.calendarYears) {
    return {
      text: `The days span ${years.length} years, too many for a calendar. A line shows them better.`,
      suggest: 'line',
    };
  }
  if (years.length === 0) return { text: 'The result has no dates to draw.' };
  return {
    kind: 'calendar',
    name: y === undefined ? 'count' : nameOf(columns, y),
    years,
    days: days.flatMap(({ key, value }) => (value ? [{ day: key, value }] : [])),
  };
}

function histogram(columns: readonly GridColumn[], rows: Rows, y: number): PreparedChart | ChartAdvice {
  const values = rows.flatMap((row) => numberOf(row[y] ?? null)?.value ?? []);
  if (values.length === 0) return { text: 'The column has no numbers to count.' };
  const min = values.reduce((low, value) => Math.min(low, value));
  const max = values.reduce((high, value) => Math.max(high, value));
  const wanted = Math.min(50, Math.max(5, Math.ceil(Math.log2(values.length) + 1)));
  const width = niceWidth((max - min) / wanted);
  const start = width > 0 ? Math.floor(min / width) * width : min;
  const count = width > 0 ? Math.max(1, Math.ceil((max - start) / width + 1e-9)) : 1;
  const bins = Array.from({ length: count }, (_, index) => ({
    from: start + index * width,
    to: start + (index + 1) * width,
    count: 0,
  }));
  for (const value of values) {
    const index = width > 0 ? Math.min(count - 1, Math.floor((value - start) / width)) : 0;
    const bin = bins[index];
    if (bin) bin.count++;
  }
  return { kind: 'histogram', name: nameOf(columns, y), bins };
}

/** A bin width of 1, 2 or 5 times a power of ten, at least `raw`. */
function niceWidth(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 0;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find((factor) => factor * power >= raw) ?? 10;
  return step * power;
}

/** The quantile of sorted values with linear interpolation, as DuckDB's `quantile_cont`. */
function quantile(sorted: readonly number[], share: number): number {
  const position = (sorted.length - 1) * share;
  const below = Math.floor(position);
  const low = sorted[below] ?? 0;
  const high = sorted[Math.min(below + 1, sorted.length - 1)] ?? low;
  return low + (high - low) * (position - below);
}

function boxplot(
  columns: readonly GridColumn[],
  rows: Rows,
  x: number,
  y: number,
): PreparedChart | ChartAdvice {
  const xColumn = columns[x];
  const groups = groupBy(rows, (row) => (xColumn ? label(row[x] ?? null, xColumn) : nameOf(columns, y)));
  if (groups.size > LIMITS.boxes) {
    return { text: `${groups.size} boxes are too many to compare. Choose a column with fewer values for X.` };
  }
  const categories: string[] = [];
  const boxes: { stats: number[]; count: number }[] = [];
  for (const [name, group] of groups) {
    const values = group.flatMap((row) => numberOf(row[y] ?? null)?.value ?? []).toSorted((a, b) => a - b);
    if (values.length === 0) continue;
    categories.push(name);
    boxes.push({
      stats: [0, 0.25, 0.5, 0.75, 1].map((share) => quantile(values, share)),
      count: values.length,
    });
  }
  if (boxes.length === 0) return { text: 'The column has no numbers to draw.' };
  return { kind: 'boxplot', name: nameOf(columns, y), xName: xColumn?.name ?? '', categories, boxes };
}
