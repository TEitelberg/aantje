// The columns of the relations in scope for completion: of the catalog, or as the SQL text of a CTE, a subquery,
// a VALUES list or column aliases gives them.
import type { ColumnInfo } from '../catalog/model';
import { columnDescription } from '../tree/format';
import { nameOf } from './catalog';
import type { SqlEntry } from './catalog';
import type { Env } from './completion-env';
import type { ScopeRelation } from './context';
import { namedText } from './help';
import { fromText, scopeColumns, typeText } from './lookup';
import type { Lookup, ScopeColumn } from './lookup';

/** The columns of one relation of the query and the name that qualifies them (none for a subquery without alias). */
export type ColumnList =
  | { readonly name: string; readonly entry: SqlEntry; readonly columns: readonly ColumnInfo[] }
  | {
      readonly name: string | undefined;
      readonly entry: undefined;
      readonly columns: readonly ScopeColumn[];
    };

/** The column lists of the relations in scope, in their order; a relation without known columns has none. */
export async function columnLists(scope: readonly ScopeRelation[], lookup: Lookup): Promise<ColumnList[]> {
  const lists = await Promise.all(
    scope.map(async (relation): Promise<ColumnList | undefined> => {
      const { alias, relation: table, cte } = relation;
      if (fromText(relation)) {
        return { name: alias ?? cte, entry: undefined, columns: await scopeColumns(relation, lookup) };
      }
      const entry = table && lookup.entry(table.schema, table.table);
      return entry && { name: alias ?? nameOf(entry), entry, columns: await lookup.columns(entry) };
    }),
  );
  return lists.filter((list) => list !== undefined);
}

/** `qualifierOf` gives the qualifier of the columns that need one. */
export function textColumnDrafts(
  { drafts, quote }: Env,
  columns: readonly ScopeColumn[],
  {
    qualifierOf,
    firstRank = 0,
  }: { qualifierOf?: (column: string) => string | undefined; firstRank?: number } = {},
): void {
  for (const [position, { name, source }] of columns.entries()) {
    const qualifier = qualifierOf?.(name);
    drafts.push({
      label: qualifier === undefined ? name : `${qualifier}.${name}`,
      kind: 'column',
      insertText: `${qualifier === undefined ? '' : `${qualifier}.`}${quote(name)}`,
      detail: source && columnDescription({ ...source.column, type: typeText(source.column) }),
      documentation: source && namedText(source),
      filterText: name,
      group: 0,
      rank: firstRank + position,
    });
  }
}
