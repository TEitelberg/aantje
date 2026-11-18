import type { ColumnInfo, SchemaHistory, SchemaVersion, SnapshotId } from '../catalog/model';
import { diffColumns } from '../catalog/schema-diff';
import type { ColumnChange } from '../catalog/schema-diff';
import { shortUtcMinutes, tableLabel } from '../shell/model';

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

// A sign in front of the text of a change, so that the kind of change does not depend on colour.
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

/** A column as a version of the table has it: names, type, nullability, default, comment and place among its siblings. */
export interface ColumnState {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly defaultValue: string | null;
  readonly comment: string | null;
  readonly parent: number | null;
  /** Among the fields of the same parent, from 0. */
  readonly index: number;
}

interface StateChange {
  readonly snapshot: SnapshotId;
  /** Null when the column is gone after the snapshot. */
  readonly state: ColumnState | null;
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
  /** Oldest first: the state after the first version read and after every version that changed it. */
  readonly states: readonly StateChange[];
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
  /** With `more`: the oldest version read, which shows no change of its own but can be compared from. */
  readonly start: { readonly id: SnapshotId; readonly time: string | null; readonly exists: boolean } | null;
  /** Oldest first. */
  readonly snapshots: readonly HistorySnapshot[];
  /** Table order of the newest version; nested fields follow their parent, dropped columns keep their place. */
  readonly columns: readonly HistoryColumn[];
}

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

/** Every column of a version by id, with its state. */
function statesOf(
  columns: readonly ColumnInfo[],
  parent: number | null = null,
  into = new Map<number, ColumnState>(),
): Map<number, ColumnState> {
  columns.forEach((column, index) => {
    const { name, type, nullable, defaultValue, comment } = column;
    into.set(column.id, { name, type, nullable, defaultValue, comment, parent, index });
    statesOf(column.children, column.id, into);
  });
  return into;
}

const sameState = (a: ColumnState, b: ColumnState): boolean =>
  a.name === b.name &&
  a.type === b.type &&
  a.nullable === b.nullable &&
  a.defaultValue === b.defaultValue &&
  a.comment === b.comment &&
  a.parent === b.parent &&
  a.index === b.index;

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
  const states = new Map<number, StateChange[]>();
  const snapshots: HistorySnapshot[] = [];
  let before: { columns: readonly ColumnInfo[]; table: SchemaVersion['table']; snapshot: SnapshotId } = {
    columns: [],
    table: null,
    snapshot: -1,
  };
  let beforeStates = new Map<number, ColumnState>();

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

  // The state of a column changes only where a version changes it: those are the points to keep.
  const noteStates = (snapshot: SnapshotId, now: Map<number, ColumnState>): void => {
    const keep = (id: number, state: ColumnState | null): void => {
      states.set(id, [...(states.get(id) ?? []), { snapshot, state }]);
    };
    for (const [id, state] of now) {
      const was = beforeStates.get(id);
      if (!was || !sameState(was, state)) {
        keep(id, state);
      }
    }
    for (const id of beforeStates.keys()) {
      if (!now.has(id)) {
        keep(id, null);
      }
    }
    beforeStates = now;
  };

  history.versions.forEach((version, index) => {
    note(version.columns, null);
    noteStates(version.snapshot, statesOf(version.columns));
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

  const first = history.versions[0];
  const newest = history.versions.at(-1)?.table ?? null;
  const lastName = history.versions.findLast((version) => version.table)?.table ?? null;
  const present = new Set(statesOf(history.versions.at(-1)?.columns ?? []).keys());

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
        states: states.get(id) ?? [],
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
    start:
      history.more && first ? { id: first.snapshot, time: first.time, exists: first.table !== null } : null,
    snapshots,
    columns: rows,
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

/** A snapshot that a comparison can start or end at. */
export interface ComparePoint {
  readonly id: SnapshotId;
  /** ISO 8601 in UTC; null for an expired snapshot and for the newest snapshot of the catalog, whose time is not read. */
  readonly time: string | null;
  /** Whether the table exists after the snapshot. */
  readonly exists: boolean;
  /** The newest snapshot of the catalog, newer than every change of the table. */
  readonly latest: boolean;
}

/**
 * The snapshots a comparison can start and end at, oldest first: the oldest version read when older ones were not read,
 * every snapshot that changed the schema, and the newest snapshot of the catalog when it is newer and the table exists.
 */
export function comparePoints(data: SchemaHistoryData): ComparePoint[] {
  const newest = data.snapshots.at(-1)?.id ?? data.start?.id ?? -1;
  return [
    ...(data.start ? [{ ...data.start, latest: false }] : []),
    ...data.snapshots.map(({ id, time, exists }) => ({ id, time, exists, latest: false })),
    ...(data.exists && data.latest > newest
      ? [{ id: data.latest, time: null, exists: true, latest: true }]
      : []),
  ];
}

/** `@30 · 2026-10-30 12:43 UTC`, `@30 · expired`, `@56 · latest`: a snapshot with the time it was made. */
export const pointText = (point: ComparePoint): string =>
  `@${point.id} · ${point.time !== null ? `${shortUtcMinutes(point.time)} UTC` : point.latest ? 'latest' : 'expired'}`;

/** The state of a column at a snapshot: undefined before it was added, null after it was dropped. */
export function stateAt(column: HistoryColumn, snapshot: SnapshotId): ColumnState | null | undefined {
  return column.states.findLast((change) => change.snapshot <= snapshot)?.state;
}

/** The columns of the table at a snapshot, as a version has them: nested, in the order of their places. */
function columnsAt(data: SchemaHistoryData, snapshot: SnapshotId): ColumnInfo[] {
  const present = data.columns.flatMap((column) => {
    const state = stateAt(column, snapshot);
    return state ? [{ id: column.id, state }] : [];
  });
  const build = (parent: number | null): ColumnInfo[] =>
    present
      .filter(({ state }) => state.parent === parent)
      .toSorted((a, b) => a.state.index - b.state.index)
      .map(({ id, state }) => ({
        id,
        name: state.name,
        type: state.type,
        nullable: state.nullable,
        defaultValue: state.defaultValue,
        comment: state.comment,
        children: build(id),
      }));
  return build(null);
}

interface CompareFilter {
  readonly from: SnapshotId;
  readonly to: SnapshotId;
  readonly kinds: readonly CellKind[];
  /** Part of any name the column had, regardless of case; empty for all. */
  readonly text: string;
}

export interface CompareRow {
  readonly column: HistoryColumn;
  /** Undefined or null where the column was not there. */
  readonly from: ColumnState | null | undefined;
  readonly to: ColumnState | null | undefined;
  /** What changed from the one snapshot to the other, as the cells of a change say it. */
  readonly changes: readonly { readonly kind: CellKind; readonly text: string }[];
}

export interface CompareView {
  readonly rows: readonly CompareRow[];
  readonly omittedRows: number;
}

/**
 * The columns that the table had at one of the two snapshots, each with its state at both and what changed between
 * them, as Compare Table at Two Snapshots reads it. While a kind is switched off, only the columns with a change of a
 * chosen kind are left; a field that the text names brings its parents.
 */
export function compareViewOf(data: SchemaHistoryData, filter: CompareFilter): CompareView {
  const kinds = new Set(filter.kinds);
  const narrowed = kinds.size < CELL_KINDS.length;
  const text = filter.text.trim().toLowerCase();
  const changes = new Map<number, { kind: CellKind; text: string }[]>();
  for (const change of diffColumns(columnsAt(data, filter.from), columnsAt(data, filter.to))) {
    changes.set(change.id, [
      ...(changes.get(change.id) ?? []),
      { kind: change.change, text: cellText(change) },
    ]);
  }
  const rowOf = (column: HistoryColumn): CompareRow => ({
    column,
    from: stateAt(column, filter.from),
    to: stateAt(column, filter.to),
    changes: (changes.get(column.id) ?? []).filter((change) => kinds.has(change.kind)),
  });
  const wanted = data.columns.filter((column) => {
    const row = rowOf(column);
    return (
      Boolean(row.from ?? row.to) &&
      (text === '' ||
        [column.path.at(-1) ?? '', ...column.formerNames].some((name) =>
          name.toLowerCase().includes(text),
        )) &&
      (!narrowed || row.changes.length > 0)
    );
  });
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
  return { rows: inOrder.slice(0, MAX_ROWS).map(rowOf), omittedRows: Math.max(inOrder.length - MAX_ROWS, 0) };
}

/** `varchar NOT NULL DEFAULT 'x' · comment: y`, with the name in front where it is not the name of the row. */
export function stateText(state: ColumnState, rowName: string): string {
  return [
    state.name === rowName ? '' : `${state.name}: `,
    state.type,
    state.nullable ? '' : ' NOT NULL',
    state.defaultValue === null ? '' : ` DEFAULT ${state.defaultValue}`,
    state.comment === null ? '' : ` · comment: ${state.comment}`,
  ].join('');
}

/** A column of Search Changes: every column the table had, once each, named as it is now or was last. */
export interface ColumnChoice {
  readonly id: number;
  readonly label: string;
}

export const columnChoices = (data: SchemaHistoryData): ColumnChoice[] =>
  data.columns.map((column) => ({
    id: column.id,
    label: column.now === null && data.exists ? `${columnLabel(column)} (dropped)` : columnLabel(column),
  }));

export interface ColumnHistoryRow {
  readonly snapshot: HistorySnapshot;
  readonly kind: CellKind;
  readonly text: string;
}

/** Every change of one column, newest first; only the snapshots that changed it. */
export function columnHistoryOf(data: SchemaHistoryData, columnId: number): ColumnHistoryRow[] {
  const cells = data.columns.find((column) => column.id === columnId)?.cells ?? [];
  // Newest snapshot first; the changes of one snapshot keep their order.
  return cells
    .flatMap((cell) => {
      const snapshot = data.snapshots.find((candidate) => candidate.id === cell.snapshot);
      return snapshot ? [{ snapshot, kind: cell.kind, text: cell.text }] : [];
    })
    .toSorted((a, b) => b.snapshot.id - a.snapshot.id);
}

/** The snapshots between two snapshots that changed the schema, newest first: the later one included, the earlier not. */
export const snapshotsBetween = (data: SchemaHistoryData, a: SnapshotId, b: SnapshotId): HistorySnapshot[] =>
  data.snapshots.filter(({ id }) => id > Math.min(a, b) && id <= Math.max(a, b)).toReversed();
