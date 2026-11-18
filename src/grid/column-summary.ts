// The statistics of the columns of a result or a table, computed by DuckDB, never in the page (summary-queries.ts): what
// they hold, and the lines and the Markdown that the page shows and copies. In Markdown every name and value is escaped.
import { kindOf } from '../data/grid-values';
import { markdownCell, markdownHead, markdownRow } from '../export/markdown';
import { approximateCount, count, groupedPlural } from '../shell/numbers';
import { TIME_TYPE } from './result-chart';

/** What a column is to the statistics. */
export type SummaryRole = 'number' | 'time' | 'text' | 'boolean' | 'other';

/** One bar of a histogram: the values up to `upper` (DuckDB's bins hold the values up to their bound). */
export interface Bin {
  readonly upper: string;
  readonly count: number;
}

export interface ColumnStats {
  readonly name: string;
  readonly type: string;
  readonly role: SummaryRole;
  /** How many values are NULL, counted over all rows. */
  readonly nulls: number;
  /** Numbers, dates and times: the smallest and the largest value. Text: the first and the last in alphabetical order. */
  readonly min?: string;
  readonly max?: string;
  /** Numbers, dates and times: the average, as DuckDB's `avg` gives it (a date or time for a date or time). */
  readonly avg?: string;
  /** Text: how many distinct values; DuckDB's estimate (HyperLogLog) when `estimated`. */
  readonly distinct?: number;
  readonly estimated?: boolean;
  readonly histogram?: readonly Bin[];
  /** Booleans: how many values are true and false. */
  readonly truth?: readonly [number, number];
}

/** What the figures cover. */
export type SummaryCover =
  /** The whole result: the statement ran again in the session of the editor. */
  | { readonly kind: 'result'; readonly rows: number; readonly sample?: number }
  /** The whole table or view at a snapshot (undefined: the newest), in the read-only engine of the preview. */
  | { readonly kind: 'table'; readonly rows: number; readonly snapshot?: number; readonly sample?: number }
  /** Only the rows that the panel loaded, because the statement does more than read or its run was cancelled. */
  | { readonly kind: 'loaded'; readonly rows: number; readonly reason: 'writes' | 'cancelled' };

export interface ColumnSummary {
  readonly cover: SummaryCover;
  readonly columns: readonly ColumnStats[];
}

/** Where the statistics stand: running, done, or why they failed. */
export type SummaryState =
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly summary: ColumnSummary }
  | { readonly status: 'failed'; readonly message: string };

/** Above this many rows the histograms come from a sample and Distinct is DuckDB's estimate. */
export const SAMPLE_ABOVE_ROWS = 50_000_000;
/** About how many rows such a sample holds. */
export const SAMPLE_ROWS = 5_000_000;
/** The bars of a histogram that DuckDB aims at (`equi_width_bins` makes nice bounds, so it may be a few more or less). */
export const BINS = 12;

/** A time of day: binned and averaged like the moments of `TIME_TYPE`, but without a date. */
export const TIME_OF_DAY = /^TIME( WITH TIME ZONE)?$/;

export function roleOfType(type: string): SummaryRole {
  const kind = kindOf(type);
  if (kind === 'number') return 'number';
  if (kind === 'boolean') return 'boolean';
  if (kind === 'nested') return 'other';
  return TIME_TYPE.test(type) || TIME_OF_DAY.test(type) ? 'time' : 'text';
}

// ---- The statistics in words ---------------------------------------------------------------------------------------

/** The rows that the figures cover: `the whole result, 1,234 rows`, `the 5,000 rows that were loaded only`. */
function coverRows(cover: SummaryCover): string {
  const rows = groupedPlural(cover.rows, 'row');
  switch (cover.kind) {
    case 'result':
      return `the whole result, ${rows}`;
    case 'table':
      return `the whole table at ${cover.snapshot === undefined ? 'the newest snapshot' : `snapshot ${cover.snapshot}`}, ${rows}`;
    case 'loaded':
      return `the ${rows} that were loaded only`;
  }
}

/** A sample behind the histograms, briefly; nothing without one. */
function sampleText(cover: SummaryCover): string {
  return cover.kind === 'loaded' || cover.sample === undefined
    ? ''
    : ` The histograms come from a sample of about ${count(cover.sample)} rows.`;
}

/** What the figures cover, short. */
export function coverText(cover: SummaryCover): string {
  return `Computed by DuckDB over ${coverRows(cover)}.${sampleText(cover)}`;
}

/** The notice of a result that was cut after `loaded` rows: what the tools of the grid work on. */
export function cutNotice(loaded: number, statistics = false): string {
  const tools = statistics
    ? 'the copies, Export as File and the statistics'
    : 'the copies and Export as File';
  return `Only the first ${count(loaded)} rows were read; sorting, filtering, ${tools} apply to these rows only.`;
}

/**
 * The one line above a grid once its statistics are computed: what they cover, and for a result that was cut after
 * `cut` rows the cut in the same message.
 */
export function coverLine(cover: SummaryCover, cut: number | undefined): string {
  if (cut === undefined) return coverText(cover);
  if (cover.kind === 'loaded') return cutNotice(cut, true);
  return `${cutNotice(cut)} The statistics cover ${coverRows(cover)}.${sampleText(cover)}`;
}

/** One line of the statistics of a column: its label, then its value. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** The labels of the lines, in the order of the Markdown table; a column has some of them. */
const LABELS = ['Type', 'Nulls', 'Min', 'Max', 'Avg', 'Distinct', 'First', 'Last', 'True', 'False'] as const;

/** A share in percent with one decimal at most; a share that rounds to 0 % or 100 % but is not says so. */
function share(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%';
  if (part >= whole) return '100%';
  const percent = Number(((part / whole) * 100).toFixed(1));
  if (percent === 0) return '<0.1%';
  return percent === 100 ? '>99.9%' : `${percent}%`;
}

/**
 * The lines of a column, top to bottom: its type and NULLs; for numbers, dates and times Min, Max and Avg; for text
 * Distinct, First and Last; for booleans True and False. `rows` are the rows that the figures cover.
 */
export function facts(stats: ColumnStats, rows: number): Fact[] {
  const lines: Fact[] = [
    { label: 'Type', value: stats.type },
    { label: 'Nulls', value: `${count(stats.nulls)} (${share(stats.nulls, rows)})` },
  ];
  const add = (label: (typeof LABELS)[number], value: string | undefined): void => {
    if (value !== undefined) lines.push({ label, value });
  };
  switch (stats.role) {
    case 'number':
    case 'time':
      add('Min', stats.min);
      add('Max', stats.max);
      add('Avg', stats.avg);
      break;
    case 'text':
      add(
        'Distinct',
        stats.distinct === undefined ? undefined : approximateCount(stats.distinct, stats.estimated),
      );
      add('First', stats.min);
      add('Last', stats.max);
      break;
    case 'boolean':
      add('True', stats.truth && count(stats.truth[0]));
      add('False', stats.truth && count(stats.truth[1]));
      break;
    case 'other':
      break;
  }
  return lines;
}

/** The statistics as Markdown: what they cover, then a table with a row per column and a column per line that occurs. */
export function summaryMarkdown(summary: ColumnSummary): string {
  const columns = summary.columns.map((stats) => ({
    name: stats.name,
    lines: new Map(facts(stats, summary.cover.rows).map(({ label, value }) => [label, value])),
  }));
  const used = LABELS.filter((label) => columns.some(({ lines }) => lines.has(label)));
  const rows = columns.map(({ name, lines }) =>
    markdownRow([name, ...used.map((label) => lines.get(label) ?? '')].map(markdownCell)),
  );
  return `${markdownCell(coverText(summary.cover))}\n\n${markdownHead(['Column', ...used])}${rows.map((row) => `${row}\n`).join('')}`;
}
