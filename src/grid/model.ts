import { CHANGE_COLUMNS } from '../data/types';
import { count, formatDuration, groupedPlural } from '../shell/numbers';
import { collator } from '../order';
import type { GridColumn, GridData, GridValue, RowKind, TableRef } from '../data/types';

type Row = readonly GridValue[];

interface SortSpec {
  readonly column: number;
  readonly direction: 'asc' | 'desc';
}

interface CellText {
  readonly text: string;
  readonly isNull: boolean;
}

/** Nested values normally arrive as JSON text; anything else in such a column is serialised as JSON. */
export function cellText(value: GridValue, kind: GridColumn['kind']): CellText {
  if (value === null) {
    return { text: 'NULL', isNull: true };
  }
  return {
    text: kind === 'nested' && typeof value !== 'string' ? JSON.stringify(value) : String(value),
    isNull: false,
  };
}

/**
 * The exact text of one cell, for Copy cell: NULL becomes an empty field. Copy cell pastes a single value into SQL or
 * text, so it is never neutralised; Copy row, Copy all and the CSV export neutralise text cells (see `toTsv`, `toCsv`).
 */
export function cellCopyText(value: GridValue, kind: GridColumn['kind']): string {
  return value === null ? '' : cellText(value, kind).text;
}

// Browsers choke on megabytes of text in a cell.
const MAX_CELL_CHARS = 2000;
const MAX_TITLE_CHARS = 1000;
// Only values that the cell may have cut get a tooltip.
const TITLE_FROM_CHARS = 60;
// A screen reader says this for a real NULL, so it differs from the text "NULL".
const NULL_LABEL = 'no value (SQL NULL)';
/** The status line says this when Ctrl+C or Copy cell finds a NULL: the clipboard is left alone. */
export const NULL_NOT_COPIED = 'NULL: nothing copied';

interface CellDisplay {
  readonly text: string;
  readonly isNull: boolean;
  /** The tooltip, empty for none. */
  readonly title: string;
  /** The accessible name that replaces the text, empty for none. */
  readonly label: string;
}

/** Cuts to `max` characters with an ellipsis, without splitting a surrogate pair; the results page uses it too. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const end = (text.charCodeAt(max - 1) & 0xfc00) === 0xd800 ? max - 1 : max;
  return `${text.slice(0, end)}…`;
}

/** What the grid draws for one cell. Copy, export, sort and filter use the full value, not this. */
export function cellDisplay(value: GridValue, kind: GridColumn['kind']): CellDisplay {
  const { text, isNull } = cellText(value, kind);
  return {
    text: clip(text, MAX_CELL_CHARS),
    isNull,
    title: !isNull && text.length > TITLE_FROM_CHARS ? clip(text, MAX_TITLE_CHARS) : '',
    label: isNull ? NULL_LABEL : '',
  };
}

export const ROW_MARKS: Readonly<Record<RowKind, { readonly mark: string; readonly label: string }>> = {
  insert: { mark: '+', label: 'Inserted row' },
  delete: { mark: '−', label: 'Deleted row' },
  'update-before': { mark: '←', label: 'Updated row, before the change' },
  'update-after': { mark: '→', label: 'Updated row, after the change' },
};

/** The columns of an update pair that differ, without `snapshot_id`, `rowid` and `change_type`. */
export function changedColumns(
  rows: readonly Row[],
  kinds: readonly RowKind[],
  index: number,
): ReadonlySet<number> {
  const kind = kinds[index];
  const other = kind === 'update-before' ? index + 1 : kind === 'update-after' ? index - 1 : -1;
  const [before, after] = kind === 'update-after' ? [rows[other], rows[index]] : [rows[index], rows[other]];
  if (!before || !after) {
    return new Set();
  }
  return new Set(
    before.flatMap((value, column) => (column >= CHANGE_COLUMNS && value !== after[column] ? [column] : [])),
  );
}

/** Header click: ascending, then descending, then the original order. */
export function nextSort(current: SortSpec | undefined, column: number): SortSpec | undefined {
  if (current?.column !== column) {
    return { column, direction: 'asc' };
  }
  return current.direction === 'asc' ? { column, direction: 'desc' } : undefined;
}

/** Stable. NULL comes last in both directions. */
export function sortRows(
  rows: readonly Row[],
  columns: readonly GridColumn[],
  sort: SortSpec | undefined,
): readonly Row[] {
  const column = sort && columns[sort.column];
  if (!sort || !column) {
    return rows;
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  // The key of each row is made once: a comparison parses nothing, and n log n of them would parse each value many times.
  const keyed = rows.map((row) => {
    const value = row[sort.column] ?? null;
    return { row, key: value === null ? null : sortKey(value, column.kind) };
  });
  return keyed
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        return a.key === b.key ? 0 : a.key === null ? 1 : -1;
      }
      return sign * compareKeys(a.key, b.key);
    })
    .map(({ row }) => row);
}

/** What a cell is compared by; all keys of one column have the same kind. */
type SortKey =
  | { readonly kind: 'number'; readonly decimal: Decimal | undefined; readonly double: number }
  | { readonly kind: 'boolean'; readonly flag: number }
  | { readonly kind: 'text'; readonly text: string };

function sortKey(value: Exclude<GridValue, null>, kind: GridColumn['kind']): SortKey {
  switch (kind) {
    case 'number':
      return { kind: 'number', decimal: parseDecimal(String(value)), double: Number(value) };
    case 'boolean':
      return { kind: 'boolean', flag: Number(value) };
    default:
      return { kind: 'text', text: cellText(value, kind).text };
  }
}

function compareKeys(a: SortKey, b: SortKey): number {
  if (a.kind === 'number' && b.kind === 'number') return compareNumbers(a, b);
  if (a.kind === 'boolean' && b.kind === 'boolean') return a.flag - b.flag;
  return a.kind === 'text' && b.kind === 'text' ? collator.compare(a.text, b.text) : 0;
}

interface Decimal {
  readonly negative: boolean;
  readonly integer: string;
  readonly fraction: string;
}

const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/;

function parseDecimal(value: string): Decimal | undefined {
  const match = PLAIN_DECIMAL.exec(value);
  if (!match) {
    return undefined;
  }
  const integer = (match[2] ?? '').replace(/^0+(?=\d)/, '');
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  return { negative: match[1] === '-' && (integer !== '0' || fraction !== ''), integer, fraction };
}

// BIGINT, HUGEINT and DECIMAL arrive as strings beyond double precision: compare digit by digit.
function compareNumbers(
  a: { readonly decimal: Decimal | undefined; readonly double: number },
  b: { readonly decimal: Decimal | undefined; readonly double: number },
): number {
  const x = a.decimal;
  const y = b.decimal;
  if (x && y) {
    if (x.negative !== y.negative) {
      return x.negative ? -1 : 1;
    }
    const magnitude = compareMagnitude(x, y);
    return x.negative ? -magnitude : magnitude;
  }
  // Exponent notation, Infinity, NaN: fall back to doubles, with NaN after everything else.
  const p = a.double;
  const q = b.double;
  if (Number.isNaN(p) || Number.isNaN(q)) {
    return Number(Number.isNaN(p)) - Number(Number.isNaN(q));
  }
  return p < q ? -1 : p > q ? 1 : 0;
}

function compareMagnitude(x: Decimal, y: Decimal): number {
  if (x.integer.length !== y.integer.length) {
    return x.integer.length < y.integer.length ? -1 : 1;
  }
  // Trailing zeros are stripped, so a fraction that is a prefix of another is the smaller one.
  const p = x.integer + x.fraction;
  const q = y.integer + y.fraction;
  return p < q ? -1 : p > q ? 1 : 0;
}

/** One filter per column, combined with AND: a case-insensitive substring of the shown text; `NULL`/`!NULL` match NULL cells. */
export function filterRows(
  rows: readonly Row[],
  columns: readonly GridColumn[],
  filters: readonly string[],
): readonly Row[] {
  const tests = columns.flatMap((column, index) => {
    const test = cellTest(filters[index] ?? '', column.kind);
    return test ? [{ index, test }] : [];
  });
  return tests.length === 0
    ? rows
    : rows.filter((row) => tests.every(({ index, test }) => test(row[index] ?? null)));
}

function cellTest(filter: string, kind: GridColumn['kind']): ((value: GridValue) => boolean) | undefined {
  const keyword = filter.trim().toUpperCase();
  if (keyword === 'NULL') {
    return (value) => value === null;
  }
  if (keyword === '!NULL') {
    return (value) => value !== null;
  }
  if (filter === '') {
    return undefined;
  }
  const needle = filter.toLowerCase();
  return (value) => value !== null && cellText(value, kind).text.toLowerCase().includes(needle);
}

/**
 * RFC 4180 CSV. A single column writes an empty field as `""`. Text a spreadsheet would read as a formula
 * (starts with `=`, `+`, `@`, `-`, tab or CR) gets a leading `'`; plain numbers such as `-5` stay as they are.
 */
export function toCsv(columns: readonly GridColumn[], rows: readonly Row[]): string {
  const single = columns.length === 1;
  const header = columns.map((column) => neutralised(column.name));
  const records = rows.map((row) => neutralisedFields(columns, row));
  return `${[header, ...records]
    .map((record) => record.map((field) => (single && field === '' ? '""' : quoted(field, ','))).join(','))
    .join('\r\n')}\r\n`;
}

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

function neutralised(text: string): string {
  return /^[=+@\t\r]/.test(text) || (text.startsWith('-') && !PLAIN_NUMBER.test(text)) ? `'${text}` : text;
}

// A row's cells for copy or export, with text cells neutralised so a spreadsheet does not read them as a formula; a
// number, boolean or nested value is left exact. The same rule as the CSV export, because the clipboard text also pastes
// into spreadsheets.
function neutralisedFields(columns: readonly GridColumn[], row: Row): string[] {
  return fields(columns, row).map((field, index) =>
    columns[index]?.kind === 'text' ? neutralised(field) : field,
  );
}

/**
 * Tab separated for the clipboard of Copy row and Copy all, which paste into spreadsheets: text cells and column names
 * are neutralised like in the CSV export, fields are quoted where needed. Copy cell uses `cellCopyText` and stays exact.
 */
export function toTsv(columns: readonly GridColumn[], rows: readonly Row[], includeHeader: boolean): string {
  const header = columns.map((column) => neutralised(column.name));
  const records = rows.map((row) => neutralisedFields(columns, row));
  return (includeHeader ? [header, ...records] : records)
    .map((record) => record.map((field) => quoted(field, '\t')).join('\t'))
    .join('\n');
}

function fields(columns: readonly GridColumn[], row: Row): string[] {
  return columns.map((column, index) => cellCopyText(row[index] ?? null, column.kind));
}

function quoted(field: string, delimiter: string): string {
  return field.includes(delimiter) || /["\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

const RESERVED_WINDOWS_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;
const MAX_FILE_NAME_CHARACTERS = 80;

/** A file name that is safe in a save dialog: no separators or reserved names, at most 80 characters, ends in `.csv`. */
export function safeCsvFileName(name: string): string {
  const stem = Array.from(name.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').replace(/\.csv$/i, ''))
    .slice(0, MAX_FILE_NAME_CHARACTERS)
    .join('')
    .replace(/[. ]+$/, '');
  const safe = RESERVED_WINDOWS_NAME.test(stem.split('.')[0]?.trimEnd() ?? '') ? `_${stem}` : stem;
  return `${safe === '' ? 'export' : safe}.csv`;
}

/** `schema.table.csv` */
export function csvFileName(table: TableRef): string {
  return safeCsvFileName(`${table.schema}.${table.table}`);
}

/** "3 of 1,000 rows (more rows exist) · 12 ms" */
export function statusText(data: GridData, shown: number): string {
  const total = data.rows.length;
  const rows =
    shown === total ? groupedPlural(total, 'row') : `${count(shown)} of ${groupedPlural(total, 'row')}`;
  return `${rows}${data.truncated ? ' (more rows exist)' : ''} · ${formatDuration(data.elapsedMs)}`;
}

// Rows drawn above and below the visible ones: enough for a panel that grows before the next scroll.
const WINDOW_MARGIN = 100;
// A cell is cut at its maximum width long before this, so a longer text cannot widen the column.
const SIZER_CHARS = 200;

/** The rows of a grid that are in the page, `first` up to but not including `last`. */
export interface RowWindow {
  readonly first: number;
  readonly last: number;
}

/**
 * The rows to draw for a scroll position: the current ones while they reach half a margin past the visible rows,
 * else the visible rows with a margin on each side. `first` is even, so the zebra stripes stay on their rows.
 */
export function rowWindow(
  current: RowWindow | undefined,
  rows: number,
  view: { readonly top: number; readonly height: number; readonly rowHeight: number },
): RowWindow {
  const start = Math.min(rows, Math.floor(view.top / view.rowHeight));
  const end = Math.min(rows, Math.max(start, Math.ceil((view.top + view.height) / view.rowHeight)));
  const half = WINDOW_MARGIN / 2;
  if (current && current.first <= Math.max(0, start - half) && current.last >= Math.min(rows, end + half)) {
    return current;
  }
  const first = Math.max(0, start - WINDOW_MARGIN);
  return { first: first - (first % 2), last: Math.min(rows, end + WINDOW_MARGIN) };
}

/** The longest text of each column over all rows: a grid that draws some rows keeps its widths while it scrolls. */
export function widestTexts(columns: readonly GridColumn[], rows: readonly Row[]): string[] {
  return columns.map((column, index) => {
    let widest = '';
    for (const row of rows) {
      const { text } = cellText(row[index] ?? null, column.kind);
      if (text.length > widest.length) {
        widest = text;
      }
    }
    return clip(widest, SIZER_CHARS);
  });
}

interface View {
  readonly sort: SortSpec | undefined;
  readonly filters: readonly string[];
}

// The page is not retained while hidden; the webview state keeps sort and filters.
interface SavedView extends View {
  readonly result: string;
}

function resultKey(data: GridData): string {
  return `${data.table.schema}.${data.table.table}|${data.rows.length}|${data.elapsedMs}`;
}

export function saveView(data: GridData, view: View): SavedView {
  return { result: resultKey(data), ...view };
}

/** The saved view when it matches this result; else an unsorted, unfiltered one. */
export function restoreView(saved: unknown, data: GridData): View {
  const fresh: View = { sort: undefined, filters: data.columns.map(() => '') };
  if (typeof saved !== 'object' || saved === null) {
    return fresh;
  }
  const { result, sort, filters } = saved as Record<string, unknown>;
  const validFilters =
    Array.isArray(filters) &&
    filters.length === data.columns.length &&
    filters.every((filter) => typeof filter === 'string');
  const columns = data.columns.length;
  if (result !== resultKey(data) || !validFilters) {
    return fresh;
  }
  if (sort === undefined) {
    return { sort: undefined, filters };
  }
  const { column, direction } = (typeof sort === 'object' && sort !== null ? sort : {}) as Partial<SortSpec>;
  const valid =
    typeof column === 'number' &&
    Number.isInteger(column) &&
    column >= 0 &&
    column < columns &&
    (direction === 'asc' || direction === 'desc');
  return valid ? { sort: { column, direction }, filters } : fresh;
}
