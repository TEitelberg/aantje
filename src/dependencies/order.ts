import { groupBy } from '../order';
import type { Logger } from '../log';
import { buildGraph, nodeKey } from './graph';
import type { CatalogObjects, DependencyGraph, GraphKey } from './graph';
import type { SqlParser } from './parser';

// The order of the statements of a script by the dependency graph: Script as Update of two schemas creates and drops
// views and macros in it, and Generate Scripts creates them in it.

/**
 * The graph that orders the views and macros of a script: every view and macro is parsed, whatever their number. When
 * it cannot be read, the failure is logged and the result is undefined, so the script goes without an order; a cancel
 * stops the command.
 */
export async function scriptGraph(
  objects: CatalogObjects,
  parser: SqlParser,
  { signal, logger, failure }: { signal: AbortSignal; logger: Logger; failure: string },
): Promise<DependencyGraph | undefined> {
  try {
    return await buildGraph(objects, parser, { signal, limit: Number.POSITIVE_INFINITY });
  } catch (error) {
    signal.throwIfAborted();
    logger.error(failure, error);
    return undefined;
  }
}

/**
 * The items in an order that works with the edges of the graph: each after the items it uses (`usedFirst`, for
 * creating), or before them (`usersFirst`, for dropping). A cycle is broken where it closes; items the graph does not
 * know, and all of them without a graph, keep their place.
 */
export function dependencyOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => GraphKey,
  graph: Pick<DependencyGraph, 'nodes' | 'edges'> | undefined,
  direction: 'usedFirst' | 'usersFirst',
): T[] {
  if (!graph) return [...items];
  const nodeOf = new Map(graph.nodes.map((node, index) => [nodeKey(node), index]));
  const itemOf = new Map<number, T>();
  for (const item of items) {
    const node = nodeOf.get(nodeKey(keyOf(item)));
    if (node !== undefined) itemOf.set(node, item);
  }
  // Before an item can go, the items it waits for must.
  const pairs = graph.edges
    .map(({ from, to }): [number, number] => (direction === 'usedFirst' ? [from, to] : [to, from]))
    .filter(([item, first]) => item !== first && itemOf.has(item) && itemOf.has(first));
  const waitsFor = groupBy(
    pairs,
    ([item]) => item,
    ([, first]) => first,
  );
  const ordered: T[] = [];
  const placed = new Set<number>();
  const open = new Set<number>();
  const place = (node: number): void => {
    if (placed.has(node) || open.has(node)) return;
    open.add(node);
    for (const first of waitsFor.get(node) ?? []) place(first);
    open.delete(node);
    placed.add(node);
    const item = itemOf.get(node);
    if (item !== undefined) ordered.push(item);
  };
  for (const item of items) {
    const node = nodeOf.get(nodeKey(keyOf(item)));
    if (node === undefined) ordered.push(item);
    else place(node);
  }
  return ordered;
}
