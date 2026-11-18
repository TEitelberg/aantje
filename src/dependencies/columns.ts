// The column lineage as the Dependencies report shows it: the part of the lake's lineage around the object of a report,
// and the walks through the views that the page, the document and the MCP tool list. Pure and free of the DOM.
import { groupBy } from '../order';
import type { Lineage, LineageColumn, LineageEdge } from './lake-lineage';
import { composeUse } from './lineage-scope';
import type { ColumnUse } from './lineage-scope';

/** The lineage that a report holds: the columns of its object and what they reach, in the indexes of its nodes. */
export interface ReportLineage extends Lineage {
  /** The dependencies between columns left out at the limit of the report. */
  readonly omitted: number;
  /** The column of a table that the report was opened for (Show Column Lineage); an index into `columns`. */
  readonly focus?: number | undefined;
}

/** A column that a walk through the views reached: its use seen from where the walk started, and how many views lie between. */
export interface Reach {
  readonly column: number;
  readonly use: ColumnUse;
  /** 1 for a column next to the start. */
  readonly level: number;
}

/** The most dependencies between columns that a report holds; the nearest ones are kept. */
export const MAX_LINEAGE_EDGES = 5000;

export const isValueUse = (use: ColumnUse): boolean => use === 'direct' || use === 'derived';

/** `shop.orders.amount`: a column by the names of its object. */
export const columnName = (
  nodes: readonly { readonly schema: string; readonly name: string }[],
  column: LineageColumn | undefined,
): string => {
  const node = column ? nodes[column.node] : undefined;
  return node && column ? `${node.schema}.${node.name}.${column.name}` : '';
};

const adjacency = new WeakMap<
  Pick<Lineage, 'edges'>,
  { readonly down: ReadonlyMap<number, LineageEdge[]>; readonly up: ReadonlyMap<number, LineageEdge[]> }
>();

// The edges by the column they start from and by the one they end at; kept for each lineage.
function linked(lineage: Pick<Lineage, 'edges'>): {
  readonly down: ReadonlyMap<number, LineageEdge[]>;
  readonly up: ReadonlyMap<number, LineageEdge[]>;
} {
  let found = adjacency.get(lineage);
  if (!found) {
    found = { down: groupBy(lineage.edges, ({ from }) => from), up: groupBy(lineage.edges, ({ to }) => to) };
    adjacency.set(lineage, found);
  }
  return found;
}

// Breadth first from `start`: each column and use once, at the level where it is first reached.
function walk(
  start: number,
  step: (column: number) => readonly { readonly column: number; readonly use: ColumnUse }[],
  combine: (reached: ColumnUse, edge: ColumnUse) => ColumnUse,
): Reach[] {
  const found: Reach[] = [];
  const seen = new Set<string>();
  let level: Reach[] = step(start).map(({ column, use }) => ({ column, use, level: 1 }));
  while (level.length > 0) {
    const next: Reach[] = [];
    for (const reach of level) {
      const key = `${reach.column}|${reach.use}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(reach);
      for (const edge of step(reach.column)) {
        next.push({ column: edge.column, use: combine(reach.use, edge.use), level: reach.level + 1 });
      }
    }
    level = next;
  }
  return found;
}

/** What a view column is built from, through any depth of views: the columns and how the start uses them. */
export function sourcesOf(lineage: Pick<Lineage, 'edges'>, column: number): Reach[] {
  const { down } = linked(lineage);
  return walk(
    column,
    (at) => (down.get(at) ?? []).map(({ to, use }) => ({ column: to, use })),
    (reached, edge) => composeUse(reached, edge),
  );
}

/** The view columns that use a column, through any depth of views, and how they use it. */
export function usersOf(lineage: Pick<Lineage, 'edges'>, column: number): Reach[] {
  const { up } = linked(lineage);
  return walk(
    column,
    (at) => (up.get(at) ?? []).map(({ from, use }) => ({ column: from, use })),
    (reached, edge) => composeUse(edge, reached),
  );
}

/** The columns of an object in their order, as indexes into the columns of the lineage. */
export function columnsOf(lineage: Pick<Lineage, 'columns'>, node: number): number[] {
  return lineage.columns.flatMap((column, index) => (column.node === node ? [index] : []));
}

/**
 * The lineage around the columns `starts`: what they are built from (`down`) and what uses them, each through any depth
 * of views, with at most `limit` dependencies, the nearest first. `nodeOf` maps the node of a column to the report's
 * numbering; a column of a node the report does not hold is left out.
 */
export function lineageAround(
  lineage: Lineage,
  starts: readonly number[],
  down: boolean,
  nodeOf: (node: number) => number | undefined,
  limit = MAX_LINEAGE_EDGES,
): Omit<ReportLineage, 'focus'> & { readonly index: ReadonlyMap<number, number> } {
  const links = linked(lineage);
  const walked: LineageEdge[] = [];
  const seenEdges = new Set<LineageEdge>();
  const follow = (
    next: (column: number) => readonly LineageEdge[],
    end: (edge: LineageEdge) => number,
  ): void => {
    const seen = new Set(starts);
    let level = [...starts];
    while (level.length > 0) {
      const following: number[] = [];
      for (const column of level) {
        for (const edge of next(column)) {
          if (!seenEdges.has(edge)) {
            seenEdges.add(edge);
            walked.push(edge);
          }
          const other = end(edge);
          if (!seen.has(other)) {
            seen.add(other);
            following.push(other);
          }
        }
      }
      level = following;
    }
  };
  if (down)
    follow(
      (column) => links.down.get(column) ?? [],
      ({ to }) => to,
    );
  follow(
    (column) => links.up.get(column) ?? [],
    ({ from }) => from,
  );
  const kept = walked.filter(({ from, to }) => {
    const [a, b] = [lineage.columns[from], lineage.columns[to]];
    return a !== undefined && b !== undefined && nodeOf(a.node) !== undefined && nodeOf(b.node) !== undefined;
  });
  const shown = kept.slice(0, limit);
  const included = [...new Set([...starts, ...shown.flatMap(({ from, to }) => [from, to])])]
    .filter((column) => {
      const found = lineage.columns[column];
      return found !== undefined && nodeOf(found.node) !== undefined;
    })
    .sort((a, b) => a - b);
  const index = new Map(included.map((old, now) => [old, now]));
  return {
    columns: included.flatMap((old) => {
      const column = lineage.columns[old];
      const node = column && nodeOf(column.node);
      return column && node !== undefined ? [{ node, name: column.name }] : [];
    }),
    edges: shown.flatMap(({ from, to, use }) => {
      const [a, b] = [index.get(from), index.get(to)];
      return a === undefined || b === undefined ? [] : [{ from: a, to: b, use }];
    }),
    unknown: lineage.unknown.flatMap(({ column, detail }) => {
      const at = index.get(column);
      return at === undefined ? [] : [{ column: at, detail }];
    }),
    // Few views are opaque: those of the report say why their columns are missing.
    opaque: lineage.opaque.flatMap(({ node, detail }) => {
      const at = nodeOf(node);
      return at === undefined ? [] : [{ node: at, detail }];
    }),
    omitted: kept.length - shown.length,
    index,
  };
}
