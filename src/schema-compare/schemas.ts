import { foldIdentifier } from '../catalog/ddl';
import type { CatalogEntry, MacroInfo, SchemaInfo, TableInfo, ViewInfo } from '../catalog/model';
import { COMPARE_LIMITS } from '../compare';
import { indexByName } from '../ddl-script/names';
import type { TableState } from '../ddl-script/table-state';
import type { CatalogObjects } from '../dependencies/graph';
import { collator } from '../order';
import { compareTables, hasDifferences } from './model';
import type { TableDifferences } from './model';

// Schema Compare of two schemas: tables, views and macros paired by name, from left to right.

/** What one schema holds at a snapshot. */
export interface SchemaObjects {
  readonly schema: SchemaInfo;
  /** Every schema of the lake: the dependency graph resolves the names in the SQL with them. */
  readonly schemas: readonly SchemaInfo[];
  readonly tables: readonly TableInfo[];
  readonly views: readonly ViewInfo[];
  readonly macros: readonly MacroInfo[];
}

export interface Paired<T> {
  readonly left: T;
  readonly right: T;
}

/** The objects of one kind: on one side only, in both and different, in both and equal (counted). */
interface Grouped<T> {
  readonly onlyLeft: readonly T[];
  readonly onlyRight: readonly T[];
  readonly different: readonly Paired<T>[];
  readonly equal: number;
}

export interface SchemaComparison {
  readonly tables: Omit<Grouped<TableInfo>, 'different'> & {
    readonly different: readonly (Paired<TableState> & { readonly differences: TableDifferences })[];
    /** Tables that both sides have and that the limit left uncompared. */
    readonly omitted: number;
  };
  readonly views: Grouped<ViewInfo>;
  readonly macros: Grouped<MacroInfo>;
}

const sorted = <T extends { readonly name: string }>(items: readonly T[]): T[] =>
  items.toSorted((a, b) => collator.compare(a.name, b.name));

/** Pairs the objects by `key`; `same` tells equal pairs from different ones. Each list is in name order. */
function group<T extends { readonly name: string }>(
  left: readonly T[],
  right: readonly T[],
  key: (item: T) => string,
  same: (pair: Paired<T>) => boolean,
): Grouped<T> {
  const rights = new Map<string, T>();
  for (const item of right) if (!rights.has(key(item))) rights.set(key(item), item);
  const lefts = new Set(left.map(key));
  const pairs = sorted(left).flatMap((item) => {
    const match = rights.get(key(item));
    return match ? [{ left: item, right: match }] : [];
  });
  return {
    onlyLeft: sorted(left.filter((item) => !rights.has(key(item)))),
    onlyRight: sorted(right.filter((item) => !lefts.has(key(item)))),
    different: pairs.filter((pair) => !same(pair)),
    equal: pairs.filter(same).length,
  };
}

/** The tables of both sides in pairs by name, the first `limit` of them, and how many more there are. */
export function pairTables(
  left: readonly TableInfo[],
  right: readonly TableInfo[],
  limit = COMPARE_LIMITS.tables,
): { readonly pairs: readonly Paired<TableInfo>[]; readonly omitted: number } {
  const rights = indexByName(right);
  const pairs = sorted(left).flatMap((table) => {
    const match = rights.get(foldIdentifier(table.name));
    return match ? [{ left: table, right: match }] : [];
  });
  return { pairs: pairs.slice(0, limit), omitted: Math.max(0, pairs.length - limit) };
}

const sameView = ({ left, right }: Paired<ViewInfo>): boolean =>
  left.sql === right.sql &&
  left.dialect === right.dialect &&
  JSON.stringify(left.columnAliases) === JSON.stringify(right.columnAliases);

// Paired by kind and name: the overloads tell them apart.
const sameMacro = ({ left, right }: Paired<MacroInfo>): boolean =>
  JSON.stringify(left.implementations) === JSON.stringify(right.implementations);

/**
 * Two schemas from left to right. `compared` holds the table pairs that were read in full (`pairTables`); tables are
 * paired by name, views too, macros by kind and name. A view or macro differs when the text that the catalog stores
 * differs.
 */
export function compareSchemas(
  left: SchemaObjects,
  right: SchemaObjects,
  compared: readonly Paired<TableState>[],
  omitted: number,
): SchemaComparison {
  const tables = group(
    left.tables,
    right.tables,
    ({ name }) => foldIdentifier(name),
    () => true,
  );
  const checked = compared.map((pair) => ({ ...pair, differences: compareTables(pair.left, pair.right) }));
  const different = checked.filter(({ differences }) => hasDifferences(differences));
  return {
    tables: {
      onlyLeft: tables.onlyLeft,
      onlyRight: tables.onlyRight,
      different,
      equal: checked.length - different.length,
      omitted,
    },
    views: group(left.views, right.views, ({ name }) => foldIdentifier(name), sameView),
    macros: group(
      left.macros,
      right.macros,
      ({ kind, name }) => `${kind}:${foldIdentifier(name)}`,
      sameMacro,
    ),
  };
}

export const differs = ({ tables, views, macros }: SchemaComparison): boolean =>
  [tables, views, macros].some(
    (kind) => kind.onlyLeft.length > 0 || kind.onlyRight.length > 0 || kind.different.length > 0,
  );

/** The input of the dependency graph: the tables, views and macros of the schema. */
export function graphObjects({ schema, schemas, tables, views, macros }: SchemaObjects): CatalogObjects {
  const entry = (kind: CatalogEntry['kind'], { id, name }: { id: number; name: string }): CatalogEntry => ({
    kind,
    id,
    name,
    schemaId: schema.id,
    schemaName: schema.name,
  });
  return {
    schemas,
    entries: [...tables.map((table) => entry('table', table)), ...views.map((view) => entry('view', view))],
    views,
    macros,
  };
}
