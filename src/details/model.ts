import type { ConnectionProfile } from '../connections/profile';
import { visibleLine } from '../markdown';
import { compareText } from '../order';
import { approximateCount, count, formatBytes, shortUtcMinutes } from '../shell/model';
import type { ReportScope } from '../shell/scope';

/** The tables and views that the page and the document hold; a scope with more says how many are left out. */
export const OBJECT_LIMIT = 1000;

/** The rows of the Markdown document and of Copy; a filter narrows the rest. */
export const MARKDOWN_ROWS = 500;

/** A snapshot that changed or created an object: its id and its time (ISO 8601, UTC). */
export interface SnapshotMark {
  readonly snapshot: number;
  readonly time: string;
}

/** What every row has: a table, a view or a macro, its newest change and its creation, and its dependencies. */
interface DetailsBase {
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
  /** Null when no snapshot of the window read changed it. */
  readonly lastChange: SnapshotMark | null;
  readonly created: SnapshotMark | null;
  /** Objects that it uses and that use it; null when the dependencies could not be read. */
  readonly dependsOn: number | null;
  readonly usedBy: number | null;
}

/** A table or view of the scope; the figures of the files are a table's only. */
export interface DetailsObject extends DetailsBase {
  readonly kind: 'table' | 'view';
  readonly comment: string | null;
  readonly rows?: number;
  readonly approximate?: true;
  /** Data files plus delete files. */
  readonly sizeBytes?: number;
  readonly files?: number;
  /** Data files below `smallFileBytes`. */
  readonly smallFiles?: number;
  readonly deleteFiles?: number;
  /** Null when they are not counted: at an older snapshot, or when the read failed. */
  readonly inlinedRows?: number | null;
  /** `kind, month(ts)`, `sensor ASC`; null when the table has none at the snapshot. */
  readonly partitioning?: string | null;
  readonly sortOrder?: string | null;
}

/** A macro of the scope; its overloads and the parameters of the first one. */
export interface DetailsMacro extends DetailsBase {
  readonly kind: 'scalar' | 'table';
  readonly overloads: number;
  readonly parameters: string;
}

/** What the extension sends to the page. */
export interface DetailsData {
  readonly connection: string;
  readonly scope: ReportScope;
  readonly snapshot: number;
  /** ISO 8601, UTC. */
  readonly readAt: string;
  /** The tables and views of the scope at the snapshot, at most `OBJECT_LIMIT`, by schema and name. */
  readonly objects: readonly DetailsObject[];
  /** All tables and views of the scope; `objects` holds the first ones. */
  readonly objectCount: number;
  readonly macros: readonly DetailsMacro[];
  readonly smallFileBytes: number;
  /**
   * The oldest snapshot whose changes were read, when older ones exist: a change or creation before it is not known.
   * Null when every snapshot up to `snapshot` was read.
   */
  readonly changesFrom: number | null;
  /** How the inlined rows were counted: at the newest state, not at an older snapshot, or not because the read failed. */
  readonly inlined: 'counted' | 'older' | 'failed' | 'partial';
  /** False when the dependencies could not be read. */
  readonly dependencies: boolean;
}

export const TABS = [
  { id: 'objects', label: 'Tables and Views' },
  { id: 'macros', label: 'Macros' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** A cell: its text, and whether the text comes from the catalog (the document shows it as code). */
export interface Cell {
  readonly text: string;
  readonly catalog?: true;
}

/** A column of a list: how a row shows and sorts in it; missing values sort last. */
export interface Column<Row> {
  readonly key: string;
  readonly label: string;
  readonly number?: true;
  readonly sort: (row: Row) => number | string | null;
  readonly cell: (row: Row, data: DetailsData) => Cell;
}

const catalog = (text: string | null | undefined): Cell =>
  text === null || text === undefined || text === ''
    ? { text: '' }
    : { text: visibleLine(text), catalog: true };
const plain = (text: string): Cell => ({ text });
const number = (value: number | null | undefined): Cell =>
  plain(value === null || value === undefined ? '–' : count(value));

/** `@12 · 2026-10-30 12:43`, or `before @5` when it is older than the snapshots read, `–` when unknown. */
function markText(mark: SnapshotMark | null, data: DetailsData): string {
  if (mark !== null) return `@${mark.snapshot} · ${shortUtcMinutes(mark.time)}`;
  return data.changesFrom === null ? '–' : `before @${data.changesFrom}`;
}

const SCHEMA: Column<DetailsBase> = {
  key: 'schema',
  label: 'Schema',
  sort: (row) => row.schema,
  cell: (row) => catalog(row.schema),
};
const NAME: Column<DetailsBase> = {
  key: 'name',
  label: 'Name',
  sort: (row) => row.name,
  cell: (row) => catalog(row.name),
};
const LAST_CHANGE: Column<DetailsBase> = {
  key: 'lastChange',
  label: 'Last change',
  sort: (row) => row.lastChange?.snapshot ?? null,
  cell: (row, data) => plain(markText(row.lastChange, data)),
};
const CREATED: Column<DetailsBase> = {
  key: 'created',
  label: 'Created',
  sort: (row) => row.created?.snapshot ?? null,
  cell: (row, data) => plain(markText(row.created, data)),
};
const DEPENDS_ON: Column<DetailsBase> = {
  key: 'dependsOn',
  label: 'Depends on',
  number: true,
  sort: (row) => row.dependsOn,
  cell: (row) => number(row.dependsOn),
};
const USED_BY: Column<DetailsBase> = {
  key: 'usedBy',
  label: 'Used by',
  number: true,
  sort: (row) => row.usedBy,
  cell: (row) => number(row.usedBy),
};

/** The columns of the tables and views, in their order on the page. */
export const OBJECT_COLUMNS: readonly Column<DetailsObject>[] = [
  SCHEMA,
  NAME,
  { key: 'kind', label: 'Kind', sort: (row) => row.kind, cell: (row) => plain(row.kind) },
  { key: 'comment', label: 'Comment', sort: (row) => row.comment, cell: (row) => catalog(row.comment) },
  {
    key: 'rows',
    label: 'Rows',
    number: true,
    sort: (row) => row.rows ?? null,
    cell: (row) => plain(row.rows === undefined ? '–' : approximateCount(row.rows, row.approximate)),
  },
  {
    key: 'size',
    label: 'Size',
    number: true,
    sort: (row) => row.sizeBytes ?? null,
    cell: (row) => plain(row.sizeBytes === undefined ? '–' : formatBytes(row.sizeBytes)),
  },
  {
    key: 'files',
    label: 'Data files',
    number: true,
    sort: (row) => row.files ?? null,
    cell: (row) => number(row.files),
  },
  {
    key: 'smallFiles',
    label: 'Small files',
    number: true,
    sort: (row) => row.smallFiles ?? null,
    cell: (row) => number(row.smallFiles),
  },
  {
    key: 'deleteFiles',
    label: 'Delete files',
    number: true,
    sort: (row) => row.deleteFiles ?? null,
    cell: (row) => number(row.deleteFiles),
  },
  {
    key: 'inlinedRows',
    label: 'Inlined rows',
    number: true,
    sort: (row) => row.inlinedRows ?? null,
    cell: (row) => number(row.inlinedRows),
  },
  {
    key: 'partitioning',
    label: 'Partitioning',
    sort: (row) => row.partitioning ?? null,
    cell: (row) => catalog(row.partitioning),
  },
  {
    key: 'sortOrder',
    label: 'Sort order',
    sort: (row) => row.sortOrder ?? null,
    cell: (row) => catalog(row.sortOrder),
  },
  LAST_CHANGE,
  CREATED,
  DEPENDS_ON,
  USED_BY,
];

/** The columns of the macros; they are all shown. */
export const MACRO_COLUMNS: readonly Column<DetailsMacro>[] = [
  SCHEMA,
  NAME,
  { key: 'kind', label: 'Kind', sort: (row) => row.kind, cell: (row) => plain(`${row.kind} macro`) },
  {
    key: 'parameters',
    label: 'Parameters',
    sort: (row) => row.parameters,
    cell: (row) => catalog(row.overloads > 1 ? `${row.parameters} (+${row.overloads - 1})` : row.parameters),
  },
  LAST_CHANGE,
  CREATED,
  DEPENDS_ON,
  USED_BY,
];

export const OBJECT_COLUMN_KEYS = OBJECT_COLUMNS.map(({ key }) => key);
export const SORT_KEYS = [...new Set([...OBJECT_COLUMN_KEYS, ...MACRO_COLUMNS.map(({ key }) => key)])];

/** The columns shown until the user chooses others. */
export const DEFAULT_COLUMNS: readonly string[] = [
  'schema',
  'name',
  'kind',
  'rows',
  'size',
  'files',
  'smallFiles',
  'deleteFiles',
  'inlinedRows',
  'lastChange',
];

export interface Sort {
  readonly key: string;
  readonly descending: boolean;
}

export const DEFAULT_SORT: Sort = { key: 'name', descending: false };

/** The choices of the page that Copy and Open as Markdown follow. */
export interface DetailsView {
  readonly tab: TabId;
  readonly filter: string;
  readonly sort: Sort;
  /** The columns of the tables and views that are shown, by key. */
  readonly columns: readonly string[];
}

export const DEFAULT_VIEW: DetailsView = {
  tab: 'objects',
  filter: '',
  sort: DEFAULT_SORT,
  columns: DEFAULT_COLUMNS,
};

/** The rows whose `schema.name` holds the text, ignoring case; all of them for an empty filter. */
export function matching<Row extends DetailsBase>(rows: readonly Row[], filter: string): Row[] {
  const wanted = filter.trim().toLowerCase();
  return rows.filter((row) => wanted === '' || `${row.schema}.${row.name}`.toLowerCase().includes(wanted));
}

const byName = (a: DetailsBase, b: DetailsBase): number =>
  compareText(a.schema, b.schema) || compareText(a.name, b.name);

/** The rows in the order of a column, ties by schema and name; a missing value goes last either way. */
export function sorted<Row extends DetailsBase>(
  rows: readonly Row[],
  columns: readonly Column<Row>[],
  { key, descending }: Sort,
): Row[] {
  const column = columns.find((candidate) => candidate.key === key) ?? NAME;
  return rows.toSorted((a, b) => {
    const [x, y] = [column.sort(a), column.sort(b)];
    if (x === null || y === null) return x === y ? byName(a, b) : x === null ? 1 : -1;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : compareText(String(x), String(y));
    return (descending ? -order : order) || byName(a, b);
  });
}

/** The list of a tab as the view shows it: the chosen columns, the rows that match, in the chosen order. */
export function shownList(
  data: DetailsData,
  view: DetailsView,
): {
  readonly columns: readonly Column<DetailsObject>[] | readonly Column<DetailsMacro>[];
  readonly rows: readonly (DetailsObject | DetailsMacro)[];
  readonly cells: readonly (readonly Cell[])[];
} {
  if (view.tab === 'macros') {
    const rows = sorted(matching(data.macros, view.filter), MACRO_COLUMNS, view.sort);
    return {
      columns: MACRO_COLUMNS,
      rows,
      cells: rows.map((row) => MACRO_COLUMNS.map((c) => c.cell(row, data))),
    };
  }
  const columns = OBJECT_COLUMNS.filter(({ key }) => view.columns.includes(key));
  const rows = sorted(matching(data.objects, view.filter), OBJECT_COLUMNS, view.sort);
  return { columns, rows, cells: rows.map((row) => columns.map((c) => c.cell(row, data))) };
}

/** The notes under the list: what the figures leave out. */
export function detailsNotes(data: DetailsData): string[] {
  return [
    ...(data.objectCount > data.objects.length
      ? [
          `${count(data.objectCount - data.objects.length)} more tables and views are not part of this report (limit: ${OBJECT_LIMIT}).`,
        ]
      : []),
    'Rows are those of the data files without the deleted ones; inlined rows are counted apart. Small files are data files below 16 MiB.',
    ...(data.inlined === 'older'
      ? ['Inlined rows are counted at the newest snapshot only; the tree shows an older one.']
      : data.inlined === 'failed'
        ? ['The inlined rows could not be read.']
        : data.inlined === 'partial'
          ? ['The inlined rows of some tables could not be read or are beyond the limit.']
          : []),
    ...(data.changesFrom === null
      ? []
      : [
          `Last change and created come from the snapshots @${data.changesFrom} to @${data.snapshot}; "before @${data.changesFrom}" marks an object that none of them changed. Maintenance of files does not count as a change.`,
        ]),
    ...(data.dependencies ? [] : ['The dependencies could not be read.']),
  ];
}

/** The Details report of a connection, as the commands that offer it use it. */
export interface DetailsReport {
  show(profile: ConnectionProfile, scope: ReportScope): Promise<void>;
  dispose(): void;
}
