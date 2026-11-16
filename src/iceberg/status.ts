import type { ChangeAction } from '../catalog/changes';
import { markdownText } from '../markdown';
import { icebergKeyOf } from './records';
import type { IcebergCopyRecord } from './records';

/** Why a copied table is not the table of the lake: the states of a table that is not in sync, and `not-checked`. */
export type TableProblem =
  'lake-dropped' | 'iceberg-missing' | 'iceberg-replaced' | 'iceberg-ahead' | 'lake-newer' | 'not-checked';

/** The strongest problem first: a table that is gone says that, not that the lake also changed. */
const ORDER: readonly TableProblem[] = [
  'lake-dropped',
  'iceberg-missing',
  'iceberg-replaced',
  'iceberg-ahead',
  'lake-newer',
  'not-checked',
];

export const PROBLEM_TEXT: Readonly<Record<TableProblem, string>> = {
  'lake-dropped': 'Dropped in the lake',
  'iceberg-missing': 'Missing in Iceberg',
  'iceberg-replaced': 'Replaced in Iceberg',
  'iceberg-ahead': 'Iceberg is ahead',
  'lake-newer': 'Lake is newer',
  'not-checked': 'Not checked',
};

/** What the Iceberg catalog says of one table. Snapshot ids are text: they are 64 bit. */
export type IcebergFact =
  | { readonly kind: 'table'; readonly current: string | undefined; readonly log: readonly string[] }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string };

/** A snapshot that changed a table, with what it did to it (inserted, deleted, altered, renamed, ...). */
export interface LakeChange {
  readonly snapshot: number;
  readonly time: string;
  readonly actions: ReadonlySet<ChangeAction | 'renamed'>;
}

/** What the lake says: its newest snapshot, its tables by id, and the changes of the copied tables after a snapshot. */
export interface LakeFacts {
  readonly newest: number;
  readonly tables: ReadonlyMap<number, { readonly schema: string; readonly name: string }>;
  /** The snapshots that changed the content of the table (data, schema, rename), oldest first; not compactions. */
  readonly changes: (tableId: number, after: number) => readonly LakeChange[];
}

export interface TableStatus {
  readonly schema: string;
  readonly table: string;
  /** `namespace.table` of the Iceberg table when it is not the schema and table of the lake. */
  readonly iceberg?: string;
  /** Empty: the table is in sync. */
  readonly problems: readonly TableProblem[];
  readonly copiedSnapshot: number;
  /** How many snapshots after the copy changed the table in the lake. */
  readonly snapshotsBehind: number;
  readonly lakeChangedAt: string | undefined;
  readonly icebergRemembered: string | undefined;
  readonly icebergCurrent: string | undefined;
  /** The message of a check that failed, free of secrets. */
  readonly checkError: string | undefined;
}

export interface LakeStatus {
  readonly tables: readonly TableStatus[];
  /** Tables of the lake that this copy does not have: created after it, or never copied. */
  readonly added: readonly { readonly schema: string; readonly table: string }[];
  /** True only when every copied table is in sync and the lake has no table more. */
  readonly inSync: boolean;
}

const keyOf = (schema: string, table: string): string => `${schema}.${table}`;

/** Judges every record of one copy target against the lake and the Iceberg catalog. */
export function judge(
  records: readonly IcebergCopyRecord[],
  lake: LakeFacts,
  iceberg: ReadonlyMap<string, IcebergFact>,
): LakeStatus {
  const byName = new Map([...lake.tables].map(([id, { schema, name }]) => [keyOf(schema, name), id]));
  const known = new Set<number>();
  const tables = records.map((record): TableStatus => {
    const id = record.tableId !== undefined && lake.tables.has(record.tableId) ? record.tableId : undefined;
    const idByName = byName.get(keyOf(record.schema, record.table));
    // A record from before table ids were kept is found by name; a renamed table has its id.
    const tableId = id ?? (record.tableId === undefined ? idByName : undefined);
    if (tableId !== undefined) known.add(tableId);
    const found = new Set<TableProblem>();
    let behind: readonly { readonly snapshot: number; readonly time: string }[] = [];
    if (tableId === undefined) {
      found.add('lake-dropped');
    } else {
      behind = lake.changes(tableId, record.snapshot);
      if (behind.length > 0) found.add('lake-newer');
    }
    const located = icebergKeyOf(record);
    const fact = iceberg.get(located);
    let current: string | undefined;
    let checkError: string | undefined;
    if (fact === undefined || fact.kind === 'error') {
      found.add('not-checked');
      checkError = fact?.kind === 'error' ? fact.message : 'The Iceberg catalog was not asked.';
    } else if (fact.kind === 'missing') {
      found.add('iceberg-missing');
    } else {
      current = fact.current;
      if (record.icebergSnapshot === undefined) {
        found.add('not-checked');
        checkError = 'No Iceberg snapshot was remembered for this copy.';
      } else if (current !== record.icebergSnapshot) {
        found.add(fact.log.includes(record.icebergSnapshot) ? 'iceberg-ahead' : 'iceberg-replaced');
      }
    }
    return {
      schema: record.schema,
      table: record.table,
      ...(located === keyOf(record.schema, record.table) ? {} : { iceberg: located }),
      problems: ORDER.filter((problem) => found.has(problem)),
      copiedSnapshot: record.snapshot,
      snapshotsBehind: behind.length,
      lakeChangedAt: behind.at(-1)?.time,
      icebergRemembered: record.icebergSnapshot,
      icebergCurrent: current,
      checkError,
    };
  });
  // A table that no record has is missing from the copy only where a copy covered it: the lake, or its schema.
  const wholeLake = records.some((record) => (record.scope ?? 'lake') === 'lake');
  const schemas = new Set(
    records.filter((record) => record.scope === 'schema').map((record) => record.schema),
  );
  const covered = (schema: string): boolean => wholeLake || schemas.has(schema);
  const added = [...lake.tables]
    .filter(([id, { schema }]) => !known.has(id) && covered(schema))
    .map(([, { schema, name }]) => ({ schema, table: name }))
    .toSorted((a, b) => keyOf(a.schema, a.table).localeCompare(keyOf(b.schema, b.table)));
  return {
    tables,
    added,
    inSync: tables.length > 0 && added.length === 0 && tables.every((table) => table.problems.length === 0),
  };
}

/** The one line of the tree row: `in sync at @7475`, or how many tables are not. */
export function summaryOf(status: LakeStatus, newest: number): string {
  if (status.inSync) return `in sync at @${newest}`;
  const out = status.tables.filter((table) => table.problems.length > 0).length + status.added.length;
  return `${out} ${out === 1 ? 'table' : 'tables'} out of sync`;
}

/** The sentence about a table for its tooltip (Markdown: the name of the target is escaped). */
export function tableLine(status: TableStatus, target: string): string {
  const name = markdownText(target);
  return status.problems.length === 0
    ? `Iceberg · ${name}: in sync`
    : `Iceberg · ${name}: ${status.problems.map((problem) => PROBLEM_TEXT[problem].toLowerCase()).join(', ')}`;
}
