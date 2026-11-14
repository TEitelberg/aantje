import type { ColumnStatistics, FileSizeBin, PartitionStatistics, TableStatistics } from '../catalog/model';
import { hasManySmallFiles } from '../catalog/thresholds';
import { approximateCount, count, files, formatBytes, percent } from '../shell/model';
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

const APPROXIMATE_HINT =
  'A file holds more than this snapshot (after a compaction or a delete file for several snapshots), so the row count can be off.';

function smallFileSeverity(stats: TableStatistics): Severity {
  return hasManySmallFiles(stats) ? 'warning' : 'ok';
}

export function overviewCards(stats: TableStatistics): Card[] {
  const hasFiles = stats.files > 0;
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
      value: approximateCount(stats.rows, stats.approximate),
      severity: 'ok',
      hint: stats.approximate
        ? APPROXIMATE_HINT
        : 'Rows in data files without the deleted ones; inlined rows are not included.',
    },
    { label: 'Delete files', value: count(stats.deleteFiles), severity: 'ok' },
    {
      label: 'Average file size',
      value: hasFiles ? formatBytes(stats.dataBytes / stats.files) : '–',
      detail: hasFiles ? `largest ${formatBytes(stats.largestFileBytes)}` : undefined,
      severity: 'ok',
    },
    {
      label: 'Small files',
      value: hasFiles ? percent(stats.smallFiles / stats.files) : '–',
      detail: hasFiles
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

/** The sentences that the page and the document share. */
export const noDataFilesNote = (snapshot: number): string =>
  `This table has no data files at snapshot ${snapshot}.`;
export const RANGES_NOTE = 'Each range is half the size of the one above it, relative to the largest file.';
export const NO_COLUMNS_NOTE = 'This table has no columns at this snapshot.';
export const COLUMNS_PARTIAL_NOTE =
  'The table has very many files: minimum and maximum cover only some of them.';
export const notPartitionedNote = (snapshot: number): string =>
  `This table is not partitioned at snapshot ${snapshot}.`;
export const NO_PARTITION_FILES_NOTE = 'No data file was written under this partitioning yet.';

/** The headings of the table of the columns. */
export const COLUMN_HEADERS = ['Column', 'Type', 'Nullable', 'Null share', 'Minimum', 'Maximum'] as const;

export const COLUMNS_NOTE =
  'Minimum and maximum are the range according to the statistics: deleting rows does not narrow it. ' +
  'The null share counts the rows of the data files, deleted ones included. It is not shown (–) for a field below a ' +
  'column that can be NULL or is a list or a map, because DuckLake counts a missing parent as NULL for its fields.';

/** Under the columns when their statistics could not be read (`columnsUnread`). */
export const COLUMNS_UNREAD_NOTE =
  'The statistics of the columns could not be read from the catalog, so null shares, minimum and maximum may be missing.';

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

interface PartitionEntry {
  readonly label: string;
  readonly fileCount: number;
  readonly sizeBytes: number;
  readonly rows: number;
  readonly detail: string;
  /** The partitions summed up as one, after the named ones. */
  readonly rest: boolean;
}

/** The partitions largest first, then `other (n)` for the smallest ones summed up: a bar or a row each. */
export function partitionEntries(stats: PartitionStatistics): PartitionEntry[] {
  const { partitions, rest } = stats;
  return [
    ...partitions.map((partition) => ({
      label: partitionLabel(partition.values),
      fileCount: partition.files,
      sizeBytes: partition.sizeBytes,
      rows: partition.rows,
      detail: `${files(partition.files)}, ${count(partition.rows)} rows`,
      rest: false,
    })),
    ...(rest
      ? [
          {
            label: `other (${count(rest.partitions)})`,
            fileCount: rest.files,
            sizeBytes: rest.sizeBytes,
            rows: rest.rows,
            detail: `${count(rest.partitions)} partitions, ${files(rest.files)}, ${count(rest.rows)} rows`,
            rest: true,
          },
        ]
      : []),
  ];
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
    ...(stats.unread
      ? ['The partition values could not be read from the catalog, so no partition is shown.']
      : []),
  ];
}
