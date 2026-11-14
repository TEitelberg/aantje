import type { ColumnInfo, PartitioningInfo, SortOrderInfo } from '../catalog/model';
import { longestIncreasing } from '../catalog/schema-diff';
import { foldIdentifier } from '../catalog/ddl';

// The structure of a table as the scripts read and compare it: by name, not by id, because Script as Update aligns two
// different tables, and Generate Scripts and the restore scripts create one from it.

/** The structure of a table at one snapshot: columns, comment, partitioning and sort order. */
export interface TableState {
  readonly id: number;
  readonly schemaName: string;
  readonly name: string;
  readonly comment: string | null;
  readonly columns: readonly ColumnInfo[];
  readonly partitioning: PartitioningInfo | undefined;
  readonly sortOrder: SortOrderInfo | undefined;
}

type Kind = 'struct' | 'list' | 'map' | 'leaf';

/** Nested columns compare by their fields; a column of another kind has a type change. */
export const kindOf = (type: string): Kind =>
  type === 'struct' || type === 'list' || type === 'map' ? type : 'leaf';

/** True when the column, with what is below it, has another type than `other`. */
export const typeDiffers = (column: ColumnInfo, other: ColumnInfo): boolean =>
  kindOf(column.type) !== kindOf(other.type) ||
  (kindOf(column.type) === 'leaf' && column.type !== other.type);

/** The names on the right whose column keeps both sides' columns in another order (outside the longest kept run). */
export function movedNames(left: readonly string[], right: readonly string[]): Set<string> {
  const position = new Map<string, number>();
  left.forEach((name, index) => {
    if (!position.has(foldIdentifier(name))) position.set(foldIdentifier(name), index);
  });
  const shared = right.flatMap((name) => {
    const index = position.get(foldIdentifier(name));
    return index === undefined ? [] : [{ key: foldIdentifier(name), index }];
  });
  const kept = longestIncreasing(shared.map(({ index }) => index));
  return new Set(shared.filter((_, at) => !kept.has(at)).map(({ key }) => key));
}

// A column name, bare or in double quotes, as a sort expression.
const COLUMN_NAME = /^(?:"((?:[^"]|"")+)"|([\p{L}_][\p{L}\p{N}_$]*))$/u;

/** A sort expression that is a column name compares as the name does; any other as the text that DuckLake stores. */
function sortExpressionKey(expression: string): readonly [string, string] {
  const name = COLUMN_NAME.exec(expression);
  if (!name) return ['expression', expression];
  return ['column', foldIdentifier(name[1]?.replaceAll('""', '"') ?? name[2] ?? '')];
}

// Partition keys compare by the names as DuckDB does; sort expressions see `sortExpressionKey`.
const partitioningKey = (partitioning: PartitioningInfo | undefined): string =>
  JSON.stringify(
    (partitioning?.columns ?? []).map(({ path, transform }) => [path.map(foldIdentifier), transform]),
  );
const sortOrderKey = (sortOrder: SortOrderInfo | undefined): string =>
  JSON.stringify(
    (sortOrder?.expressions ?? []).map(({ expression, dialect, direction, nullOrder }) => [
      sortExpressionKey(expression),
      dialect,
      direction,
      nullOrder,
    ]),
  );

/** Whether the partitioning and the sort order of the two tables differ, with names compared as DuckDB does. */
export function layoutDiffers(
  left: Pick<TableState, 'partitioning' | 'sortOrder'>,
  right: Pick<TableState, 'partitioning' | 'sortOrder'>,
): { readonly partitioning: boolean; readonly sortOrder: boolean } {
  return {
    partitioning: partitioningKey(left.partitioning) !== partitioningKey(right.partitioning),
    sortOrder: sortOrderKey(left.sortOrder) !== sortOrderKey(right.sortOrder),
  };
}
