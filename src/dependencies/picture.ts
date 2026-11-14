import { groupBy } from '../order';
import type { DependencyEdge, NodeKind } from './graph';
import { DIRECTIONS, brokenName, nameAt, traverse } from './model';
import type { DependenciesData } from './model';

/** What the graph of one object shows: the objects connected to it, or every object with dependencies. */
export type GraphReach = 'connected' | 'all';
export const GRAPH_REACHES: readonly GraphReach[] = ['connected', 'all'];

export interface PictureInput {
  /** How many levels the graph of an object follows, on each side of it. */
  readonly depth: number;
  readonly reach: GraphReach;
}

/** A box of the graph: an object of the data, or a name that no object has. */
export interface PictureItem {
  /** An index into `nodes`; undefined for a missing name. */
  readonly node: number | undefined;
  readonly kind: NodeKind | 'missing';
  readonly name: string;
  /** Along the data flow: 0 uses nothing the graph shows, the others stand right of all they use. */
  readonly column: number;
  /** Centred on 0 in its column. */
  readonly row: number;
  /** Not connected to the object of the report; drawn faint on Show all. */
  readonly faint: boolean;
}

/** The data flows from `from` into `to`: the object read or called, then the one that uses it; indexes into `items`. */
export interface PictureEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: DependencyEdge['kind'] | 'missing';
}

export interface Picture {
  readonly items: readonly PictureItem[];
  readonly edges: readonly PictureEdge[];
}

/**
 * The objects that the graph of an object connects: the object, what it uses and what uses it, each up to `depth`.
 * The problem tables cover the same objects. Undefined for a lake or a schema.
 */
export function connectedObjects(data: DependenciesData, depth: number): ReadonlySet<number> | undefined {
  const start = data.target;
  if (start === null) return undefined;
  return new Set([
    start,
    ...DIRECTIONS.flatMap((direction) =>
      traverse(data, start, direction, depth).rows.map(({ node }) => node),
    ),
  ]);
}

// The column of each box: one more than the largest column of what it uses. An edge back into a cycle is ignored.
function columnsOf(count: number, uses: ReadonlyMap<number, readonly number[]>): number[] {
  const columns: (number | undefined)[] = Array.from({ length: count });
  const open = new Set<number>();
  const place = (item: number): number => {
    const known = columns[item];
    if (known !== undefined) return known;
    open.add(item);
    let column = 0;
    for (const used of uses.get(item) ?? []) {
      if (!open.has(used)) column = Math.max(column, place(used) + 1);
    }
    open.delete(item);
    columns[item] = column;
    return column;
  };
  return columns.map((_, item) => place(item));
}

// The row of each box: the first column in node order, the others by the mean row of what they use.
function rowsOf(columns: readonly number[], uses: ReadonlyMap<number, readonly number[]>): number[] {
  const rows: number[] = Array.from({ length: columns.length }, () => 0);
  const last = Math.max(-1, ...columns);
  for (let column = 0; column <= last; column++) {
    const items = columns.flatMap((at, item) => (at === column ? [item] : []));
    const weight = (item: number): number => {
      const used = (uses.get(item) ?? []).filter((other) => (columns[other] ?? 0) < column);
      return used.length === 0 ? 0 : used.reduce((sum, other) => sum + (rows[other] ?? 0), 0) / used.length;
    };
    const order = column === 0 ? items : items.toSorted((a, b) => weight(a) - weight(b) || a - b);
    order.forEach((item, index) => {
      rows[item] = index - (order.length - 1) / 2;
    });
  }
  return rows;
}

/**
 * The graph as boxes in columns along the data flow. For the lake or a schema it holds every object of the data; for
 * an object what it uses and what uses it, each up to the depth, or every object on Show all. The names that no object
 * has hang on the objects that name them.
 */
export function picture(data: DependenciesData, input: PictureInput): Picture {
  const near = connectedObjects(data, input.depth);
  const shown =
    near && input.reach === 'connected'
      ? [...near].sort((a, b) => a - b)
      : data.nodes.map((_, index) => index);
  const itemOf = new Map(shown.map((node, item) => [node, item]));
  const boxes: Omit<PictureItem, 'column' | 'row'>[] = shown.map((node) => ({
    node,
    kind: data.nodes[node]?.kind ?? 'table',
    name: nameAt(data, node),
    faint: near !== undefined && !near.has(node),
  }));
  const edges: PictureEdge[] = data.edges.flatMap(({ from, to, kind }) => {
    const [user, used] = [itemOf.get(from), itemOf.get(to)];
    return user === undefined || used === undefined ? [] : [{ from: used, to: user, kind }];
  });
  const missing = new Map<string, number>();
  for (const broken of data.broken) {
    const user = itemOf.get(broken.from);
    if (user === undefined) continue;
    const name = brokenName(broken);
    const key = `${broken.kind}:${name}`;
    let item = missing.get(key);
    if (item === undefined) {
      item = boxes.length;
      missing.set(key, item);
      boxes.push({ node: undefined, kind: 'missing', name, faint: boxes[user]?.faint ?? false });
    }
    edges.push({ from: item, to: user, kind: 'missing' });
  }
  const uses = groupBy(
    edges,
    (edge) => edge.to,
    (edge) => edge.from,
  );
  const columns = columnsOf(boxes.length, uses);
  const rows = rowsOf(columns, uses);
  return {
    items: boxes.map((box, item) => ({ ...box, column: columns[item] ?? 0, row: rows[item] ?? 0 })),
    edges,
  };
}
