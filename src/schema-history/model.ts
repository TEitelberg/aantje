import type { ColumnInfo, SchemaHistory, SchemaVersion, SnapshotId } from '../catalog/model';
import { diffColumns } from '../catalog/schema-diff';
import type { ColumnChange } from '../catalog/schema-diff';
import { formatUtc, tableLabel } from '../shell/model';

/** The kinds of `diffColumns`; `removed` is labelled Dropped. */
export type CellKind = ColumnChange['change'];

export const CELL_KINDS: readonly CellKind[] = [
  'added',
  'removed',
  'renamed',
  'typeChanged',
  'nullableChanged',
  'defaultChanged',
  'commentChanged',
  'moved',
];

export const SCHEMA_HISTORY_KIND_LABEL: Readonly<Record<CellKind, string>> = {
  added: 'Added',
  removed: 'Dropped',
  renamed: 'Renamed',
  typeChanged: 'Type changed',
  nullableChanged: 'Nullability changed',
  defaultChanged: 'Default changed',
  commentChanged: 'Comment changed',
  moved: 'Moved',
};

// A sign in front of the cell text, so that the kind of change does not depend on colour.
const KIND_SYMBOL: Readonly<Record<CellKind, string>> = {
  added: '+',
  removed: '−',
  renamed: '↔',
  typeChanged: 'Δ',
  nullableChanged: '!',
  defaultChanged: '=',
  commentChanged: '#',
  moved: '↕',
};

export const OLDER_NOTE =
  'The table has older schema versions than the newest ones shown. Older ones are not read.';

export const LEGEND =
  'Signs: ' +
  CELL_KINDS.map((kind) => `${KIND_SYMBOL[kind]} ${SCHEMA_HISTORY_KIND_LABEL[kind].toLowerCase()}`).join(
    ', ',
  ) +
  '.';

// The other rows stay behind the text filter.
export const MAX_ROWS = 100;

export const omittedRowsNote = (omitted: number): string =>
  `${omitted} ${omitted === 1 ? 'row' : 'rows'} not shown: the first ${MAX_ROWS} are drawn. Type in the column filter to see the others.`;

interface HistoryCell {
  readonly snapshot: SnapshotId;
  readonly kind: CellKind;
  /** Sign and change, such as `Δ type: int32 → int64`. */
  readonly text: string;
}

// `name` is the qualified name after the event; a drop keeps the last name.
interface TableEvent {
  readonly kind: 'created' | 'renamed' | 'dropped';
  readonly name: string;
  readonly from: string | null;
}

interface HistorySnapshot {
  readonly id: SnapshotId;
  /** ISO 8601 in UTC; null when the snapshot has expired. */
  readonly time: string | null;
  readonly author: string | null;
  readonly message: string | null;
  readonly events: readonly TableEvent[];
  /** The earlier schema version to compare with; null when the table was created here. */
  readonly previous: SnapshotId | null;
  readonly exists: boolean;
}

// A renamed column is one row.
interface HistoryColumn {
  readonly id: number;
  readonly parent: number | null;
  /** Names from the top-level column down, as in the newest version that has the column. */
  readonly path: readonly string[];
  /** Oldest first, without the current name. */
  readonly formerNames: readonly string[];
  /** Null when the column or the table is dropped. */
  readonly now: string | null;
  readonly cells: readonly HistoryCell[];
}

/** What the extension reads and posts to the page; the page computes everything else. */
export interface SchemaHistoryData {
  readonly connection: string;
  readonly tableId: number;
  /** Of the newest version; the schema is null when the catalog has no row for it. */
  readonly schema: string | null;
  readonly name: string;
  readonly latest: SnapshotId;
  readonly exists: boolean;
  /** The table has older versions that were not read. */
  readonly more: boolean;
  /** Oldest first. */
  readonly snapshots: readonly HistorySnapshot[];
  /** Table order of the newest version; nested fields follow their parent, dropped columns keep their place. */
  readonly columns: readonly HistoryColumn[];
}

export { tableLabel };

const qualified = ({ schemaName, name }: { schemaName: string | null; name: string }): string =>
  tableLabel({ schema: schemaName, name });

const orNone = (value: string | null): string => value ?? 'none';

function cellText(change: ColumnChange): string {
  const symbol = KIND_SYMBOL[change.change];
  switch (change.change) {
    case 'added':
      return `${symbol} added: ${change.type}`;
    case 'removed':
      return `${symbol} dropped`;
    case 'renamed':
      return `${symbol} renamed: ${change.from} → ${change.path.at(-1) ?? ''}`;
    case 'typeChanged':
      return `${symbol} type: ${change.from} → ${change.to}`;
    case 'nullableChanged':
      return `${symbol} ${change.to ? 'now nullable' : 'now NOT NULL'}`;
    case 'defaultChanged':
      return `${symbol} default: ${orNone(change.from)} → ${orNone(change.to)}`;
    case 'commentChanged':
      return `${symbol} comment changed`;
    case 'moved':
      return `${symbol} moved: position ${change.from + 1} → ${change.to + 1}`;
  }
}

// A new id goes after its preceding sibling in `next`, so that dropped columns keep their place.
function mergeOrder(list: number[], next: readonly number[]): void {
  let after = -1;
  for (const id of next) {
    const at = list.indexOf(id);
    if (at >= 0) {
      after = at;
    } else {
      after += 1;
      list.splice(after, 0, id);
    }
  }
}

function tableEvent(
  before: { schemaName: string | null; name: string } | null,
  now: { schemaName: string | null; name: string } | null,
): TableEvent[] {
  if (now && !before) {
    return [{ kind: 'created', name: qualified(now), from: null }];
  }
  if (before && !now) {
    return [{ kind: 'dropped', name: qualified(before), from: null }];
  }
  return before && now && qualified(before) !== qualified(now)
    ? [{ kind: 'renamed', name: qualified(now), from: qualified(before) }]
    : [];
}

/** Diffs schema versions by column id, so a rename stays one row; with `more`, the oldest version shows no change. */
export function buildHistory(
  connection: string,
  tableId: number,
  latest: SnapshotId,
  history: SchemaHistory,
): SchemaHistoryData {
  const names = new Map<number, string[]>();
  const parents = new Map<number, number | null>();
  const types = new Map<number, string>();
  const order = new Map<number | null, number[]>();
  const cells = new Map<number, HistoryCell[]>();
  const snapshots: HistorySnapshot[] = [];
  let before: { columns: readonly ColumnInfo[]; table: SchemaVersion['table']; snapshot: SnapshotId } = {
    columns: [],
    table: null,
    snapshot: -1,
  };

  const note = (columns: readonly ColumnInfo[], parent: number | null): void => {
    const siblings = order.get(parent) ?? [];
    order.set(parent, siblings);
    mergeOrder(
      siblings,
      columns.map((column) => column.id),
    );
    for (const column of columns) {
      const known = names.get(column.id) ?? [];
      if (known.at(-1) !== column.name) {
        names.set(column.id, [...known, column.name]);
      }
      parents.set(column.id, parent);
      types.set(column.id, column.type);
      note(column.children, column.id);
    }
  };

  history.versions.forEach((version, index) => {
    note(version.columns, null);
    if (!(index === 0 && history.more)) {
      const events = tableEvent(before.table, version.table);
      const changes = version.table ? diffColumns(before.columns, version.columns) : [];
      for (const change of changes) {
        cells.set(change.id, [
          ...(cells.get(change.id) ?? []),
          { snapshot: version.snapshot, kind: change.change, text: cellText(change) },
        ]);
      }
      if (events.length > 0 || changes.length > 0) {
        snapshots.push({
          id: version.snapshot,
          time: version.time,
          author: version.author,
          message: version.commitMessage,
          events,
          previous: before.table ? before.snapshot : null,
          exists: version.table !== null,
        });
      }
    }
    before = { columns: version.columns, table: version.table, snapshot: version.snapshot };
  });

  const newest = history.versions.at(-1)?.table ?? null;
  const lastName = history.versions.findLast((version) => version.table)?.table ?? null;
  const present = new Set<number>();
  const collect = (columns: readonly ColumnInfo[]): void => {
    for (const column of columns) {
      present.add(column.id);
      collect(column.children);
    }
  };
  collect(history.versions.at(-1)?.columns ?? []);

  const rows: HistoryColumn[] = [];
  const walk = (parent: number | null, path: readonly string[]): void => {
    for (const id of order.get(parent) ?? []) {
      if (parents.get(id) !== parent) {
        continue;
      }
      const all = names.get(id) ?? [];
      const name = all.at(-1) ?? '';
      rows.push({
        id,
        parent,
        path: [...path, name],
        formerNames: [...new Set(all)].filter((candidate) => candidate !== name),
        now: present.has(id) ? (types.get(id) ?? null) : null,
        cells: cells.get(id) ?? [],
      });
      walk(id, [...path, name]);
    }
  };
  walk(null, []);

  return {
    connection,
    tableId,
    schema: lastName?.schemaName ?? null,
    name: lastName?.name ?? `table #${tableId}`,
    latest,
    exists: newest !== null,
    more: history.more,
    snapshots,
    columns: rows,
  };
}

interface Filter {
  readonly kinds: readonly CellKind[];
  /** Part of any name the column had, case-insensitive; empty for all. */
  readonly text: string;
  /** Both ends included; undefined for all. */
  readonly range?: { readonly from: SnapshotId; readonly to: SnapshotId };
}

interface ViewRow {
  readonly column: HistoryColumn;
  readonly cells: readonly HistoryCell[];
}

export interface SchemaHistoryView {
  /** Oldest first. */
  readonly snapshots: readonly HistorySnapshot[];
  readonly rows: readonly ViewRow[];
  readonly omittedRows: number;
}

/** Rows that match the text and keep a change, with their parents, and snapshots with a cell or table event. */
export function schemaHistoryViewOf(data: SchemaHistoryData, filter: Filter): SchemaHistoryView {
  const kinds = new Set(filter.kinds);
  const { range } = filter;
  const inRange = (id: SnapshotId): boolean => !range || (id >= range.from && id <= range.to);
  const narrowed = kinds.size < CELL_KINDS.length || data.snapshots.some(({ id }) => !inRange(id));
  const text = filter.text.trim().toLowerCase();
  const leftIn = (column: HistoryColumn): HistoryCell[] =>
    column.cells.filter((cell) => kinds.has(cell.kind) && inRange(cell.snapshot));
  const wanted = data.columns.filter(
    (column) =>
      (text === '' ||
        [column.path.at(-1) ?? '', ...column.formerNames].some((name) =>
          name.toLowerCase().includes(text),
        )) &&
      (!narrowed || leftIn(column).length > 0),
  );
  const included = new Set<number>();
  const byId = new Map(data.columns.map((column) => [column.id, column]));
  for (const column of wanted) {
    let at: HistoryColumn | undefined = column;
    while (at && !included.has(at.id)) {
      included.add(at.id);
      at = at.parent === null ? undefined : byId.get(at.parent);
    }
  }
  const inOrder = data.columns.filter((column) => included.has(column.id));
  const rows = inOrder.slice(0, MAX_ROWS).map((column): ViewRow => ({ column, cells: leftIn(column) }));
  const withCells = new Set(rows.flatMap((row) => row.cells.map((cell) => cell.snapshot)));
  return {
    snapshots: data.snapshots.filter(
      ({ id, events }) => inRange(id) && (withCells.has(id) || events.length > 0),
    ),
    rows,
    omittedRows: inOrder.length - rows.length,
  };
}

export function eventText(event: TableEvent): string {
  switch (event.kind) {
    case 'created':
      return `created as ${event.name}`;
    case 'renamed':
      return `renamed ${event.from ?? ''} → ${event.name}`;
    case 'dropped':
      return `dropped (${event.name})`;
  }
}

export function columnLabel(column: HistoryColumn): string {
  return column.formerNames.length === 0
    ? column.path.join('.')
    : `${column.path.join('.')} (formerly ${column.formerNames.join(', ')})`;
}

export interface SchemaHistoryDetail {
  readonly snapshot: HistorySnapshot;
  readonly timeText: string;
  readonly changes: readonly {
    readonly columnId: number;
    readonly column: string;
    readonly kind: CellKind;
    readonly text: string;
  }[];
  readonly previous: SnapshotId | null;
  readonly hasLatest: boolean;
}

export function schemaHistoryDetailOf(
  data: SchemaHistoryData,
  id: SnapshotId,
): SchemaHistoryDetail | undefined {
  const snapshot = data.snapshots.find((candidate) => candidate.id === id);
  if (!snapshot) {
    return undefined;
  }
  return {
    snapshot,
    timeText: snapshot.time === null ? 'expired' : formatUtc(snapshot.time),
    changes: data.columns.flatMap((column) =>
      column.cells
        .filter((cell) => cell.snapshot === id)
        .map((cell) => ({
          columnId: column.id,
          column: column.path.join('.'),
          kind: cell.kind,
          text: cell.text,
        })),
    ),
    previous: snapshot.exists ? snapshot.previous : null,
    hasLatest: snapshot.exists && data.exists && id < data.latest,
  };
}
