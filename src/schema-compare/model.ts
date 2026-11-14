import { foldIdentifier, quoteIdentifier } from '../catalog/ddl';
import type { ColumnInfo, PartitionColumn, PartitioningInfo, SortOrderInfo } from '../catalog/model';
import type { ColumnChange } from '../catalog/schema-diff';
import type { WithoutId } from '../compare';
import { indexByName } from '../ddl-script/names';
import { kindOf, layoutDiffers, movedNames, typeDiffers } from '../ddl-script/table-state';
import type { TableState } from '../ddl-script/table-state';

// Schema Compare of two tables: matched by name, not by id, because the tables are different ones.

/**
 * One difference of a column from the left table to the right one: `added` is only on the right, `removed` only on the
 * left. `path` names the column as on the right (as on the left for a removed one).
 */
export type ColumnDifference = WithoutId<Exclude<ColumnChange, { readonly change: 'renamed' }>>;

/** A difference of the table itself, as text (null: none). */
interface Changed {
  readonly from: string | null;
  readonly to: string | null;
}

export interface TableDifferences {
  readonly columns: readonly ColumnDifference[];
  readonly comment?: Changed;
  readonly partitioning?: Changed;
  readonly sortOrder?: Changed;
}

/** The column and every field below it, parents first. */
function withFields(column: ColumnInfo, path: readonly string[]): { path: string[]; column: ColumnInfo }[] {
  const here = [...path, column.name];
  return [{ path: here, column }, ...column.children.flatMap((child) => withFields(child, here))];
}

interface Walk {
  readonly changes: ColumnDifference[];
  readonly removed: ColumnDifference[];
}

// NOT NULL, the default and the comment are compared for top-level columns: DuckDB has none of them on a field, and
// DuckLake marks the fields that it adds or changes as not nullable in its catalog.
function compareLevel(
  left: readonly ColumnInfo[],
  right: readonly ColumnInfo[],
  prefixes: { readonly left: readonly string[]; readonly right: readonly string[] },
  walk: Walk,
): void {
  const lefts = indexByName(left);
  const moved = movedNames(
    left.map(({ name }) => name),
    right.map(({ name }) => name),
  );
  const topLevel = prefixes.right.length === 0;
  for (const [index, column] of right.entries()) {
    const was = lefts.get(foldIdentifier(column.name));
    if (!was) {
      walk.changes.push(
        ...withFields(column, prefixes.right).map(({ path, column: added }) => ({
          change: 'added' as const,
          path,
          type: added.type,
        })),
      );
      continue;
    }
    const path = [...prefixes.right, column.name];
    if (typeDiffers(was, column)) {
      walk.changes.push({ change: 'typeChanged', path, from: was.type, to: column.type });
    }
    if (topLevel && was.nullable !== column.nullable) {
      walk.changes.push({ change: 'nullableChanged', path, from: was.nullable, to: column.nullable });
    }
    if (topLevel && was.defaultValue !== column.defaultValue) {
      walk.changes.push({ change: 'defaultChanged', path, from: was.defaultValue, to: column.defaultValue });
    }
    if (topLevel && was.comment !== column.comment) {
      walk.changes.push({ change: 'commentChanged', path, from: was.comment, to: column.comment });
    }
    if (moved.has(foldIdentifier(column.name))) {
      walk.changes.push({ change: 'moved', path, from: left.indexOf(was), to: index });
    }
    if (!typeDiffers(was, column) && kindOf(column.type) !== 'leaf') {
      compareLevel(was.children, column.children, { left: [...prefixes.left, was.name], right: path }, walk);
    }
  }
  const rights = indexByName(right);
  for (const column of left) {
    if (!rights.has(foldIdentifier(column.name))) {
      walk.removed.push(
        ...withFields(column, prefixes.left).map(({ path, column: gone }) => ({
          change: 'removed' as const,
          path,
          type: gone.type,
        })),
      );
    }
  }
}

/**
 * The column differences from the left table to the right one, matched by name and fields by their path. A column
 * that one side lacks is listed with each of its fields. The right columns come in table order, then the removed ones.
 */
export function compareColumns(
  left: readonly ColumnInfo[],
  right: readonly ColumnInfo[],
): ColumnDifference[] {
  const walk: Walk = { changes: [], removed: [] };
  compareLevel(left, right, { left: [], right: [] }, walk);
  return [...walk.changes, ...walk.removed];
}

/** The key as a document shows it, also for a column or transform that no statement can set. */
function shownKey({ path, transform }: PartitionColumn): string {
  const column = path.map(quoteIdentifier).join('.');
  const bucket = /^bucket\((\d+)\)$/.exec(transform);
  if (bucket) return `bucket(${bucket[1]}, ${column})`;
  return transform === 'identity' ? column : `${transform}(${column})`;
}

/** The sort keys as a document shows them: the expressions as the catalog stores them. */
const shownSortKeys = (sortOrder: SortOrderInfo): string[] =>
  sortOrder.expressions.map(
    ({ expression, direction, nullOrder }) => `${expression} ${direction} ${nullOrder.replace('_', ' ')}`,
  );

/** `"kind", year("ts"), bucket(4, "id")`: the partition keys as `SET PARTITIONED BY` writes them; null for none. */
export function partitionText(partitioning: PartitioningInfo | undefined): string | null {
  const keys = partitioning?.columns ?? [];
  return keys.length === 0 ? null : keys.map(shownKey).join(', ');
}

/** `"value" DESC NULLS FIRST, sensor ASC NULLS LAST`; null for none. */
export function sortText(sortOrder: SortOrderInfo | undefined): string | null {
  return sortOrder && sortOrder.expressions.length > 0 ? shownSortKeys(sortOrder).join(', ') : null;
}

/** What differs from the left table to the right one: columns, comment, partitioning and sort order. */
export function compareTables(left: TableState, right: TableState): TableDifferences {
  const layout = layoutDiffers(left, right);
  return {
    columns: compareColumns(left.columns, right.columns),
    ...(left.comment === right.comment ? {} : { comment: { from: left.comment, to: right.comment } }),
    ...(layout.partitioning
      ? { partitioning: { from: partitionText(left.partitioning), to: partitionText(right.partitioning) } }
      : {}),
    ...(layout.sortOrder
      ? { sortOrder: { from: sortText(left.sortOrder), to: sortText(right.sortOrder) } }
      : {}),
  };
}

export const hasDifferences = (differences: TableDifferences): boolean =>
  differences.columns.length > 0 ||
  differences.comment !== undefined ||
  differences.partitioning !== undefined ||
  differences.sortOrder !== undefined;

type ChangeKind = ColumnDifference['change'];

// By side: `added` is only in the target (right), `removed` only in the source (left). Singular, then plural.
const COUNTED: readonly (readonly [ChangeKind, string, string])[] = [
  ['added', 'only in the target', 'only in the target'],
  ['removed', 'only in the source', 'only in the source'],
  ['typeChanged', 'type differs', 'types differ'],
  ['nullableChanged', 'nullability differs', 'nullabilities differ'],
  ['defaultChanged', 'default differs', 'defaults differ'],
  ['commentChanged', 'comment differs', 'comments differ'],
  ['moved', 'position differs', 'positions differ'],
];

/** `a`, `a and b`, `a, b and c`. */
export function listed(parts: readonly string[]): string {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

export interface DifferenceCounts {
  /** The number of column differences of each kind that occurs; nested fields count as columns. */
  readonly columns: Partial<Record<ChangeKind, number>>;
  /** What of the table itself differs. */
  readonly table: readonly ('comment' | 'partitioning' | 'sort order')[];
}

export function differenceCounts(differences: TableDifferences): DifferenceCounts {
  const columns: Partial<Record<ChangeKind, number>> = {};
  for (const { change } of differences.columns) columns[change] = (columns[change] ?? 0) + 1;
  return {
    columns,
    table: [
      ...(differences.comment ? (['comment'] as const) : []),
      ...(differences.partitioning ? (['partitioning'] as const) : []),
      ...(differences.sortOrder ? (['sort order'] as const) : []),
    ],
  };
}

/**
 * `2 columns only in the target, 1 only in the source, 1 type differs; the partitioning differs`, in the order of
 * `COUNTED`. Empty when nothing differs.
 */
export function countsText({ columns, table }: DifferenceCounts): string {
  const parts = COUNTED.flatMap(([kind, one, more]) => {
    const count = columns[kind] ?? 0;
    return count > 0
      ? [{ count, text: count === 1 ? one : more, sided: kind === 'added' || kind === 'removed' }]
      : [];
  }).map(({ count, text, sided }, index) => {
    // The first count names the columns: `2 columns only in the target`, `2 column types differ`.
    const noun = index > 0 ? '' : sided && count > 1 ? 'columns ' : 'column ';
    return `${count} ${noun}${text}`;
  });
  const parted = table.map((part) => (part === 'comment' ? 'the table comment' : `the ${part}`));
  return [
    parts.join(', '),
    parted.length === 0 ? '' : `${listed(parted)} ${parted.length === 1 ? 'differs' : 'differ'}`,
  ]
    .filter((part) => part !== '')
    .join('; ');
}

/** True when columns are only in the target and only in the source: a renamed column looks like that between two tables. */
export const mayHideRename = (differences: TableDifferences): boolean =>
  differences.columns.some(({ change }) => change === 'added') &&
  differences.columns.some(({ change }) => change === 'removed');

export const RENAME_NOTE = 'A renamed column shows as one only in the source and one only in the target.';
