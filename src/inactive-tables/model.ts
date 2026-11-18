// The Inactive Tables report: the tables of a lake or a schema without a change for some days, with their size. Changes
// come from the catalog; DuckLake records no reads, so the last read is a hint from the local Query History of this user.
import type { SnapshotId, TableChange } from '../catalog/model';
import { count, formatUtc, tableLabel } from '../shell/model';
import type { PagedColumn } from '../shell/paged-table';
import { reportHeading } from '../shell/report-heading';
import { scopeSchema } from '../shell/scope';
import type { ReportScope } from '../shell/scope';

/** The heading of the page, the panel and the document: the name alone for the lake, with the schema for a schema. */
export const inactiveHeading = (scope: ReportScope): string =>
  reportHeading('Inactive Tables', scopeSchema(scope));

/** The columns of the table: the first holds the buttons of the tables, the second the icons of their actions. */
export const INACTIVE_COLUMNS: readonly PagedColumn[] = [
  { label: 'Table', className: 'name' },
  { label: '', className: 'icons', description: 'Actions' },
  { label: 'Last change' },
  { label: 'By', className: 'who' },
  { label: 'Rows', className: 'number' },
  { label: 'Size', className: 'number' },
  { label: 'Files', className: 'number' },
  { label: 'Comment', className: 'who' },
  { label: 'Last read (local)' },
];

/** A table of the scope with its last change and size. */
export interface InactiveTable {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  readonly comment: string | null;
  readonly rows: number;
  readonly approximate?: true;
  readonly sizeBytes: number;
  readonly files: number;
  /** The newest change; null when the catalog keeps none. */
  readonly change: Omit<TableChange, 'tableId'> | null;
  /** ISO 8601 UTC: the newest statement of this user's Query History of the connection that read it; null for none. */
  readonly lastRead: string | null;
}

/** What the extension reads and sends to the page. */
export interface InactiveData {
  readonly connection: string;
  readonly scope: ReportScope;
  /** ISO 8601 UTC; the days are counted back from it. */
  readonly readAt: string;
  /** The snapshot the tables are read at, the newest. */
  readonly snapshot: SnapshotId;
  /** The days without a change that the tables were read for. */
  readonly days: number;
  /** The tables of the scope without a change for `days` days, the longest unchanged first. */
  readonly tables: readonly InactiveTable[];
  /** The tables of the scope at the snapshot, changed or not. */
  readonly tableCount: number;
}

export const DAY_CHOICES = [30, 90, 180, 365] as const;
/** The days of the first report, before any were chosen. */
export const DEFAULT_DAYS = 90;
/** The most days the report takes: a hundred years. */
export const MAX_DAYS = 36_500;

const DAY_MS = 86_400_000;

/** Days the report takes: a whole number from 1 to `MAX_DAYS`. */
export const isDays = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_DAYS;

/** The days kept from the last choice; the default when none were kept or what was kept is no days. */
export const rememberedDays = (value: unknown): number => (isDays(value) ? value : DEFAULT_DAYS);

/** A whole number typed on the page, brought into the range of the days. */
export const fitDays = (days: number): number => Math.min(Math.max(days, 1), MAX_DAYS);

/** When a table changed for the filter: its time, or for an expired snapshot the time it was certainly before. */
export const changedAt = (table: InactiveTable): string | null =>
  table.change?.time ?? table.change?.before ?? null;

/** The tables without a change for `days` days before `readAt`, the longest unchanged first. */
export function inactiveTables(
  tables: readonly InactiveTable[],
  readAt: string,
  days: number,
): InactiveTable[] {
  const cutoff = Date.parse(readAt) - days * DAY_MS;
  return tables
    .filter((table) => {
      const at = changedAt(table);
      return at !== null && Date.parse(at) < cutoff;
    })
    .toSorted(
      (a, b) =>
        Date.parse(changedAt(a) ?? '') - Date.parse(changedAt(b) ?? '') ||
        tableLabel(a).localeCompare(tableLabel(b)),
    );
}

/** `2026-01-02 10:00:00 UTC @12`, or for an expired snapshot `before 2026-03-01 ... (@12 expired)`. */
export function changeText(table: InactiveTable): string {
  const { change } = table;
  if (!change) return 'not recorded';
  if (change.time !== null) return `${formatUtc(change.time)} @${change.snapshot}`;
  return change.before === null
    ? `@${change.snapshot} (expired)`
    : `before ${formatUtc(change.before)} (@${change.snapshot} expired)`;
}

/** The hint of the local Query History: never, or the time. */
export const lastReadText = (table: InactiveTable): string =>
  table.lastRead === null ? 'never' : formatUtc(table.lastRead);

/** The days in words. */
export const daysText = (days: number): string => `${count(days)} ${days === 1 ? 'day' : 'days'}`;

/** How many of the tables of the scope have no change for the days. */
export const summaryText = (data: InactiveData): string =>
  `${count(data.tables.length)} of ${count(data.tableCount)} tables without a change for ${daysText(data.days)}`;

export const emptyText = (data: InactiveData): string =>
  `No table of ${count(data.tableCount)} is without a change for ${daysText(data.days)}.`;
