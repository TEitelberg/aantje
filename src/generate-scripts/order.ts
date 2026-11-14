import { groupBy } from '../order';
import { nodeKey } from '../dependencies/graph';
import type { DependencyGraph, GraphKey, UnresolvedReason } from '../dependencies/graph';
import { dependencyOrder } from '../dependencies/order';

// The order of the views and macros of Generate Scripts: each after everything it reads or calls, by the graph of the
// Dependencies report. What the graph cannot order comes last.

type Graph = Pick<DependencyGraph, 'nodes' | 'edges' | 'unresolved'>;

export interface DefinitionOrder<T> {
  /** In an order that works: each after the items it uses. */
  readonly ordered: readonly T[];
  /**
   * What the graph cannot order: items in a cycle, items whose SQL has a part that the analysis does not follow, and
   * the items that use one of them. In the best order the graph gives.
   */
  readonly unclear: readonly T[];
  /** For an item that uses objects that are not selected: their schema and name. */
  readonly outside: ReadonlyMap<T, readonly (readonly [string, string])[]>;
}

// A file or another catalog is no object of the lake: it needs no place in the order.
const FOLLOWED: ReadonlySet<UnresolvedReason> = new Set(['file', 'catalog']);

/** The nodes in a cycle of the edges (Tarjan's strongly connected components of more than one node). */
function cycleNodes(nodes: ReadonlySet<number>, edges: readonly (readonly [number, number])[]): Set<number> {
  const next = groupBy(
    edges,
    ([from]) => from,
    ([, to]) => to,
  );
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const stack: number[] = [];
  const onStack = new Set<number>();
  const cycles = new Set<number>();
  const visit = (node: number): void => {
    index.set(node, index.size);
    low.set(node, index.get(node) ?? 0);
    stack.push(node);
    onStack.add(node);
    for (const to of next.get(node) ?? []) {
      if (!index.has(to)) visit(to);
      if (onStack.has(to)) low.set(node, Math.min(low.get(node) ?? 0, low.get(to) ?? 0, index.get(to) ?? 0));
    }
    if (low.get(node) !== index.get(node)) return;
    const component: number[] = [];
    for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) for (const member of component) cycles.add(member);
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return cycles;
}

/**
 * The views and macros in an order that works with the graph, and what it cannot order. `selected` tells the objects
 * of the script, tables included: an object that an item uses and that is not selected is named in `outside`. Without
 * a graph every item is unclear and keeps its place.
 */
export function orderDefinitions<T>(
  items: readonly T[],
  keyOf: (item: T) => GraphKey,
  selected: ReadonlySet<string>,
  graph: Graph | undefined,
): DefinitionOrder<T> {
  if (!graph) return { ordered: [], unclear: [...items], outside: new Map() };
  const nodeOf = new Map(graph.nodes.map((node, index) => [nodeKey(node), index]));
  const nodes = new Set(items.flatMap((item) => nodeOf.get(nodeKey(keyOf(item))) ?? []));
  const inside = graph.edges
    .filter(({ from, to }) => from !== to && nodes.has(from) && nodes.has(to))
    .map(({ from, to }) => [from, to] as const);
  const unclear = cycleNodes(nodes, inside);
  for (const { node, reason } of graph.unresolved) if (!FOLLOWED.has(reason)) unclear.add(node);
  // An item that uses an unclear one cannot come before it: it is unclear too.
  for (let grown = true; grown;) {
    grown = false;
    for (const [from, to] of inside) {
      if (unclear.has(to) && !unclear.has(from)) {
        unclear.add(from);
        grown = true;
      }
    }
  }
  const isUnclear = (item: T): boolean => {
    const node = nodeOf.get(nodeKey(keyOf(item)));
    return node === undefined || unclear.has(node);
  };
  const outside = new Map<T, (readonly [string, string])[]>();
  for (const item of items) {
    const node = nodeOf.get(nodeKey(keyOf(item)));
    const targets = new Set(
      graph.edges.filter(({ from, to }) => from === node && to !== node).map(({ to }) => to),
    );
    const used = [...targets]
      .flatMap((to) => graph.nodes[to] ?? [])
      .filter((target) => !selected.has(nodeKey(target)))
      .map(({ schema, name }) => [schema, name] as const);
    if (used.length > 0) outside.set(item, used);
  }
  return {
    ordered: dependencyOrder(
      items.filter((item) => !isUnclear(item)),
      keyOf,
      graph,
      'usedFirst',
    ),
    unclear: dependencyOrder(items.filter(isUnclear), keyOf, graph, 'usedFirst'),
    outside,
  };
}
