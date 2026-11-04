import type { CatalogReader, SnapshotId } from '../catalog/model';
import { buildGraph } from './graph';
import type { CatalogObjects, DependencyGraph } from './graph';
import { traverse } from './model';
import { LAKE_SCOPE } from '../shell/scope';
import type { DependenciesData } from './model';
import type { SqlParser } from './parser';

/** The tables, views and macros of every schema at the snapshot, with the SQL of the views and macros. */
export async function readObjects(
  reader: CatalogReader,
  snapshot: SnapshotId,
  signal?: AbortSignal,
): Promise<CatalogObjects> {
  // One statement per kind of object, whatever the number of schemas: on a remote catalog each is a round trip.
  const schemas = await reader.schemas(snapshot);
  const entries = await reader.entries(snapshot);
  signal?.throwIfAborted();
  const views = entries.some(({ kind }) => kind === 'view') ? await reader.views(null, snapshot) : [];
  signal?.throwIfAborted();
  const macros = await reader.macros(null, snapshot);
  return { schemas, entries, views, macros };
}

// Snapshots kept in the cache; the user moves between a few.
const KEPT = 3;

// A read that several callers wait for; the last one to give up cancels it.
interface Read {
  readonly graph: Promise<DependencyGraph>;
  readonly abort: AbortController;
  waiting: number;
}

const cache = new WeakMap<CatalogReader, Map<SnapshotId, Read>>();

/**
 * The graph at a snapshot, cached for the last `KEPT` snapshots; callers share a running read.
 * A failed or cancelled read is not kept.
 */
export async function readGraph(
  reader: CatalogReader,
  parser: SqlParser,
  snapshot: SnapshotId,
  signal?: AbortSignal,
): Promise<DependencyGraph> {
  signal?.throwIfAborted();
  const kept = cache.get(reader) ?? new Map<SnapshotId, Read>();
  cache.set(reader, kept);
  const known = kept.get(snapshot);
  kept.delete(snapshot);
  let read = known?.abort.signal.aborted ? undefined : known;
  if (!read) {
    const abort = new AbortController();
    const graph = readObjects(reader, snapshot, abort.signal).then((objects) =>
      buildGraph(objects, parser, { signal: abort.signal }),
    );
    read = { graph, abort, waiting: 0 };
    const started = read;
    // A failed read is not kept; the caller sees the failure through the returned promise.
    graph.catch(() => {
      if (kept.get(snapshot) === started) {
        kept.delete(snapshot);
      }
    });
  }
  kept.set(snapshot, read);
  for (const old of kept.keys()) {
    if (kept.size <= KEPT) {
      break;
    }
    kept.delete(old);
  }
  return join(read, signal);
}

function join(read: Read, signal: AbortSignal | undefined): Promise<DependencyGraph> {
  read.waiting++;
  const cancelled = new Promise<never>((_, reject) => {
    signal?.addEventListener(
      'abort',
      () => {
        if (--read.waiting === 0) {
          read.abort.abort(signal.reason);
        }
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
  return Promise.race([read.graph, cancelled]);
}

// The part of the graph with the given nodes, numbered anew; edges and issues of other nodes are dropped.
function restrict(graph: DependencyGraph, keep: readonly number[]): DependencyGraph {
  const index = new Map(keep.map((old, now) => [old, now]));
  const at = (old: number): number | undefined => index.get(old);
  return {
    nodes: keep.flatMap((old) => graph.nodes[old] ?? []),
    edges: graph.edges.flatMap(({ from, to, kind }) => {
      const [a, b] = [at(from), at(to)];
      return a !== undefined && b !== undefined ? [{ from: a, to: b, kind }] : [];
    }),
    broken: graph.broken.flatMap((item) => {
      const from = at(item.from);
      return from === undefined ? [] : [{ ...item, from }];
    }),
    unresolved: graph.unresolved.flatMap((item) => {
      const node = at(item.node);
      return node === undefined ? [] : [{ ...item, node }];
    }),
    objects: graph.objects,
    parsed: graph.parsed,
  };
}

/** The report of the whole lake: the objects that use or are used by another, or that have a problem. */
export function lakeData(graph: DependencyGraph, connection: string, snapshot: SnapshotId): DependenciesData {
  const involved = new Set([
    ...graph.edges.flatMap(({ from, to }) => [from, to]),
    ...graph.broken.map(({ from }) => from),
    ...graph.unresolved.map(({ node }) => node),
  ]);
  const keep = [...involved].sort((a, b) => a - b);
  return {
    ...restrict(graph, keep),
    connection,
    scope: LAKE_SCOPE,
    snapshot,
    target: null,
    isolated: graph.nodes.length - keep.length,
  };
}

/**
 * The report of one schema: its objects that use or are used by another, or have a problem, and the objects of other
 * schemas next to them.
 */
export function schemaData(
  graph: DependencyGraph,
  connection: string,
  snapshot: SnapshotId,
  schema: { readonly id: number; readonly name: string },
): DependenciesData {
  const own = new Set(graph.nodes.flatMap((node, index) => (node.schemaId === schema.id ? [index] : [])));
  const involved = new Set([
    ...graph.edges.flatMap(({ from, to }) => [from, to]).filter((node) => own.has(node)),
    ...graph.broken.map(({ from }) => from).filter((node) => own.has(node)),
    ...graph.unresolved.map(({ node }) => node).filter((node) => own.has(node)),
  ]);
  const neighbours = graph.edges.flatMap(({ from, to }) =>
    involved.has(from) ? [to] : involved.has(to) ? [from] : [],
  );
  const keep = [...new Set([...involved, ...neighbours])].sort((a, b) => a - b);
  return {
    ...restrict(graph, keep),
    connection,
    scope: { kind: 'schema', ...schema },
    snapshot,
    target: null,
    isolated: own.size - involved.size,
  };
}

/** One object with everything it uses and everything that uses it; undefined if the graph lacks it. */
export function objectData(
  graph: DependencyGraph,
  connection: string,
  snapshot: SnapshotId,
  target: { readonly kind: DependencyGraph['nodes'][number]['kind']; readonly id: number },
): DependenciesData | undefined {
  const start = graph.nodes.findIndex(({ kind, id }) => kind === target.kind && id === target.id);
  if (start < 0) {
    return undefined;
  }
  const keep = [
    ...new Set([
      start,
      ...traverse(graph, start, 'usedBy', 1).reached,
      ...traverse(graph, start, 'dependsOn', 1).reached,
    ]),
  ].sort((a, b) => a - b);
  return {
    ...restrict(graph, keep),
    connection,
    scope: LAKE_SCOPE,
    snapshot,
    target: keep.indexOf(start),
    isolated: 0,
  };
}
