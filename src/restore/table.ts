import { qualifiedName, quoteIdentifier } from '../catalog/ddl';
import type { ColumnInfo, PartitioningInfo, SnapshotId } from '../catalog/model';
import { diffColumns } from '../catalog/schema-diff';
import { checkedScript, commented, isStatement } from '../ddl-script/check';
import type { CatalogCheck, Tokenize } from '../ddl-script/check';
import { commentName } from '../ddl-script/names';
import { layoutDiffers, typeDiffers } from '../ddl-script/table-state';
import type { TableState } from '../ddl-script/table-state';
import { tableSteps, WARNINGS } from '../ddl-script/table-update';
import type { Step } from '../ddl-script/table-update';
import { atVersion, newestComment } from '../script';
import { deleteWarning, NOTHING_RUN, snapshotText } from './text';

// Restore Table to Snapshot: DELETE and INSERT ... AT (VERSION => n) in one transaction, so the table keeps its id.
// Columns match by id; what the structure lost since the snapshot is in commented steps, which Script as Update of the
// snapshot state against the table now writes (`tableSteps`), with the names of today.

export interface TableRestore {
  /** The snapshot to restore; `time` is ISO 8601, UTC. */
  readonly snapshot: { readonly id: SnapshotId; readonly time: string };
  /** The table at that snapshot, named as it was then. */
  readonly then: TableState;
  /** The table at the newest snapshot, which the statements change. */
  readonly now: TableState;
  /** The snapshot that the tree shows when it is pinned. */
  readonly pinned: SnapshotId | undefined;
}

/** The top-level columns of the snapshot, matched by id with those of today. */
interface Pairing {
  readonly kept: readonly { readonly then: ColumnInfo; readonly now: ColumnInfo }[];
  /** In the snapshot, not in the table now. */
  readonly gone: readonly ColumnInfo[];
  /** In the table now, not in the snapshot. */
  readonly added: readonly ColumnInfo[];
}

function pair(then: readonly ColumnInfo[], now: readonly ColumnInfo[]): Pairing {
  const nowById = new Map(now.map((column) => [column.id, column]));
  const thenIds = new Set(then.map(({ id }) => id));
  return {
    kept: then.flatMap((column) => {
      const match = nowById.get(column.id);
      return match ? [{ then: column, now: match }] : [];
    }),
    gone: then.filter(({ id }) => !nowById.has(id)),
    added: now.filter(({ id }) => !thenIds.has(id)),
  };
}

/** The columns of the snapshot with the names of today where the id still exists under the same parent. */
function namedNow(then: readonly ColumnInfo[], now: readonly ColumnInfo[]): ColumnInfo[] {
  const nowById = new Map(now.map((column) => [column.id, column]));
  return then.map((column) => {
    const match = nowById.get(column.id);
    return {
      ...column,
      name: match?.name ?? column.name,
      children: namedNow(column.children, match?.children ?? []),
    };
  });
}

function pathsById(columns: readonly ColumnInfo[], prefix: readonly string[] = []): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  for (const column of columns) {
    const path = [...prefix, column.name];
    paths.set(column.id, path);
    for (const [id, below] of pathsById(column.children, path)) paths.set(id, below);
  }
  return paths;
}

function keysNamedNow(
  partitioning: PartitioningInfo | undefined,
  now: readonly ColumnInfo[],
): PartitioningInfo | undefined {
  if (!partitioning) return undefined;
  const paths = pathsById(now);
  return {
    ...partitioning,
    columns: partitioning.columns.map((key) => ({ ...key, path: paths.get(key.columnId) ?? key.path })),
  };
}

/** The table as at the snapshot, but named as today: what `tableSteps` compares with the table now. */
function snapshotNamedNow({ then, now }: TableRestore): TableState {
  return {
    ...then,
    schemaName: now.schemaName,
    name: now.name,
    columns: namedNow(then.columns, now.columns),
    partitioning: keysNamedNow(then.partitioning, now.columns),
  };
}

const quotedList = (columns: readonly { readonly name: string }[]): string =>
  columns.map(({ name }) => quoteIdentifier(name)).join(', ');

function header(input: TableRestore): string[] {
  const { snapshot, then, now, pinned } = input;
  const renamed = then.schemaName !== now.schemaName || then.name !== now.name;
  return [
    `-- Restores ${commentName(now.schemaName, now.name)} to ${snapshotText(snapshot.id, snapshot.time)}. ${NOTHING_RUN}`,
    '-- Rows inserted, changed or deleted since then are replaced. The snapshots in between stay readable.',
    '-- The table keeps its id, so its History, Schema History and Show Changes go on across the restore.',
    ...(renamed
      ? [
          `-- At snapshot ${snapshot.id} the table was ${commentName(then.schemaName, then.name)}; the rows are read under that name.`,
        ]
      : []),
    ...newestComment(pinned, { several: true }),
  ];
}

// What the INSERT does with columns that changed: added ones get their default, a type is cast, a struct casts by
// field name, and the rows take the layout of today.
function notes(input: TableRestore, { kept, added }: Pairing, layoutChanged: boolean): string[] {
  const n = input.snapshot.id;
  const retyped = kept.filter(({ then, now }) => typeDiffers(then, now));
  const fieldRenamed = kept.filter(({ then, now }) =>
    diffColumns([then], [now]).some(({ change, path }) => change === 'renamed' && path.length > 1),
  );
  const strict = added.filter(({ nullable, defaultValue }) => !nullable && defaultValue === null);
  const names = (columns: readonly { readonly name: string }[]): string =>
    columns.map(({ name }) => commentName(name)).join(', ');
  return [
    ...(added.length > 0
      ? [`-- Added since snapshot ${n}, so left out of the INSERT; they get their defaults: ${names(added)}.`]
      : []),
    ...(strict.length > 0
      ? [`-- NOT NULL without a default, so the INSERT fails unless you give them a value: ${names(strict)}.`]
      : []),
    ...(retyped.length > 0
      ? [
          `-- The type changed since snapshot ${n}: ${names(retyped.map(({ now }) => now))}. The INSERT casts the values; a value that does not cast fails the run, and the transaction rolls back.`,
        ]
      : []),
    ...(fieldRenamed.length > 0
      ? [
          `-- Warning: a field was renamed since snapshot ${n} in ${names(fieldRenamed.map(({ now }) => now))}. DuckDB casts a struct by field name, so a renamed field comes back empty, and the INSERT fails when no field name matches.`,
        ]
      : []),
    ...(layoutChanged
      ? [
          `-- The partitioning or the sort order changed since snapshot ${n}: the rows are written with the layout of today.`,
        ]
      : []),
  ];
}

/** The steps of `tableSteps` with the statements as comments; a type change back (never a widening) carries the warning too. */
function commentedSteps(steps: readonly Step[]): string[] {
  return steps.flatMap(({ text, note }) => {
    if (note === 'notWider') return [WARNINGS.type, text];
    return [isStatement(text) ? commented(text) : text];
  });
}

function structureLines(input: TableRestore, pairing: Pairing, check: CatalogCheck): string[] {
  const steps = tableSteps(snapshotNamedNow(input), input.now, check);
  if (steps.length === 0) return [];
  const n = input.snapshot.id;
  return [
    `-- The structure changed since snapshot ${n}: this script restores the data only.`,
    `-- The steps below are Script as Update with the table at snapshot ${n} as the source. To restore the structure as well, run them first (remove the "-- " in front of them)${
      pairing.gone.length > 0
        ? ', then remove the "-- " in front of the columns that they add back, in both column lists of the INSERT'
        : ''
    }.`,
    ...commentedSteps(steps),
  ];
}

// A column that the snapshot has and the table lacks stands commented at the end of both lists, so removing the
// "-- " in front of it gives a valid list.
function insertStatement({ snapshot, then, now }: TableRestore, { kept, gone }: Pairing): string {
  const target = qualifiedName(now.schemaName, now.name);
  const source = `${qualifiedName(then.schemaName, then.name)}${atVersion(snapshot.id)}`;
  const selected = kept.map(({ then: was, now: is }) =>
    was.name === is.name
      ? quoteIdentifier(is.name)
      : `${quoteIdentifier(was.name)} AS ${quoteIdentifier(is.name)}`,
  );
  if (gone.length === 0) {
    return `INSERT INTO ${target} (${quotedList(kept.map(({ now: is }) => is))})\nSELECT ${selected.join(', ')} FROM ${source};`;
  }
  const rest = gone.map(({ name }) => `  ${commented(`, ${quoteIdentifier(name)}`)}`);
  const list = (names: readonly string[]): string[] =>
    names.map((name, index) => `  ${name}${index < names.length - 1 ? ',' : ''}`);
  return [
    `INSERT INTO ${target} (`,
    ...list(kept.map(({ now: is }) => quoteIdentifier(is.name))),
    ...rest,
    ')',
    'SELECT',
    ...list(selected),
    ...rest,
    `FROM ${source};`,
  ].join('\n');
}

function transactionLines(input: TableRestore, pairing: Pairing): string[] {
  const table = qualifiedName(input.now.schemaName, input.now.name);
  const remove = `DELETE FROM ${table};`;
  const insert = insertStatement(input, pairing);
  const body =
    pairing.kept.length > 0
      ? [deleteWarning(input.snapshot.id), remove, insert]
      : [
          `-- No column of snapshot ${input.snapshot.id} is in the table now, so the DELETE and the INSERT stay comments: run the steps above first.`,
          commented(remove),
          commented(insert),
        ];
  return ['BEGIN TRANSACTION;', ...body, 'COMMIT;'];
}

// Renames come after the restore: the INSERT names the columns as they are now.
function renameLines({ snapshot, then, now }: TableRestore): string[] {
  const table = qualifiedName(now.schemaName, now.name);
  const renames = diffColumns(then.columns, now.columns)
    .flatMap((change) => (change.change === 'renamed' ? [change] : []))
    // A field before its parent, which keeps the name of today until then.
    .toSorted((a, b) => b.path.length - a.path.length);
  if (renames.length === 0) return [];
  return [
    `-- To give the columns their names of snapshot ${snapshot.id} again, run these after the restore:`,
    ...renames.map(({ path, from }) =>
      commented(
        `ALTER TABLE ${table} RENAME COLUMN ${path.map(quoteIdentifier).join('.')} TO ${quoteIdentifier(from)};`,
      ),
    ),
  ];
}

/** The script of Restore Table to Snapshot; DuckDB's tokenizer checks it (`checkedScript`), nothing runs. */
export function restoreTableScript(input: TableRestore, tokenize: Tokenize): Promise<string> {
  const pairing = pair(input.then.columns, input.now.columns);
  const layout = layoutDiffers(snapshotNamedNow(input), input.now);
  const layoutChanged = layout.partitioning || layout.sortOrder;
  return checkedScript((check) => {
    const sections = [
      header(input),
      notes(input, pairing, layoutChanged),
      structureLines(input, pairing, check),
      transactionLines(input, pairing),
      renameLines(input),
    ].filter((lines) => lines.length > 0);
    return sections.flatMap((lines, index) => (index === 0 ? lines : ['', ...lines]));
  }, tokenize);
}
