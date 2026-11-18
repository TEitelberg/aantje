// The tables of the tab Columns of the Dependencies report, which the page and Open as Markdown show: where each column
// of a view comes from through any depth of views, what filters, joins and groups its rows, and which view columns use
// a column.
import { columnName, columnsOf, isValueUse, sourcesOf, usersOf } from './columns';
import type { Reach } from './columns';
import type { ColumnUse } from './lineage-scope';
import type { DependenciesData } from './model';

/**
 * A source of a column of the object: a column of the lineage, a part whose source cannot be named, or none at all (a
 * constant, for example).
 */
export interface SourceRow {
  /** The column of the object, an index into the columns of the lineage. */
  readonly column: number;
  readonly source:
    | { readonly kind: 'column'; readonly reach: Reach }
    | { readonly kind: 'unknown'; readonly detail: string; readonly level: number }
    | { readonly kind: 'none' };
}

/** A view column that uses a column of the object. */
export interface UserRow {
  readonly column: number;
  readonly user: Reach;
}

export interface LineageView {
  /** The columns of the object that the tab shows: the one of Show Column Lineage, else all of them. */
  readonly shown: readonly number[];
  /** Of a view: what its columns are built from, through any depth; a row per column at least. */
  readonly sources: readonly SourceRow[];
  /** Of a view: the columns that decide which rows it has (filter, join, group), through any depth. */
  readonly rows: readonly Reach[];
  /** The view columns that use the shown columns, through any depth. */
  readonly users: readonly UserRow[];
  /** Why the columns of the object cannot be told. */
  readonly opaque: string | undefined;
}

/** The titles of the tables of the tab Columns and their headings, which Open as Markdown repeats. */
export const LINEAGE_TABLES = {
  sources: { title: 'Sources', headings: ['Column', 'Source column', 'Object', 'Use', 'Level'] },
  rows: { title: 'Filters, joins and groups', headings: ['Column', 'Object', 'Use', 'Level'] },
  users: { title: 'Used by', headings: ['Column', 'View column', 'Object', 'Use', 'Level'] },
} as const;

/** A column of the lineage of a report by its name and the index of the object that has it. */
export function lineageColumn(
  data: DependenciesData,
  column: number,
): { readonly name: string; readonly node: number | undefined } {
  const found = data.lineage?.columns[column];
  return { name: found?.name ?? '', node: found?.node };
}

export const USE_LABEL: Readonly<Record<ColumnUse, string>> = {
  direct: 'direct',
  derived: 'derived',
  filter: 'filter',
  join: 'join',
  group: 'group',
};

const USE_RANK: Readonly<Record<ColumnUse, number>> = { direct: 0, derived: 1, filter: 2, join: 3, group: 4 };

/** The name of a column of the lineage of a report: `shop.orders.amount`. */
export const lineageName = (data: DependenciesData, column: number): string =>
  columnName(data.nodes, data.lineage?.columns[column]);

// Nearest first, then the value before the rows, then by name.
const byReach =
  (data: DependenciesData) =>
  (a: Reach, b: Reach): number =>
    a.level - b.level ||
    USE_RANK[a.use] - USE_RANK[b.use] ||
    lineageName(data, a.column).localeCompare(lineageName(data, b.column));

// The unknown parts of a column and of the view columns its value is built from, each at the nearest level.
function unknownParts(
  lineage: NonNullable<DependenciesData['lineage']>,
  column: number,
  values: readonly Reach[],
): SourceRow[] {
  const unknown = new Map<string, number>();
  const steps = [[column, 0] as const, ...values.map((reach) => [reach.column, reach.level] as const)];
  for (const [at, level] of steps) {
    for (const { detail } of lineage.unknown.filter((part) => part.column === at)) {
      if (!unknown.has(detail)) unknown.set(detail, level + 1);
    }
  }
  return [...unknown].map(([detail, level]) => ({ column, source: { kind: 'unknown', detail, level } }));
}

/** The tables of the object of the report; undefined without a lineage or an object. */
export function lineageView(data: DependenciesData): LineageView | undefined {
  const { lineage, target } = data;
  if (!lineage || target === null) return undefined;
  const opaque = lineage.opaque.find(({ node }) => node === target)?.detail;
  const shown = lineage.focus === undefined ? columnsOf(lineage, target) : [lineage.focus];
  const isView = data.nodes[target]?.kind === 'view';
  const order = byReach(data);
  const sources: SourceRow[] = [];
  const rows = new Map<string, Reach>();
  if (isView) {
    for (const column of shown) {
      const reached = sourcesOf(lineage, column);
      const values = reached.filter(({ use }) => isValueUse(use)).toSorted(order);
      const unknown = unknownParts(lineage, column, values);
      sources.push(...values.map((reach) => ({ column, source: { kind: 'column' as const, reach } })));
      sources.push(...unknown);
      if (values.length === 0 && unknown.length === 0) sources.push({ column, source: { kind: 'none' } });
      for (const reach of reached.filter(({ use }) => !isValueUse(use))) {
        const key = `${reach.column}|${reach.use}`;
        const known = rows.get(key);
        if (!known || known.level > reach.level) rows.set(key, reach);
      }
    }
  }
  const users = shown.flatMap((column) =>
    usersOf(lineage, column)
      .toSorted(order)
      .map((user) => ({ column, user })),
  );
  return { shown, sources, rows: [...rows.values()].toSorted(order), users, opaque };
}
