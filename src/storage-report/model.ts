import type { ConnectionProfile } from '../connections/profile';
import type { GrowthPoint, SnapshotId, StorageInfo } from '../catalog/model';
import { CLEANUP_OVERDUE_DAYS, hasManySmallFiles } from '../catalog/thresholds';
import { compareText } from '../order';
import {
  approximateCount,
  count,
  files,
  formatBytes,
  formatUtc,
  percent,
  plural,
  tableLabel,
} from '../shell/model';
import type { Card, Severity } from '../shell/model';
import { waitText } from '../shell/numbers';
import { expirableLine, expirableNote, scheduledLine, scheduledNote } from '../shell/scheduled-text';
import { lakeWide } from '../shell/scope';
import type { ReportScope } from '../shell/scope';

/** The tables that the page and the document hold; a lake with more tables says how many are left out. */
export const TABLE_LIMIT = 1000;

// The bars of the chart: the largest tables; the others are one bar.
const BAR_LIMIT = 30;

/** The tables of the document, and the points of the growth list on the page and in the document. */
export const MARKDOWN_TABLES = 50;
export const GROWTH_ROWS = 20;

/** The actions of the page, by id; a table by its catalog id. The extension runs only what the data offers. */
export type StorageActionId =
  | 'showStatistics'
  | 'revealTable'
  | 'scriptMerge'
  | 'scriptRewrite'
  | 'scriptCleanup'
  | 'scriptExpire'
  | 'showProperties';

/** What the figures of a schema leave to the lake, on the page and in the document. */
export const LAKE_WIDE_NOTE =
  'The data path, the encryption, the files scheduled for deletion and the snapshots to expire are lake-wide.';

/** A table with the figures of its visible data files and delete files at the snapshot. */
export interface StorageTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  readonly files: number;
  /** Data files plus delete files. */
  readonly sizeBytes: number;
  readonly rows: number;
  readonly approximate?: true;
  /** Data files below `smallFileBytes`. */
  readonly smallFiles: number;
}

/** What the extension sends to the page. */
export interface StorageData {
  readonly connection: string;
  /** The lake, or one schema: its tables, their files and growth. The data path, encryption and scheduled files are the lake's. */
  readonly scope: ReportScope;
  readonly snapshot: SnapshotId;
  /** When the data was read (ISO 8601, UTC): the age of the scheduled files is counted up to here. */
  readonly readAt: string;
  readonly storage: StorageInfo;
  readonly smallFileBytes: number;
  /** The rows of all tables of the scope, also of those that `tables` leaves out. */
  readonly rows: number;
  readonly approximate?: true;
  /** All tables at the snapshot; `tables` holds the largest ones. */
  readonly tableCount: number;
  /** Largest first. */
  readonly tables: readonly StorageTable[];
  /** Oldest first. */
  readonly growth: readonly GrowthPoint[];
  readonly growthMerged?: true;
}

/** What the user chose on the page that Open as Markdown names: the text of the filter box. */
export interface StorageView {
  readonly filter: string;
}

const DAY_MS = 86_400_000;

interface Scheduled {
  readonly severity: Severity;
  readonly files: string;
  /** `2026-10-30 12:43:33 UTC`; absent when nothing is scheduled or the catalog has no time. */
  readonly oldest?: string;
  /** `3 days`: how long the oldest has waited, up to the time of the read. */
  readonly age?: string;
}

/** The files that wait for the cleanup: count, age of the oldest and a warning past the cleanup threshold. */
export function scheduledOf(data: Pick<StorageData, 'storage' | 'readAt'>): Scheduled {
  const { count: total, oldestScheduledAt } = data.storage.scheduledForDeletion;
  const waited = oldestScheduledAt === null ? NaN : Date.parse(data.readAt) - Date.parse(oldestScheduledAt);
  if (total === 0 || oldestScheduledAt === null || Number.isNaN(waited)) {
    return { severity: 'ok', files: files(total) };
  }
  return {
    severity: waited > CLEANUP_OVERDUE_DAYS * DAY_MS ? 'warning' : 'ok',
    files: files(total),
    oldest: formatUtc(oldestScheduledAt),
    // How long the oldest scheduled file has waited, in the words of the health check.
    age: waitText(waited),
  };
}

export const SCHEDULED_EXPLANATION =
  'DuckLake keeps the files that expired snapshots or a compaction replaced until Clean Up Old Files deletes them: they take space in the store, but no query reads them.';

const totalBytes = ({ storage }: Pick<StorageData, 'storage'>): number =>
  storage.dataFiles.sizeBytes + storage.deleteFiles.sizeBytes;

export function storageCards(data: StorageData): Card[] {
  const { storage } = data;
  const scheduled = scheduledOf(data);
  const { count: waiting, split } = storage.scheduledForDeletion;
  return [
    { label: lakeWide(data.scope, 'Data path'), value: storage.dataPath ?? 'not set', severity: 'ok' },
    { label: lakeWide(data.scope, 'Encrypted'), value: storage.encrypted ? 'yes' : 'no', severity: 'ok' },
    {
      label: 'Snapshot',
      value: `@${data.snapshot}`,
      severity: 'ok',
      hint: 'The snapshot that the tree showed when the report was read.',
    },
    {
      label: 'Data files',
      value: count(storage.dataFiles.count),
      detail: formatBytes(storage.dataFiles.sizeBytes),
      severity: 'ok',
    },
    {
      label: 'Delete files',
      value: count(storage.deleteFiles.count),
      detail: formatBytes(storage.deleteFiles.sizeBytes),
      severity: 'ok',
    },
    {
      label: 'Rows',
      value: approximateCount(data.rows, data.approximate),
      severity: 'ok',
      hint: data.approximate
        ? 'A file holds more than this snapshot (after a compaction or a delete file for several snapshots), so the count of some tables can be off.'
        : 'Rows in data files without the deleted ones; inlined rows are not included.',
    },
    {
      label: lakeWide(data.scope, 'Scheduled for deletion'),
      value: count(waiting),
      detail:
        waiting === 0
          ? 'nothing waits for cleanup'
          : split !== null
            ? `${count(split.ready)} ready now, ${count(split.waiting)} waiting`
            : scheduled.age === undefined
              ? 'time of the oldest unknown'
              : `oldest ${scheduled.age} ago`,
      severity: scheduled.severity,
      hint:
        scheduled.severity === 'warning'
          ? `The oldest file has waited longer than ${plural(CLEANUP_OVERDUE_DAYS, 'day', 'days')}; Clean Up Old Files deletes it.`
          : SCHEDULED_EXPLANATION,
    },
    ...(storage.expirableSnapshots === null
      ? []
      : [
          {
            label: lakeWide(data.scope, 'Snapshots to expire'),
            value: count(storage.expirableSnapshots.ready),
            detail: `${count(storage.expirableSnapshots.waiting)} younger than ${storage.expirableSnapshots.age.text}`,
            severity: 'ok' as const,
            hint: [expirableLine(storage.expirableSnapshots), expirableNote(storage.expirableSnapshots)]
              .filter(Boolean)
              .join('. '),
          },
        ]),
  ];
}

// The share of small data files of a table; null for a table without data files.
const smallRatio = (table: StorageTable): number | null =>
  table.files === 0 ? null : table.smallFiles / table.files;

/** `5 of 9 (55.6 %)`, plus `⚠ many small files` when flagged: words and sign carry it, not colour. */
export function smallFilesText(table: StorageTable): string {
  const ratio = smallRatio(table);
  if (ratio === null) return '–';
  const text = `${count(table.smallFiles)} of ${count(table.files)} (${percent(ratio)})`;
  return hasManySmallFiles(table) ? `${text} ⚠ many small files` : text;
}

export function shareText(table: StorageTable, data: Pick<StorageData, 'storage'>): string {
  const total = totalBytes(data);
  return total === 0 ? '–' : percent(table.sizeBytes / total);
}

export const rowsText = (table: StorageTable): string => approximateCount(table.rows, table.approximate);

/** The tables whose name (`schema.table`) holds the text, regardless of case; all of them for an empty filter. */
export function matchingTables(tables: readonly StorageTable[], filter: string): StorageTable[] {
  const wanted = filter.trim().toLowerCase();
  return tables.filter((table) => wanted === '' || tableLabel(table).toLowerCase().includes(wanted));
}

/** The columns the table list sorts by; the saved choices of a page are checked against this list. */
export const SORT_KEYS = ['name', 'files', 'size', 'rows', 'small'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export interface Sort {
  readonly key: SortKey;
  readonly descending: boolean;
}

/** Largest first, the order of the chart. */
export const DEFAULT_SORT: Sort = { key: 'size', descending: true };

// The order of the other reports: by code unit, the same on every machine.
const compareNames = (a: StorageTable, b: StorageTable): number => compareText(tableLabel(a), tableLabel(b));

/** The tables in the order of a column, ties by name. A table without data files counts as having no small files. */
export function sortedTables(tables: readonly StorageTable[], { key, descending }: Sort): StorageTable[] {
  const value = (table: StorageTable): number =>
    key === 'files'
      ? table.files
      : key === 'size'
        ? table.sizeBytes
        : key === 'rows'
          ? table.rows
          : (smallRatio(table) ?? -1);
  return tables.toSorted((a, b) => {
    const order = key === 'name' ? compareNames(a, b) : value(a) - value(b);
    return (descending ? -order : order) || compareNames(a, b);
  });
}

/** A bar of the chart: one table, or the tables that did not make it. */
export interface BarEntry {
  readonly label: string;
  readonly sizeBytes: number;
  readonly detail: string;
  /** Absent for the bar of the other tables. */
  readonly tableId?: number;
  readonly manySmallFiles: boolean;
}

/** The largest tables by size and one bar (`12 more tables`) for the rest of the bytes. */
export function barEntries(data: Pick<StorageData, 'storage' | 'tables' | 'tableCount'>): BarEntry[] {
  const largest = sortedTables(data.tables, DEFAULT_SORT).slice(0, BAR_LIMIT);
  const rest = data.tableCount - largest.length;
  return [
    ...largest.map((table) => {
      const many = hasManySmallFiles(table);
      return {
        label: `${tableLabel(table)}${many ? ' ⚠' : ''}`,
        sizeBytes: table.sizeBytes,
        detail: `${files(table.files)}, ${rowsText(table)} rows${many ? ', many small files' : ''}`,
        tableId: table.id,
        manySmallFiles: many,
      };
    }),
    ...(rest > 0
      ? [
          {
            label: plural(rest, 'more table', 'more tables'),
            sizeBytes: Math.max(
              0,
              totalBytes(data) - largest.reduce((sum, table) => sum + table.sizeBytes, 0),
            ),
            detail: 'together',
            manySmallFiles: false,
          },
        ]
      : []),
  ];
}

/** The newest points of the growth, newest first. */
export const lastGrowth = (growth: readonly GrowthPoint[], limit = GROWTH_ROWS): GrowthPoint[] =>
  growth.slice(-limit).toReversed();

/** The tables that are called out as candidates for a merge, the ones with the most files first. */
export const mergeCandidates = (tables: readonly StorageTable[]): StorageTable[] =>
  sortedTables(tables.filter(hasManySmallFiles), { key: 'files', descending: true });

export function scheduledSentence(data: Pick<StorageData, 'storage' | 'readAt'>): string {
  const scheduled = data.storage.scheduledForDeletion;
  const { oldest, age } = scheduledOf(data);
  if (scheduled.count === 0) return 'No file is scheduled for deletion.';
  const note = scheduledNote(scheduled);
  return `${scheduledLine(scheduled)}.${
    oldest === undefined ? '' : ` The oldest has waited since ${oldest} (${age}).`
  }${note === '' ? '' : ` ${note}`}`;
}

/** The snapshots Expire Snapshots takes now and those that are younger, with the warning when the lake sets no age; empty when the age is not known. */
export function expirableSentence({ storage }: Pick<StorageData, 'storage'>): string {
  const line = expirableLine(storage.expirableSnapshots);
  const note = expirableNote(storage.expirableSnapshots);
  return line === '' ? '' : `${line}.${note === '' ? '' : ` ${note}`}`;
}

/** The Storage report of a connection, as the commands that offer it use it. */
export interface StorageReport {
  /** Reads the storage of the connection, or of one schema, at the snapshot that its tree shows and shows it in its panel. */
  show(profile: ConnectionProfile, scope?: ReportScope): Promise<void>;
  dispose(): void;
}
