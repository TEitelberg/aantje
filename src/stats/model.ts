import type {
  ColumnStatistics,
  FileSizeBin,
  GrowthPoint,
  PartitionStatistics,
  TableStatistics,
} from '../catalog/model';
import { hasManySmallFiles } from '../catalog/thresholds';
import { count, formatBytes, formatUtc } from '../shell/model';
import type { Card, Severity } from '../shell/model';

/** What the extension sends to the statistics page. */
export interface StatisticsData {
  /** `schema.table` */
  readonly table: string;
  readonly connection: string;
  readonly statistics: TableStatistics;
}

const UNEVEN_GINI = 0.5;

// A column with at least this share of NULLs is called out; an all-NULL one is an error. The page says so in words
// too: colour must not be the only carrier.
const NULL_WARNING_RATIO = 0.5;

/** `12.5 %`, `100 %`, `0 %`; the share has one decimal at most. */
export function percent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(1))} %`;
}

const APPROXIMATE_HINT =
  'A file holds more than this snapshot (after a compaction or a delete file for several snapshots), so the row count can be off.';

function smallFileSeverity(stats: TableStatistics): Severity {
  return hasManySmallFiles(stats) ? 'warning' : 'ok';
}

export function overviewCards(stats: TableStatistics): Card[] {
  const files = stats.files > 0;
  return [
    { label: 'Files', value: count(stats.files), severity: 'ok', hint: 'Data files at this snapshot.' },
    {
      label: 'Size',
      value: formatBytes(stats.dataBytes + stats.deleteBytes),
      detail: `${formatBytes(stats.dataBytes)} data, ${formatBytes(stats.deleteBytes)} delete files`,
      severity: 'ok',
    },
    {
      label: 'Rows',
      value: `${stats.approximate ? '~' : ''}${count(stats.rows)}`,
      severity: 'ok',
      hint: stats.approximate
        ? APPROXIMATE_HINT
        : 'Rows in data files without the deleted ones; inlined rows are not included.',
    },
    { label: 'Delete files', value: count(stats.deleteFiles), severity: 'ok' },
    {
      label: 'Average file size',
      value: files ? formatBytes(stats.dataBytes / stats.files) : '–',
      detail: files ? `largest ${formatBytes(stats.largestFileBytes)}` : undefined,
      severity: 'ok',
    },
    {
      label: 'Small files',
      value: files ? percent(stats.smallFiles / stats.files) : '–',
      detail: files
        ? `${count(stats.smallFiles)} of ${count(stats.files)} under ${formatBytes(stats.smallFileBytes)}`
        : undefined,
      severity: smallFileSeverity(stats),
      hint: 'Data files below the size shown. Many small files slow reads down; compaction merges them.',
    },
  ];
}

/** `< 8 B`, `8 B – 16 B`, `≥ 512 B`: the range of one bin of the histogram. */
export function binLabel(bin: FileSizeBin, index: number, bins: number): string {
  if (index === 0) {
    return `< ${formatBytes(bin.toBytes)}`;
  }
  return index === bins - 1
    ? `≥ ${formatBytes(bin.fromBytes)}`
    : `${formatBytes(bin.fromBytes)} – ${formatBytes(bin.toBytes)}`;
}

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  readonly nullable: string;
  /** The share, with `(high)` or `(all NULL)` after it when the bar is not in the ordinary colour. */
  readonly nullText: string;
  /** 0..1, or null without statistics. */
  readonly nullRatio: number | null;
  readonly severity: Severity;
  readonly min: string;
  readonly max: string;
}

const NULL_WARNING_WORD = { ok: '', warning: ' (high)', error: ' (all NULL)' } as const;

// `–` for no value, `""` for empty text, and `true`/`false` for the 0 and 1 DuckLake writes for a boolean.
function rangeText(type: string, value: string | null): string {
  if (value === null) return '–';
  if (value === '') return '""';
  return type === 'boolean' ? (value === '1' || value === 'true' ? 'true' : 'false') : value;
}

function nullSeverity(ratio: number | null): Severity {
  return ratio === null || ratio < NULL_WARNING_RATIO ? 'ok' : ratio === 1 ? 'error' : 'warning';
}

/** The rows of the column table: nested columns show their whole path. */
export function statisticsColumnRows(columns: readonly ColumnStatistics[]): ColumnRow[] {
  return columns.map((column) => {
    const severity = nullSeverity(column.nullRatio);
    return {
      name: column.path.join('.'),
      type: column.type,
      nullable: column.nullable ? 'yes' : 'no',
      nullText:
        column.nullRatio === null ? '–' : `${percent(column.nullRatio)}${NULL_WARNING_WORD[severity]}`,
      nullRatio: column.nullRatio,
      severity,
      min: rangeText(column.type, column.min),
      max: rangeText(column.type, column.max),
    };
  });
}

export const COLUMNS_NOTE =
  'Minimum and maximum are the range according to the statistics: deleting rows does not narrow it. ' +
  'The null share counts the rows of the data files, deleted ones included. It is not shown (–) for a field below a ' +
  'column that can be NULL or is a list or a map, because DuckLake counts a missing parent as NULL for its fields.';

/** `kind, month(ts)`: the partition keys, the transform in front of the column unless it is the plain value. */
export function partitioningText(stats: PartitionStatistics): string {
  return stats.partitioning.columns
    .map(({ path, transform }) =>
      transform === 'identity' ? path.join('.') : `${transform}(${path.join('.')})`,
    )
    .join(', ');
}

/** `click / 3`: the values of one partition in the order of the keys. */
export function partitionLabel(values: readonly (string | null)[]): string {
  return values.map((value) => value ?? 'NULL').join(' / ');
}

export function evennessSeverity(stats: PartitionStatistics): Severity {
  return stats.evenness && stats.evenness.gini >= UNEVEN_GINI ? 'warning' : 'ok';
}

/** The sentence under the partitioning chart, or undefined when there is nothing to compare. */
export function evennessText(stats: PartitionStatistics): string | undefined {
  if (!stats.evenness) {
    return undefined;
  }
  const { coefficientOfVariation, gini } = stats.evenness;
  return (
    `Size per partition: coefficient of variation ${coefficientOfVariation.toFixed(2)}, Gini ${gini.toFixed(2)} ` +
    `(${evennessSeverity(stats) === 'warning' ? 'uneven' : 'even'}; 0 means equal sizes, 1 means one partition holds everything).`
  );
}

/** Notes under the partitioning chart that are true for this table. */
export function partitioningNotes(stats: PartitionStatistics): string[] {
  return [
    ...(stats.earlierFiles > 0
      ? [
          `${count(stats.earlierFiles)} data files were written under an earlier partitioning and are not shown here.`,
        ]
      : []),
    ...(stats.rest
      ? [
          `The ${count(stats.rest.partitions)} smallest partitions are summed up as "other" ` +
            `(${count(stats.rest.files)} files, ${formatBytes(stats.rest.sizeBytes)}).`,
        ]
      : []),
    ...(stats.partial
      ? ['The table has more partitions than are read; the figures cover the largest ones.']
      : []),
    ...(stats.keysLeftOut
      ? [
          `The partitioning has ${count(stats.keysLeftOut)} more keys than are read; the partitions group by the first keys only.`,
        ]
      : []),
  ];
}

/** `@12` */
export function growthLabel(point: GrowthPoint): string {
  return `@${point.snapshot}`;
}

export function growthTime(point: GrowthPoint): string {
  return point.time === null ? 'time unknown (snapshot expired)' : formatUtc(point.time);
}

export const GROWTH_MERGED_NOTE = 'The history is long: neighbouring snapshots are merged into one point.';

export function growthNotes(stats: Pick<TableStatistics, 'growthMerged'>): string[] {
  return [
    'The state after each snapshot that added or removed files. A compaction (diamond) replaces files that leave no trace, ' +
      'so the file count before it is what the catalog still shows.',
    ...(stats.growthMerged ? [GROWTH_MERGED_NOTE] : []),
  ];
}
