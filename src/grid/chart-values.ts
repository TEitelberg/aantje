// The values of a chart of a result: numbers with their exact text, the exact sums of BIGINT and DECIMAL, and what the
// kinds of chart share to group the rows. Pure, for plan-client.js.
import type { GridColumn, GridValue } from '../data/types';
import { cellText } from './model';
import { roleOf } from './result-chart';
import type { Aggregate, ChartChoice, ChartType, Rows } from './result-chart';

/** A value of a point: the number that is drawn and the exact text that the tooltip shows (BIGINT, DECIMAL). */
export interface Value {
  readonly value: number;
  readonly text: string;
}

export interface CartesianSeries {
  readonly name: string;
  /** For a category axis one value per category (null for none), else one point per row: [x, value]. */
  readonly values: readonly (Value | null)[];
  readonly points: readonly {
    readonly x: number;
    readonly xText: string;
    readonly y: Value;
    readonly size?: Value;
  }[];
  /** Combo: the second Y is a line on a second axis. */
  readonly line?: boolean;
}

export type XAxisKind = 'category' | 'time' | 'value';

export type PreparedChart =
  | {
      readonly kind: 'cartesian';
      readonly type: ChartType;
      readonly xAxis: XAxisKind;
      readonly xName: string;
      readonly categories: readonly string[];
      readonly series: readonly CartesianSeries[];
      /** The text of each series' Y column, for the axis name. */
      readonly yName: string;
    }
  | {
      readonly kind: 'pie';
      readonly donut: boolean;
      readonly name: string;
      readonly slices: readonly { readonly name: string; readonly value: Value }[];
    }
  | {
      readonly kind: 'heatmap';
      readonly name: string;
      readonly xName: string;
      readonly yName: string;
      readonly xs: readonly string[];
      readonly ys: readonly string[];
      readonly cells: readonly { readonly x: number; readonly y: number; readonly value: Value }[];
    }
  | {
      readonly kind: 'histogram';
      readonly name: string;
      readonly bins: readonly { readonly from: number; readonly to: number; readonly count: number }[];
    }
  | {
      readonly kind: 'boxplot';
      readonly name: string;
      readonly xName: string;
      readonly categories: readonly string[];
      /** min, first quartile, median, third quartile, max; and the values in the box. */
      readonly boxes: readonly { readonly stats: readonly number[]; readonly count: number }[];
    }
  | {
      readonly kind: 'calendar';
      readonly name: string;
      readonly years: readonly number[];
      readonly days: readonly { readonly day: string; readonly value: Value }[];
    };

/** Why a chart is not drawn, and a kind of chart that would do better. */
export interface ChartAdvice {
  readonly text: string;
  readonly suggest?: ChartType;
}

/** Above these a chart becomes a mess: it suggests another kind instead of drawing. */
export const LIMITS = {
  slices: 50,
  categories: 1000,
  series: 24,
  heatmapCells: 20_000,
  points: 50_000,
  boxes: 200,
  calendarYears: 3,
} as const;

const NULL_LABEL = '(null)';

/** The label of an X value: its text, `(null)` for NULL. */
export function label(value: GridValue, column: GridColumn): string {
  return value === null ? NULL_LABEL : cellText(value, column.kind).text;
}

/** The number of a value and its exact text; undefined for NULL or what is no number. */
export function numberOf(value: GridValue): Value | undefined {
  if (value === null || typeof value === 'boolean') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? { value: parsed, text: String(value) } : undefined;
}

/** A moment as milliseconds: DuckDB writes a date, a timestamp, and one with an offset such as `+01`. */
export function timeOf(text: string): number {
  const iso = text.replace(' ', 'T').replace(/(T[\d:.]+[+-]\d\d)$/, '$1:00');
  return Date.parse(/^\d{4}-\d\d-\d\d$/.test(iso) ? `${iso}T00:00:00` : iso);
}

// ---- Exact sums of BIGINT and DECIMAL -------------------------------------------------------------------------------

const PLAIN = /^(-?)(\d+)(?:\.(\d+))?$/;

/** An exact decimal: digits as a big integer and the places after the point. */
interface Exact {
  readonly digits: bigint;
  readonly scale: number;
}

function exactOf(text: string): Exact | undefined {
  const match = PLAIN.exec(text);
  if (!match) return undefined;
  const fraction = match[3] ?? '';
  const digits = BigInt(`${match[2] ?? '0'}${fraction}`);
  return { digits: match[1] === '-' ? -digits : digits, scale: fraction.length };
}

function rescale(value: Exact, scale: number): bigint {
  return value.digits * 10n ** BigInt(scale - value.scale);
}

function exactText({ digits, scale }: Exact): string {
  const negative = digits < 0n;
  const plain = (negative ? -digits : digits).toString().padStart(scale + 1, '0');
  const text = scale === 0 ? plain : `${plain.slice(0, -scale)}.${plain.slice(-scale)}`;
  return negative ? `-${text}` : text;
}

/** Combines the values of rows that share an X; the text stays exact for sum, min and max of whole and decimal numbers. */
export function aggregate(values: readonly Value[], how: Exclude<Aggregate, 'none'>, rows: number): Value {
  if (how === 'count') return { value: rows, text: String(rows) };
  if (values.length === 0) return { value: Number.NaN, text: 'NULL' };
  if (how === 'avg') {
    const average = values.reduce((sum, { value }) => sum + value, 0) / values.length;
    return { value: average, text: String(average) };
  }
  const exact = values.map(({ text }) => exactOf(text));
  if (exact.every((value): value is Exact => value !== undefined)) {
    const scale = exact.reduce((most, value) => Math.max(most, value.scale), 0);
    const scaled = exact.map((value) => rescale(value, scale));
    const result =
      how === 'sum'
        ? scaled.reduce((sum, value) => sum + value, 0n)
        : scaled.reduce((best, value) => ((how === 'min' ? value < best : value > best) ? value : best));
    const text = exactText({ digits: result, scale });
    return { value: Number(text), text };
  }
  const numbers = values.map(({ value }) => value);
  const result =
    how === 'sum'
      ? numbers.reduce((sum, value) => sum + value, 0)
      : numbers.reduce((best, value) => ((how === 'min' ? value < best : value > best) ? value : best));
  return { value: result, text: String(result) };
}

export interface Columns {
  readonly x: number;
  readonly y: readonly number[];
  readonly series: number;
  readonly size: number;
}

export function indexes(columns: readonly GridColumn[], choice: ChartChoice): Columns {
  const at = (name: string | null): number =>
    name === null ? -1 : columns.findIndex((column) => column.name === name);
  return {
    x: at(choice.x),
    y: choice.y.map(at).filter((index) => index >= 0 && roleOf(columns[index] as GridColumn) === 'number'),
    series: at(choice.series),
    size: at(choice.size),
  };
}

/** The rows grouped by a key, in the order in which each key first appears. */
export function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

/**
 * The data of the chart of `choice` over the loaded rows, or the advice why it is not drawn: a column it needs is not
 * chosen, or there would be too many slices, categories, series or points to read.
 */
export function nameOf(columns: readonly GridColumn[], index: number): string {
  return columns[index]?.name ?? '';
}

export function aggregatedValue(
  rows: Rows,
  column: number | undefined,
  how: Exclude<Aggregate, 'none'>,
): Value | null {
  const values = column === undefined ? [] : rows.flatMap((row) => numberOf(row[column] ?? null) ?? []);
  const result = aggregate(values, how, rows.length);
  return Number.isFinite(result.value) ? result : null;
}
