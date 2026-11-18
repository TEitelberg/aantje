import type { SnapshotId, StoredFile } from '../catalog/model';
import { count, formatBytes, percent } from '../shell/model';
import type { Card } from '../shell/model';
import { reportHeading } from '../shell/report-heading';

/** A data file of a table, as the catalog lists it. */
export interface LakeFile {
  readonly tableId: number;
  /** `schema.table` at the snapshot the file was picked at. */
  readonly table: string;
  readonly fileId: number;
  /** The snapshot the tree showed when the file was picked; the DuckLake columns are named as at it. */
  readonly snapshot: SnapshotId;
  readonly beginSnapshot: SnapshotId;
  readonly rows: number | null;
  readonly sizeBytes: number | null;
  readonly encrypted: boolean;
  /** Only files below the data path of the lake are opened; a catalog can name any path. */
  readonly belowDataPath: boolean;
}

/** A Parquet file the inspector opens: a data file of the lake, or a file of the Files folder (`lake` absent). */
export interface ParquetTarget {
  readonly path: string;
  readonly lake?: LakeFile;
}

/** The groups of the data files that the pick and the drop-down offer. */
export type FileGroup = 'largest' | 'newest' | 'smallest';

export const FILE_GROUP_LABEL: Readonly<Record<FileGroup, string>> = {
  largest: 'Largest',
  newest: 'Newest',
  smallest: 'Smallest',
};

/** A data file of the table that the pick offered, in its group: the drop-down of the panel offers the same. */
export interface FileChoice {
  readonly group: FileGroup;
  readonly target: ParquetTarget;
}

export interface ParquetFileFacts {
  readonly sizeBytes: number | null;
  readonly rows: number;
  readonly rowGroups: number;
  /** The writer, as the footer names it. */
  readonly createdBy: string | null;
  readonly formatVersion: number | null;
  /** The encryption algorithm of the footer; null for a plain file. */
  readonly encryption: string | null;
  readonly footerBytes: number | null;
}

/** A leaf column of the file, over all its row groups. */
export interface ParquetColumn {
  /** The path in the schema of the file, `customer.name`. */
  readonly path: string;
  readonly physicalType: string | null;
  /** The logical type, else the converted type of the footer; null for a plain physical type. */
  readonly logicalType: string | null;
  readonly fieldId: number | null;
  /** The column of the DuckLake table whose id is the field id; null when none is (or the file is not the lake's). */
  readonly lakeColumn: string | null;
  /** The compressions and encodings of its chunks, each once. */
  readonly compression: string;
  readonly encodings: string;
  readonly dictionary: boolean;
  readonly bloomFilter: boolean;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
}

/** What the footer says about one column in one row group; null where the writer recorded nothing. */
export interface ChunkStats {
  readonly min: string | null;
  readonly max: string | null;
  readonly nulls: number | null;
  readonly distinct: number | null;
}

export interface ParquetRowGroup {
  readonly id: number;
  readonly rows: number;
  readonly compressedBytes: number | null;
  readonly uncompressedBytes: number;
  /** In the order of `columns`. */
  readonly stats: readonly ChunkStats[];
}

/** The answer of the bloom filters of one column to one value. */
export interface BloomProbe {
  /** The index of the column in `columns`. */
  readonly column: number;
  readonly value: string;
  /** The row groups whose filter says that the value is not in them. */
  readonly excluded: readonly number[];
  readonly rowGroups: number;
}

/** What the extension sends to the page. */
export interface ParquetData {
  readonly connection: string;
  readonly target: ParquetTarget;
  /** The last part of the path. */
  readonly name: string;
  /** Inspect Data Files...: the data files of the table that the pick offered; absent for a file of the Files folder. */
  readonly files?: readonly FileChoice[];
  /** `read`; or why the footer was not read: an encrypted lake, a path outside the data path, a failed read. */
  readonly state: 'read' | 'encrypted' | 'outside' | 'failed';
  readonly error?: string;
  readonly file?: ParquetFileFacts;
  readonly keyValues: readonly { readonly key: string; readonly value: string }[];
  readonly columns: readonly ParquetColumn[];
  /** The first row groups; their statistics fit `STAT_CELLS`. */
  readonly rowGroups: readonly ParquetRowGroup[];
  readonly probe?: BloomProbe;
  /** Why the probe asked for could not run; the footer was read. */
  readonly probeError?: string;
}

/** The most row groups listed, and the most statistics cells (row groups times columns) sent to the page. */
export const ROW_GROUPS = 1000;
export const STAT_CELLS = 20_000;
/** The most key/value entries, and the longest value kept of each. */
export const KEY_VALUES = 50;
export const VALUE_LENGTH = 500;

/** How many row groups are listed for a file with `columns` leaf columns. */
export const rowGroupLimit = (columns: number): number =>
  Math.max(1, Math.min(ROW_GROUPS, Math.floor(STAT_CELLS / Math.max(1, columns))));

/** The last part of a path, on a disk or an object store. */
export const fileName = (path: string): string => path.split(/[\\/]/).findLast((part) => part !== '') ?? path;

/** The heading of the page, the panel and the document: the name of the file, not its path. */
export const parquetHeading = (data: Pick<ParquetData, 'name'>): string =>
  reportHeading('Parquet Inspector', data.name);

/** Whether a data file of the catalog is part of the state at the snapshot. */
export const visibleAt = (
  file: Pick<StoredFile, 'beginSnapshot' | 'endSnapshot'>,
  snapshot: SnapshotId,
): boolean => file.beginSnapshot <= snapshot && (file.endSnapshot === null || snapshot < file.endSnapshot);

/** What tells the data files of a table apart: size, rows, the snapshot that wrote it, encryption. */
export const fileFacts = (lake: LakeFile): string =>
  [
    lake.sizeBytes === null ? undefined : formatBytes(lake.sizeBytes),
    lake.rows === null ? undefined : `${count(lake.rows)} rows`,
    `@${lake.beginSnapshot}`,
    lake.encrypted ? 'encrypted' : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

/** The groups of the pick of data files: the largest, the newest and the smallest, each file once. */
export function fileGroups(
  files: readonly StoredFile[],
  per: number,
): { readonly group: FileGroup; readonly files: readonly StoredFile[] }[] {
  const taken = new Set<number>();
  const take = (sorted: readonly StoredFile[]): StoredFile[] => {
    const chosen = sorted.filter((file) => !taken.has(file.id)).slice(0, per);
    for (const file of chosen) taken.add(file.id);
    return chosen;
  };
  const size = (file: StoredFile): number => file.sizeBytes ?? 0;
  const largest = take(files.toSorted((a, b) => size(b) - size(a) || a.id - b.id));
  const newest = take(files.toSorted((a, b) => b.beginSnapshot - a.beginSnapshot || b.id - a.id));
  const smallest = take(files.toSorted((a, b) => size(a) - size(b) || a.id - b.id));
  return [
    { group: 'largest' as const, files: largest },
    { group: 'newest' as const, files: newest },
    { group: 'smallest' as const, files: smallest },
  ].filter((entry) => entry.files.length > 0);
}

/** Orders two statistics values: as numbers when both are, else as text (ISO dates and times sort as text). */
export function compareValues(a: string, b: string): number {
  const left = Number(a);
  const right = Number(b);
  if (a.trim() !== '' && b.trim() !== '' && Number.isFinite(left) && Number.isFinite(right))
    return left - right;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Where the range of each row group lies among all values of the column, 0 to 1; undefined without a range. */
export function rangeLayout(
  stats: readonly ChunkStats[],
): ({ readonly from: number; readonly to: number } | undefined)[] {
  const values = [
    ...new Set(
      stats.flatMap((chunk) => (chunk.min === null || chunk.max === null ? [] : [chunk.min, chunk.max])),
    ),
  ].toSorted(compareValues);
  const last = Math.max(1, values.length - 1);
  return stats.map((chunk) =>
    chunk.min === null || chunk.max === null
      ? undefined
      : { from: values.indexOf(chunk.min) / last, to: values.indexOf(chunk.max) / last },
  );
}

/**
 * The share of the pairs of row groups whose ranges overlap; null with fewer than two ranges. A filter on a column
 * whose ranges overlap much reads most row groups anyway: a sort order on the column would help.
 */
export function overlapShare(stats: readonly ChunkStats[]): number | null {
  const ranges = stats.flatMap((chunk) =>
    chunk.min === null || chunk.max === null ? [] : [{ min: chunk.min, max: chunk.max }],
  );
  if (ranges.length < 2) return null;
  let overlapping = 0;
  for (const [index, a] of ranges.entries()) {
    for (const b of ranges.slice(index + 1)) {
      if (compareValues(a.min, b.max) <= 0 && compareValues(b.min, a.max) <= 0) overlapping++;
    }
  }
  return overlapping / ((ranges.length * (ranges.length - 1)) / 2);
}

/** A column whose row groups overlap this much is a case for a sort order. */
export const OVERLAP_WARNING = 0.5;

export function overlapText(share: number | null): string {
  if (share === null) return 'Fewer than two row groups have a range for this column.';
  return share >= OVERLAP_WARNING
    ? `${percent(share)} of the pairs of row groups overlap: a filter on this column skips few row groups. A sort order on it (or writing it sorted) would let a filter skip more.`
    : `${percent(share)} of the pairs of row groups overlap: a filter on this column can skip row groups.`;
}

/** Why the footer of a file was not read. */
export function stateText(data: ParquetData): string | undefined {
  switch (data.state) {
    case 'encrypted':
      return 'The lake is encrypted: aantje does not open its files. The figures come from the catalog.';
    case 'outside':
      return 'The catalog names a path outside the data path of the lake; aantje opens only files below it.';
    case 'failed':
      return `The footer could not be read: ${data.error ?? 'no reason given'}`;
    case 'read':
      return undefined;
  }
}

// The rows of the footer, compared with the count of the catalog for a data file of the lake.
function rowsCard({ file, target }: ParquetData): Card {
  const catalog = target.lake?.rows ?? null;
  if (!file) return { label: 'Rows', value: catalog === null ? 'unknown' : count(catalog), severity: 'ok' };
  const differs = catalog !== null && catalog !== file.rows;
  return {
    label: 'Rows',
    value: count(file.rows),
    ...(differs ? { detail: `the catalog says ${count(catalog)}` } : {}),
    severity: differs ? 'warning' : 'ok',
  };
}

/** The key figures of the page and the document. */
export function parquetCards(data: ParquetData): Card[] {
  const { file, target } = data;
  const size = file?.sizeBytes ?? target.lake?.sizeBytes ?? null;
  const version = file?.formatVersion ?? null;
  const facts: readonly [string, string][] = [
    ['Size', size === null ? 'unknown' : formatBytes(size)],
    ['Row groups', file ? count(file.rowGroups) : '–'],
    ['Columns', count(data.columns.length)],
    ['Created by', file?.createdBy ?? 'not recorded'],
    ['Parquet version', version === null ? '–' : String(version)],
    ['Encryption', data.state === 'encrypted' ? 'encrypted lake' : (file?.encryption ?? 'none')],
  ];
  const [first, ...rest] = facts.map(([label, value]): Card => ({ label, value, severity: 'ok' }));
  return [...(first ? [first] : []), rowsCard(data), ...rest];
}
