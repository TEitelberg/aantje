// Suggest Partitioning: candidates for the partitioning of one table from the filters of the Query History and the
// measured data. Pure: the reads are in read.ts and measure.ts.
import { quoteIdentifier } from '../catalog/ddl';
import { SMALL_FILE_BYTES } from '../catalog/thresholds';
import { count, formatBytes, percent, plural } from '../shell/model';
import { reportHeading } from '../shell/report-heading';
import type { FilterUse } from './filters';

const MIB = 1024 * 1024;
/** A partition should hold this much: from about one good file to a few. */
export const GOAL_BYTES = { min: 128 * MIB, max: 1024 * MIB } as const;
/** The file size of DuckLake when the lake sets no `target_file_size`. */
export const DEFAULT_TARGET_FILE_BYTES = 512_000_000;
/** More values than this are no case for an identity partition. */
export const MAX_IDENTITY_VALUES = 1000;
/** More partitions than this are a risk of their own: directories, files, catalog rows. */
export const MANY_PARTITIONS = 1000;
/** The most buckets a suggestion names. */
export const MAX_BUCKETS = 1024;

export const TEMPORAL_UNITS = ['year', 'month', 'day', 'hour'] as const;
export type TemporalUnit = (typeof TEMPORAL_UNITS)[number];

/** What DuckDB measured of a column. */
export interface ColumnMeasure {
  readonly column: string;
  /** The DuckLake type. */
  readonly type: string;
  /** `approx_count_distinct`. */
  readonly distinct: number;
  readonly nulls: number;
  /** A date or timestamp: the partitions of each unit (exact). */
  readonly units?: Readonly<Partial<Record<TemporalUnit, number>>>;
}

/** One suggestion: a partitioning of one column, with what it would give. */
export interface Candidate {
  readonly column: string;
  /** `identity`, `month`, `bucket(8)`. */
  readonly transform: string;
  /** The keys of `SET PARTITIONED BY`, as SQL: `"kind"`, `year("ts")`, `bucket(8, "id")`. */
  readonly keys: readonly string[];
  readonly partitions: number;
  readonly rowsPerPartition: number;
  readonly bytesPerPartition: number;
  readonly filesPerPartition: number;
  /** The size of each file of an average partition. */
  readonly fileBytes: number;
  /** The share of the rows in the largest partition, once measured. */
  readonly largestShare?: number;
  readonly reasons: readonly string[];
  readonly risks: readonly string[];
  readonly score: number;
}

/** The table and its figures at the newest snapshot. */
export interface PartitionTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  readonly snapshot: number;
  readonly rows: number;
  readonly sizeBytes: number;
  readonly files: number;
}

/** The heading of the page, the panel and the document: the table it suggests a partitioning for. */
export const partitionHeading = (table: Pick<PartitionTable, 'schema' | 'name'>): string =>
  reportHeading('Suggest Partitioning', `${table.schema}.${table.name}`);

/** What the extension sends to the page. */
export interface PartitionData {
  readonly connection: string;
  readonly table: PartitionTable;
  /** The partitioning and the sort order in force, as text; null for none. */
  readonly current: { readonly partitioning: string | null; readonly sortOrder: string | null };
  readonly targetFileBytes: number;
  /** The statements of the local Query History, the queries among them, and the queries that read the table. */
  readonly history: { readonly statements: number; readonly queries: number; readonly tableQueries: number };
  /** The columns the queries filter on, most used first. */
  readonly filters: readonly { readonly column: string; readonly use: FilterUse }[];
  readonly measures: readonly ColumnMeasure[];
  /** Best first. */
  readonly candidates: readonly Candidate[];
  /** A sort order on a column that the queries filter on, where a partitioning does not fit. */
  readonly sortOrder?: { readonly column: string; readonly reason: string };
  /** Why the data could not be measured; then there are no candidates. */
  readonly measureError?: string;
}

const TEMPORAL = /^(date|timestamp(tz|_s|_ms|_ns)?)$/;
const PARTITIONABLE =
  /^(u?int(8|16|32|64|128)|varchar|boolean|date|timestamp(tz|_s|_ms|_ns)?|decimal\(.*\)|uuid)$/;

export const isTemporal = (type: string): boolean => TEMPORAL.test(type);
/** The types that a partition can take as identity or bucket: no float, no nested type, no blob. */
export const isPartitionable = (type: string): boolean => PARTITIONABLE.test(type);

/** The keys of a temporal partitioning down to the unit: `year(ts), month(ts)` for a month. DuckLake's `month` is the month of the year. */
export function temporalKeys(column: string, unit: TemporalUnit): string[] {
  const name = quoteIdentifier(column);
  return TEMPORAL_UNITS.slice(0, TEMPORAL_UNITS.indexOf(unit) + 1).map((part) => `${part}(${name})`);
}

/** The unit whose partitions get towards the goal: the finest that still gives at least `GOAL_BYTES.min` each. */
export function chooseUnit(
  units: Readonly<Partial<Record<TemporalUnit, number>>>,
  bytes: number,
): TemporalUnit | undefined {
  const known = TEMPORAL_UNITS.filter((unit) => (units[unit] ?? 0) > 0);
  const fitting = known.filter((unit) => bytes / (units[unit] ?? 1) >= GOAL_BYTES.min);
  return fitting.at(-1) ?? known[0];
}

/** The buckets that give partitions of the goal size; undefined when the table is too small for two. */
export function bucketCount(bytes: number): number | undefined {
  const buckets = Math.min(MAX_BUCKETS, Math.max(2, Math.ceil(bytes / GOAL_BYTES.max)));
  return bytes / buckets >= GOAL_BYTES.min ? buckets : undefined;
}

interface Shape {
  readonly transform: string;
  readonly keys: readonly string[];
  readonly partitions: number;
}

function shapeOf(measure: ColumnMeasure, use: FilterUse | undefined, bytes: number): Shape | undefined {
  if (measure.units) {
    const unit = chooseUnit(measure.units, bytes);
    return (
      unit && {
        transform: unit,
        keys: temporalKeys(measure.column, unit),
        partitions: measure.units[unit] ?? 1,
      }
    );
  }
  if (measure.distinct <= MAX_IDENTITY_VALUES) {
    return {
      transform: 'identity',
      keys: [quoteIdentifier(measure.column)],
      partitions: Math.max(1, measure.distinct) + (measure.nulls > 0 ? 1 : 0),
    };
  }
  const buckets = bucketCount(bytes);
  return (use?.equality ?? 0) + (use?.join ?? 0) > 0 && buckets !== undefined
    ? {
        transform: `bucket(${buckets})`,
        keys: [`bucket(${buckets}, ${quoteIdentifier(measure.column)})`],
        partitions: buckets,
      }
    : undefined;
}

function reasonsOf(
  measure: ColumnMeasure,
  use: FilterUse | undefined,
  shape: Shape,
  tableQueries: number,
): string[] {
  const filtered = use
    ? [
        `Filtered in ${count(use.queries)} of the ${plural(tableQueries, 'query', 'queries')} of your Query History that read the table: ${[
          use.equality > 0 ? `${count(use.equality)} by equality` : '',
          use.range > 0 ? `${count(use.range)} by range` : '',
          use.join > 0 ? `${count(use.join)} in a join` : '',
          use.other > 0 ? `${count(use.other)} otherwise` : '',
        ]
          .filter((part) => part !== '')
          .join(', ')}.`,
      ]
    : ['Not filtered in your Query History; suggested from the data.'];
  const what = measure.units
    ? `A ${shape.transform} partition per value: ${count(shape.partitions)} partitions, and a filter on a range of time reads only its partitions.`
    : shape.transform === 'identity'
      ? `About ${count(measure.distinct)} distinct values: an equality filter reads one partition, about 1/${count(Math.max(1, measure.distinct))} of the rows.`
      : `About ${count(measure.distinct)} distinct values, too many for a partition each: ${shape.transform} spreads them over ${count(shape.partitions)} partitions, and an equality filter reads one.`;
  return [...filtered, what];
}

function risksOf(
  measure: ColumnMeasure,
  shape: Shape,
  figures: { readonly rows: number; readonly bytes: number; readonly fileBytes: number },
): string[] {
  return [
    ...(figures.bytes < GOAL_BYTES.min
      ? [
          `The whole table (${formatBytes(figures.bytes)}) is smaller than one good file of ${formatBytes(GOAL_BYTES.min)}.`,
        ]
      : []),
    ...(figures.fileBytes < SMALL_FILE_BYTES
      ? [
          `Files of about ${formatBytes(figures.fileBytes)}: below ${formatBytes(SMALL_FILE_BYTES)}, the small-file threshold of the Statistics report.`,
        ]
      : []),
    ...(shape.partitions > MANY_PARTITIONS
      ? [`${count(shape.partitions)} partitions: as many directories and at least as many files.`]
      : []),
    ...(figures.rows > 0 && measure.nulls / figures.rows >= 0.1
      ? [`${percent(measure.nulls / figures.rows)} of the rows are NULL and share one partition.`]
      : []),
  ];
}

/** The candidates of the measured columns, best first; a column that no partitioning fits gives none. */
export function candidatesOf(
  measures: readonly ColumnMeasure[],
  filters: ReadonlyMap<string, FilterUse>,
  table: {
    readonly rows: number;
    readonly bytes: number;
    readonly targetFileBytes: number;
    readonly tableQueries: number;
  },
): Candidate[] {
  return measures
    .flatMap((measure): Candidate[] => {
      const use = filters.get(measure.column);
      const shape = shapeOf(measure, use, table.bytes);
      if (!shape) return [];
      const bytesPerPartition = table.bytes / shape.partitions;
      const filesPerPartition = Math.max(1, Math.ceil(bytesPerPartition / table.targetFileBytes));
      const fileBytes = bytesPerPartition / filesPerPartition;
      const risks = risksOf(measure, shape, { rows: table.rows, bytes: table.bytes, fileBytes });
      const fits = (use?.equality ?? 0) * 3 + (use?.join ?? 0) + (use?.range ?? 0) * (measure.units ? 3 : 1);
      return [
        {
          column: measure.column,
          ...shape,
          rowsPerPartition: table.rows / shape.partitions,
          bytesPerPartition,
          filesPerPartition,
          fileBytes,
          reasons: reasonsOf(measure, use, shape, table.tableQueries),
          risks,
          score: fits + (measure.units ? 1 : 0) - risks.length * 2,
        },
      ];
    })
    .toSorted(
      (a, b) => b.score - a.score || a.risks.length - b.risks.length || a.column.localeCompare(b.column),
    );
}

/** A sort order instead: the most filtered column whose filters a partitioning does not serve well. */
export function sortOrderOf(
  filters: readonly { readonly column: string; readonly use: FilterUse }[],
  candidates: readonly Candidate[],
  bytes: number,
): PartitionData['sortOrder'] {
  const good = new Set(
    candidates.filter((candidate) => candidate.risks.length === 0).map(({ column }) => column),
  );
  const column = filters.find(({ column: name, use }) => !good.has(name) && use.equality + use.range > 0);
  if (!column) return undefined;
  return {
    column: column.column,
    reason:
      bytes < GOAL_BYTES.min
        ? `The table is small for partitions; written sorted by ${column.column}, its files and row groups have narrow ranges that a filter on it skips.`
        : `No partitioning of ${column.column} fits without a risk; written sorted by it, files and row groups have narrow ranges that a filter on it skips.`,
  };
}

/** What a candidate gives, in one line. */
export function figuresText(candidate: Candidate): string {
  const files = candidate.filesPerPartition === 1 ? '1 file' : `${count(candidate.filesPerPartition)} files`;
  return [
    `${count(candidate.partitions)} partitions`,
    `about ${count(Math.round(candidate.rowsPerPartition))} rows and ${formatBytes(candidate.bytesPerPartition)} each`,
    `${files} of about ${formatBytes(candidate.fileBytes)} per partition`,
    ...(candidate.largestShare === undefined
      ? []
      : [`the largest holds ${percent(candidate.largestShare)} of the rows`]),
  ].join(' · ');
}

/** The source of the filters: the local history of this user, which says how much it saw. */
export const historyText = ({ history }: PartitionData): string =>
  `The filters come from your own Query History of this connection, on this machine: ${count(history.statements)} statements, ${count(history.queries)} of them queries, ${count(history.tableQueries)} filter this table. Queries of other users and clients are not visible to aantje, so read a suggestion from few queries as such.`;

/** The figures of a measured column: distinct values, NULLs and the partitions of each unit of time. */
export function measureText(measure: ColumnMeasure): string {
  const units = measure.units
    ? TEMPORAL_UNITS.flatMap((unit) =>
        measure.units?.[unit] === undefined ? [] : [`${count(measure.units[unit] ?? 0)} by ${unit}`],
      )
    : [];
  return [`about ${count(measure.distinct)} distinct values`, `${count(measure.nulls)} NULL`, ...units].join(
    ', ',
  );
}
