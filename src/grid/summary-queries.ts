// The SQL of the statistics of the columns, which the extension runs. One aggregate over all rows counts the rows and
// the NULLs and finds the smallest, the largest and the average value, the first and the last text and the counts of
// true and false; one more scan makes the histograms and counts the distinct texts, over a sample when the rows are very
// many, and then Distinct is DuckDB's estimate over all rows instead. Nothing is computed that the grid does not show.
// Column names are data: the columns go by their place; only DuckDB's own type names of dates and times are written.
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { BINS, roleOfType, SAMPLE_ABOVE_ROWS, SAMPLE_ROWS } from './column-summary';
import type { Bin, ColumnStats } from './column-summary';
import { clip, TOOLTIP_CHARS } from './model';

/** Runs one statement and returns its rows as DuckDB gives them (nested values as objects or as JSON text). */
export type SummaryRun = (sql: string) => Promise<readonly (readonly unknown[])[]>;

/** A column of the query by its name and its DuckDB type. */
export interface SummaryColumn {
  readonly name: string;
  readonly type: string;
}

/** A value of DuckDB as text; undefined for NULL. */
function text(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  return typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
    ? value.toString()
    : JSON.stringify(value);
}
const number = (value: unknown): number => Number(value ?? 0);

/** A nested value: an object from DuckDB, or the JSON text that the session made of it. */
function nested(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

const POSITION = (index: number): string => quoteIdentifier(`c${index + 1}`);
const RESULT = 'aantje_result';
const asText = (sql: string): string => `CAST(${sql} AS VARCHAR)`;
const ENDLESS = /infinity/i;

/** One aggregate of a column, and how its value goes into the figures of the column. */
interface Planned {
  readonly sql: string;
  readonly read: (value: unknown, stats: ColumnStats) => ColumnStats;
}

/**
 * An aggregate whose value, as text, becomes `field`; NULL leaves the field out. A `long` text (the first and the last of
 * a text column) is cut to what the tooltip of the grid shows, so that a document in a cell does not travel to the page.
 */
function textual(field: 'min' | 'max' | 'avg', sql: string, long = false): Planned {
  return {
    sql: asText(sql),
    read: (value, current) => {
      const found = text(value);
      if (found === undefined) return current;
      return { ...current, [field]: long ? clip(found, TOOLTIP_CHARS) : found };
    },
  };
}

/** The aggregates over all rows: the NULLs of every column, and what the kind of the column shows besides. */
function totals(stats: ColumnStats, index: number): Planned[] {
  const column = POSITION(index);
  const nulls: Planned = {
    sql: `count(*) - count(${column})`,
    read: (value, current) => ({ ...current, nulls: number(value) }),
  };
  switch (stats.role) {
    case 'number':
    case 'time':
      // DuckDB 2.0 averages a date or a time as one: a DATE gives a TIMESTAMP, a TIME a TIME, a TIMESTAMPTZ its kind.
      return [
        nulls,
        textual('min', `min(${column})`),
        textual('max', `max(${column})`),
        textual('avg', `avg(${column})`),
      ];
    case 'text':
      // First and last in the order of the text, as Power BI shows them for a text column.
      return [
        nulls,
        textual('min', `min(${asText(column)})`, true),
        textual('max', `max(${asText(column)})`, true),
      ];
    case 'boolean':
      return [
        nulls,
        {
          sql: `count_if(${column})`,
          read: (value, current) => ({ ...current, truth: [number(value), current.truth?.[1] ?? 0] }),
        },
        {
          sql: `count_if(NOT ${column})`,
          read: (value, current) => ({ ...current, truth: [current.truth?.[0] ?? 0, number(value)] }),
        },
      ];
    case 'other':
      return [nulls];
  }
}

function bins(value: unknown, upper: (bound: string) => string = (bound) => bound): Bin[] {
  const entries = nested(value);
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { key, value: counted } = entry as Record<string, unknown>;
    const bound = text(key);
    return bound === undefined ? [] : [{ upper: upper(bound), count: number(counted) }];
  });
}

/** Microseconds since midnight as a time of day: `10:15:00`, `23:59:59.5`, `24:00:00`. */
function timeOfDay(micros: string): string {
  const total = Number(micros);
  if (!Number.isSafeInteger(total) || total < 0) return micros;
  const seconds = Math.floor(total / 1_000_000);
  const two = (value: number): string => String(value).padStart(2, '0');
  const fraction = total % 1_000_000;
  const rest = fraction === 0 ? '' : `.${String(fraction).padStart(6, '0').replace(/0+$/, '')}`;
  return `${two(Math.floor(seconds / 3600))}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}${rest}`;
}

/**
 * The histogram of a number, a date or a time, in bins between its smallest and its largest value; none for a column of
 * one value or with an infinite end. Dates and moments are binned as TIMESTAMP, a time of day as microseconds.
 */
function histogram(stats: ColumnStats, index: number): Planned | undefined {
  const { min, max, role, type } = stats;
  if ((role !== 'number' && role !== 'time') || min === undefined || max === undefined || min === max) {
    return undefined;
  }
  const column = POSITION(index);
  const read =
    (upper?: (bound: string) => string): Planned['read'] =>
    (value, current) => ({
      ...current,
      histogram: bins(value, upper),
    });
  const binned = (
    value: string,
    bound: (end: string) => string,
    upper?: (bound: string) => string,
  ): Planned => ({
    sql: `histogram(${value}, equi_width_bins(${bound(min)}, ${bound(max)}, ${BINS}, true))`,
    read: read(upper),
  });
  if (role === 'number') {
    const finite = Number.isFinite(Number.parseFloat(min)) && Number.isFinite(Number.parseFloat(max));
    return finite
      ? binned(`CAST(${column} AS DOUBLE)`, (end) => `CAST(${quoteLiteral(end)} AS DOUBLE)`)
      : undefined;
  }
  if (ENDLESS.test(min) || ENDLESS.test(max)) return undefined;
  // The bounds are the minimum and the maximum in the column's own type, which is one of DuckDB's names of a time.
  const typed = (end: string): string => `CAST(${quoteLiteral(end)} AS ${type})`;
  if (type === 'TIME') {
    return binned(`epoch_us(${column})`, (end) => `epoch_us(${typed(end)})`, timeOfDay);
  }
  // A time with a time zone has no histogram: its values would not fall into bins of times without one.
  if (type !== 'TIME WITH TIME ZONE') {
    return binned(`CAST(${column} AS TIMESTAMP)`, (end) => `CAST(${typed(end)} AS TIMESTAMP)`);
  }
  return undefined;
}

/** The scan after the totals: the histograms, and the exact count of distinct texts when all rows are scanned. */
function details(stats: ColumnStats, index: number, exact: boolean): Planned[] {
  const bars = histogram(stats, index);
  const distinct: Planned[] =
    stats.role === 'text' && exact
      ? [
          {
            sql: `count(DISTINCT ${asText(POSITION(index))})`,
            read: (value, current) => ({ ...current, distinct: number(value) }),
          },
        ]
      : [];
  return [...(bars ? [bars] : []), ...distinct];
}

/** DuckDB's estimate of the distinct texts over all rows (HyperLogLog), when the histograms come from a sample. */
function estimate(stats: ColumnStats, index: number): Planned[] {
  return stats.role === 'text'
    ? [
        {
          sql: `approx_count_distinct(${asText(POSITION(index))})`,
          read: (value, current) => ({ ...current, distinct: number(value), estimated: true }),
        },
      ]
    : [];
}

/** An average of a date or a moment with an infinite end means nothing: DuckDB returns a date far in the future. */
function withoutEndlessAverage(stats: ColumnStats): ColumnStats {
  if (stats.role !== 'time' || !(ENDLESS.test(stats.min ?? '') || ENDLESS.test(stats.max ?? '')))
    return stats;
  const { avg: _avg, ...rest } = stats;
  return rest;
}

/**
 * Runs the aggregates that `plan` gives the columns in one SELECT over `from`, `lead` first, and reads their values into
 * the figures; nothing runs when there is nothing to compute. The value of `lead`.
 */
async function scan(
  run: SummaryRun,
  columns: readonly ColumnStats[],
  plan: (stats: ColumnStats, index: number) => readonly Planned[],
  from: string,
  lead?: string,
): Promise<{ readonly columns: ColumnStats[]; readonly lead: unknown }> {
  const planned = columns.flatMap((stats, index) => plan(stats, index).map((step) => ({ index, step })));
  if (planned.length === 0 && lead === undefined) return { columns: [...columns], lead: undefined };
  const expressions = [...(lead === undefined ? [] : [lead]), ...planned.map(({ step }) => step.sql)];
  const [values = []] = await run(
    `SELECT ${expressions.map((sql, position) => `${sql} AS a${position + 1}`).join(', ')} ${from}`,
  );
  const offset = lead === undefined ? 0 : 1;
  const next = [...columns];
  planned.forEach(({ index, step }, position) => {
    const stats = next[index];
    if (stats) next[index] = step.read(values[position + offset], stats);
  });
  return { columns: next, lead: lead === undefined ? undefined : values[0] };
}

/**
 * The statistics of the columns of `query` (a statement that only reads), by the statements that `run` runs. `columns`
 * are the columns of the query, when the caller knows them; else DuckDB describes the query first. The rows counted, the
 * rows of the sample when there is one, and the figures of each column.
 */
export async function summarize(
  run: SummaryRun,
  query: string,
  columns?: readonly SummaryColumn[],
): Promise<{ readonly rows: number; readonly sample?: number; readonly columns: readonly ColumnStats[] }> {
  const described =
    columns ??
    (await run(`DESCRIBE (\n${query}\n)`)).map(([name, type]) => ({
      name: String(name),
      type: String(type),
    }));
  const start: ColumnStats[] = described.map(({ name, type }) => ({
    name,
    type,
    role: roleOfType(type),
    nulls: 0,
  }));
  const names = start.map((_, index) => POSITION(index)).join(', ');
  const all = `FROM (\n${query}\n) AS ${RESULT}(${names})`;
  const totalled = await scan(run, start, totals, all, 'count(*)');
  const rows = number(totalled.lead);
  const percent = rows > SAMPLE_ABOVE_ROWS ? (SAMPLE_ROWS / rows) * 100 : undefined;
  const from =
    percent === undefined
      ? all
      : `FROM (SELECT * FROM (\n${query}\n) AS aantje_all USING SAMPLE ${percent.toFixed(4)} PERCENT (bernoulli)) AS ${RESULT}(${names})`;
  const exact = percent === undefined;
  const detailed = await scan(
    run,
    totalled.columns.map(withoutEndlessAverage),
    (stats, index) => details(stats, index, exact),
    from,
  );
  // Over a sample, the distinct texts are DuckDB's estimate over all rows instead.
  const found = exact ? detailed.columns : (await scan(run, detailed.columns, estimate, all)).columns;
  return {
    rows,
    ...(percent === undefined ? {} : { sample: Math.round((rows * percent) / 100) }),
    columns: found,
  };
}
