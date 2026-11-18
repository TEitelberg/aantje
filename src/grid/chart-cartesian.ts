// The data of a chart on two axes (bars, lines, areas, points, bubbles, bar and line): one value per category, or one
// point per row or X on a time or value axis. Pure, for plan-client.js.
import type { GridColumn, GridValue } from '../data/types';
import { aggregatedValue, groupBy, label, LIMITS, nameOf, numberOf, timeOf } from './chart-values';
import type { CartesianSeries, ChartAdvice, Columns, PreparedChart, Value, XAxisKind } from './chart-values';
import { chartUse, roleOf } from './result-chart';
import type { Aggregate, ChartChoice, Rows } from './result-chart';

type Member = { readonly row: readonly GridValue[]; readonly index: number };

/** What the two kinds of axis share: the rows split into series, and the X of a row. */
interface Context {
  readonly rows: Rows;
  readonly choice: ChartChoice;
  readonly at: Columns;
  readonly ys: readonly number[];
  readonly yNames: readonly string[];
  /** How the rows of one X combine; undefined to draw each row. */
  readonly how: Exclude<Aggregate, 'none'> | undefined;
  readonly splits: Map<string, Member[]>;
  readonly split: boolean;
  readonly xValue: (member: Member) => number;
  readonly xText: (member: Member) => string;
  readonly seriesName: (split: string, y: string) => string;
}

/** Bars stand on categories; lines and points on a time or value axis when X is one. */
function axisOf(
  choice: ChartChoice,
  role: string,
  times: readonly number[],
  rows: Rows,
  x: number,
): XAxisKind {
  const bars = ['bar', 'bar-horizontal', 'bar-stacked', 'combo'].includes(choice.type);
  // A moment that does not parse (a year before 1 or after 9999) puts the times on a category axis.
  const parsed = times.every((time, index) => Number.isFinite(time) || rows[index]?.[x] === null);
  if (bars || role === 'category' || role === 'other' || (role === 'time' && !parsed)) return 'category';
  return role === 'time' ? 'time' : 'value';
}

export function cartesian(
  columns: readonly GridColumn[],
  rows: Rows,
  choice: ChartChoice,
  at: Columns,
  ys: readonly number[],
): PreparedChart | ChartAdvice {
  const xColumn = columns[at.x];
  const role = xColumn ? roleOf(xColumn) : 'number';
  const times = role === 'time' ? rows.map((row) => timeOf(String(row[at.x] ?? ''))) : [];
  const xAxis = axisOf(choice, role, times, rows, at.x);
  const seriesColumn = columns[at.series];
  const members = rows.map((row, index) => ({ row, index }));
  const splits = seriesColumn
    ? groupBy(members, ({ row }) => label(row[at.series] ?? null, seriesColumn))
    : new Map([['', members]]);
  if (splits.size * Math.max(ys.length, 1) > LIMITS.series) {
    return {
      text: `${splits.size} series are too many to tell apart. Colour by a column with fewer values, or by none.`,
    };
  }
  const yNames = ys.length === 0 ? ['count'] : ys.map((index) => nameOf(columns, index));
  const context: Context = {
    rows,
    choice,
    at,
    ys,
    yNames,
    how: chartUse(choice.type).aggregate && choice.aggregate !== 'none' ? choice.aggregate : undefined,
    splits,
    split: seriesColumn !== undefined,
    xValue: ({ row, index }) =>
      at.x < 0 ? index + 1 : role === 'time' ? (times[index] ?? Number.NaN) : Number(row[at.x] ?? Number.NaN),
    xText: ({ row, index }) => (xColumn ? label(row[at.x] ?? null, xColumn) : String(index + 1)),
    seriesName: (split, y) => (seriesColumn ? (yNames.length > 1 ? `${split} · ${y}` : split) : y),
  };
  const drawn = xAxis === 'category' ? onCategories(context) : onAxis(context);
  if (!('series' in drawn)) return drawn;
  return {
    kind: 'cartesian',
    type: choice.type,
    xAxis,
    xName: xColumn?.name ?? '#',
    categories: drawn.categories,
    series: drawn.series,
    yName: choice.type === 'combo' ? (yNames[0] ?? '') : yNames.join(', '),
  };
}

interface Drawn {
  readonly categories: readonly string[];
  readonly series: readonly CartesianSeries[];
}

/** One category per X value when rows are combined or split into series, else one per row. */
function onCategories(context: Context): Drawn | ChartAdvice {
  const { rows, choice, ys, how, splits, split, xText } = context;
  const keyed = rows.map((row, index) => xText({ row, index }));
  const categories = how || split ? [...new Set(keyed)] : keyed;
  if (categories.length > LIMITS.categories) {
    return {
      text: `${categories.length} categories are too many for bars. Combine the rows of each X (Aggregate), or draw a line.`,
      suggest: 'line',
    };
  }
  if (!how && split && [...splits.values()].some((members) => repeats(members.map(xText)))) {
    return { text: 'X repeats within a series. Choose how to combine the rows of each X (Aggregate).' };
  }
  const position = new Map(categories.map((category, index) => [category, index]));
  const series: CartesianSeries[] = [];
  for (const [name, members] of splits) {
    context.yNames.forEach((yName, yIndex) => {
      const values: (Value | null)[] = categories.map(() => null);
      const y = ys[yIndex];
      if (how || split) {
        for (const [key, group] of groupBy(members, xText)) {
          const where = position.get(key);
          const groupRows = group.map(({ row }) => row);
          if (where !== undefined) {
            values[where] = how
              ? aggregatedValue(groupRows, y, how)
              : (numberOf(groupRows[0]?.[y ?? -1] ?? null) ?? null);
          }
        }
      } else {
        for (const { row, index } of members) values[index] = numberOf(row[y ?? -1] ?? null) ?? null;
      }
      series.push({
        name: context.seriesName(name, yName),
        values,
        points: [],
        ...(choice.type === 'combo' && yIndex === 1 ? { line: true } : {}),
      });
    });
  }
  return { categories, series };
}

/** One point per row, or per X when rows are combined; lines in the order of X, so that they do not zigzag. */
function onAxis(context: Context): Drawn | ChartAdvice {
  const { choice, at, ys, how, splits, xValue, xText } = context;
  if (choice.type === 'bubble' && at.size < 0) {
    return { text: 'Choose a column with numbers for the size of the bubbles.' };
  }
  const series: CartesianSeries[] = [];
  let count = 0;
  for (const [name, members] of splits) {
    context.yNames.forEach((yName, yIndex) => {
      const y = ys[yIndex];
      const points = how
        ? [...groupBy(members, (member) => String(xValue(member)))].flatMap(([, group]) => {
            const first = group[0];
            const value = aggregatedValue(
              group.map(({ row }) => row),
              y,
              how,
            );
            return first && value ? [{ x: xValue(first), xText: xText(first), y: value }] : [];
          })
        : members.flatMap((member) => {
            const value = numberOf(member.row[y ?? -1] ?? null);
            const size = at.size >= 0 ? numberOf(member.row[at.size] ?? null) : undefined;
            const x = xValue(member);
            return value && Number.isFinite(x)
              ? [{ x, xText: xText(member), y: value, ...(size ? { size } : {}) }]
              : [];
          });
      count += points.length;
      series.push({
        name: context.seriesName(name, yName),
        values: [],
        points:
          choice.type === 'line' || choice.type === 'area' ? points.toSorted((a, b) => a.x - b.x) : points,
      });
    });
  }
  if (count > LIMITS.points) {
    return {
      text: `${count} points are too many to draw well. A histogram shows how the values spread.`,
      suggest: 'histogram',
    };
  }
  return { categories: [], series };
}

function repeats(keys: readonly string[]): boolean {
  return new Set(keys).size < keys.length;
}
