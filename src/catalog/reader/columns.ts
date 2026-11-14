import { groupBy } from '../../order';
import { quoteLiteral } from '../ddl';
import type { Row } from '../drivers/driver';
import type { CatalogColumnEntry, ColumnInfo } from '../model';
import * as queries from '../queries/objects';
import { toBoolean, toNumber, toText, toTextOrNull } from './rows';
import type { Run } from './rows';

// Types whose stored literal default is valid SQL as is; all others need quotes.
const BARE_LITERAL_TYPES = /^(boolean|u?int\d+|float\d+|decimal\(.+\))$/;

// DuckLake stores NaN and the infinities as bare words, which are invalid SQL.
const NON_FINITE = /^-?(nan|inf)$/;

export async function readColumns(
  run: Run,
  tableId: number,
  snapshot: number,
  signal?: AbortSignal,
): Promise<ColumnInfo[]> {
  return columnTree(await run(queries.columns(tableId, snapshot), signal));
}

/** The columns and nested fields of every table at the snapshot by table id, read in one statement. */
export async function readColumnEntries(
  run: Run,
  snapshot: number,
): Promise<Map<number, CatalogColumnEntry[]>> {
  const tables = groupBy(await run(queries.columnEntries(snapshot)), (row) => toNumber(row.table_id));
  return new Map(
    [...tables].map(([tableId, rows]) => {
      const childrenOf = groupBy(rows, parentOf);
      const below = (parent: number | null, ids: number[], path: string[]): CatalogColumnEntry[] =>
        (childrenOf.get(parent) ?? []).flatMap((row) => {
          const id = toNumber(row.column_id);
          // A broken catalog may repeat a column below itself; it is listed once.
          if (ids.includes(id)) return [];
          const entry = {
            ids: [...ids, id],
            path: [...path, toText(row.column_name)],
            type: toText(row.column_type),
          };
          return [entry, ...below(id, entry.ids, entry.path)];
        });
      return [tableId, below(null, [], [])];
    }),
  );
}

/** Builds the column tree from flat `ducklake_column` rows; children point to their parent via `parent_column`. */
export function columnTree(rows: readonly Row[]): ColumnInfo[] {
  const childrenOf = groupBy(rows, parentOf);

  const build = (parent: number | null, above: readonly number[]): ColumnInfo[] =>
    (childrenOf.get(parent) ?? []).flatMap((row) => {
      const id = toNumber(row.column_id);
      // A broken catalog may repeat a column below itself; the tree shows it once.
      if (above.includes(id)) return [];
      const type = toText(row.column_type);
      return {
        id,
        name: toText(row.column_name),
        type,
        nullable: toBoolean(row.nulls_allowed),
        defaultValue: defaultExpression(
          toTextOrNull(row.default_value),
          toTextOrNull(row.default_value_type),
          type,
        ),
        comment: toTextOrNull(row.comment_text),
        children: build(id, [...above, id]),
      };
    });
  return build(null, []);
}

const parentOf = (row: Row): number | null =>
  row.parent_column === null ? null : toNumber(row.parent_column);

// DuckLake stores "no default" as the literal `NULL` (nested parents have an empty type), a string literal without
// quotes (`abc`) and an expression as SQL text. A string that spells `NULL` is stored as the expression `'NULL'`.
function defaultExpression(
  value: string | null,
  valueType: string | null,
  columnType: string,
): string | null {
  if (value === null) {
    return null;
  }
  if (valueType === 'expression') {
    return value;
  }
  if (value === 'NULL') {
    return null;
  }
  return BARE_LITERAL_TYPES.test(columnType) && !NON_FINITE.test(value) ? value : quoteLiteral(value);
}

/**
 * Every column of the tree, parents first, with names from the top level down. `exact`: the null count is the number
 * of NULL values; DuckLake counts a missing parent as NULL for the fields below it.
 */
export function flatten(
  columns: readonly ColumnInfo[],
  prefix: readonly string[] = [],
  exact = true,
): { column: ColumnInfo; path: string[]; exact: boolean }[] {
  return columns.flatMap((column) => {
    const path = [...prefix, column.name];
    return [
      { column, path, exact },
      ...flatten(column.children, path, exact && column.type === 'struct' && !column.nullable),
    ];
  });
}

export const columnPaths = (tree: readonly ColumnInfo[]): Map<number, string[]> =>
  new Map(flatten(tree).map(({ column, path }) => [column.id, path]));
