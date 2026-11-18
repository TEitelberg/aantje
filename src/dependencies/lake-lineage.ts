// The column lineage of the views of a lake, from the parse that the dependency graph makes: the columns of every table
// and view, and for each view column the columns one level down that it is built from. A view is read after the views
// it reads, so that `*` over a view has its columns. Pure but for the one call that asks DuckDB the names of select items
// without an alias.
import { messageOf } from '../errors';
import { groupBy } from '../order';
import type { Reference } from '../sql/parse-tree';
import type { DependencyEdge, DependencyNode } from './graph';
import { bodyLineage } from './lineage';
import type { BodyLineage, LineageEnv } from './lineage';
import { unnamedItems } from './lineage-scope';
import type { ColumnUse } from './lineage-scope';
import type { SqlParser } from './parser';
import { messageLine } from './references';

/** A column of a table or view; `node` is an index into the nodes of the graph. */
export interface LineageColumn {
  readonly node: number;
  readonly name: string;
}

/** The view column `from` is built from the column `to` as `use`; both are indexes into the columns. */
export interface LineageEdge {
  readonly from: number;
  readonly to: number;
  readonly use: ColumnUse;
}

export interface Lineage {
  /** The columns of the tables and of the views that could be read, each object's in its order. */
  readonly columns: readonly LineageColumn[];
  readonly edges: readonly LineageEdge[];
  /** A part of a view column whose source cannot be named: `a column of the table function range`. */
  readonly unknown: readonly { readonly column: number; readonly detail: string }[];
  /** Views whose columns cannot be told, and why. */
  readonly opaque: readonly { readonly node: number; readonly detail: string }[];
}

/** The parsed statement of a view and its column list. */
export interface ParsedView {
  readonly statement: unknown;
  readonly aliases: readonly string[];
}

export interface LineageInput {
  readonly nodes: readonly DependencyNode[];
  readonly edges: readonly DependencyEdge[];
  /** The views that DuckDB parsed, by node index. */
  readonly views: ReadonlyMap<number, ParsedView>;
  /** The columns of the tables by table id. */
  readonly tables: ReadonlyMap<number, readonly string[]>;
  /** The table or view that a name after FROM in the SQL of `node` stands for. */
  relation(node: number, reference: Reference): number | undefined;
  /** The macro that a call in the SQL of `node` stands for. */
  macro(
    node: number,
    reference: Reference & { readonly kind: 'scalarMacro' | 'tableMacro' },
  ): number | undefined;
}

const isMacro = (node: DependencyNode | undefined): boolean =>
  node?.kind === 'scalarMacro' || node?.kind === 'tableMacro';

/** The macros that read a table or view, themselves or through the macros they call. */
export function readingMacros(
  nodes: readonly DependencyNode[],
  edges: readonly DependencyEdge[],
): ReadonlySet<number> {
  const callers = groupBy(
    edges.filter(({ kind }) => kind === 'calls'),
    ({ to }) => to,
    ({ from }) => from,
  );
  const reading = new Set<number>();
  const todo = edges
    .filter(({ kind, from }) => kind === 'reads' && isMacro(nodes[from]))
    .map(({ from }) => from);
  for (let macro = todo.pop(); macro !== undefined; macro = todo.pop()) {
    if (reading.has(macro)) continue;
    reading.add(macro);
    todo.push(...(callers.get(macro) ?? []).filter((caller) => isMacro(nodes[caller])));
  }
  return reading;
}

/** The views in an order where each comes after the views it reads; a cycle is broken where it closes. */
export function viewOrder(views: readonly number[], edges: readonly DependencyEdge[]): number[] {
  const known = new Set(views);
  const reads = groupBy(
    edges.filter(({ kind, from, to }) => kind === 'reads' && known.has(from) && known.has(to)),
    ({ from }) => from,
    ({ to }) => to,
  );
  const ordered: number[] = [];
  const placed = new Set<number>();
  for (const start of views) {
    if (placed.has(start)) continue;
    // Depth first without recursion: a view goes when everything it reads went.
    const stack: { readonly view: number; next: number }[] = [{ view: start, next: 0 }];
    const open = new Set<number>([start]);
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top) break;
      const used = reads.get(top.view)?.[top.next];
      top.next++;
      if (used === undefined) {
        stack.pop();
        open.delete(top.view);
        if (!placed.has(top.view)) {
          placed.add(top.view);
          ordered.push(top.view);
        }
      } else if (!placed.has(used) && !open.has(used)) {
        open.add(used);
        stack.push({ view: used, next: 0 });
      }
    }
  }
  return ordered;
}

/** The environment in which the body of `node` is read: the columns known so far, and the names of its items. */
export function lineageEnv(
  input: Pick<LineageInput, 'nodes' | 'relation' | 'macro'>,
  node: number,
  columns: (node: number) => readonly string[] | undefined,
  names: ReadonlyMap<object, string | undefined>,
  reading: ReadonlySet<number>,
  params: ReadonlySet<string> = new Set(),
): LineageEnv {
  const { nodes } = input;
  return {
    relation: (reference) => input.relation(node, reference),
    named: (other) => ({ schema: nodes[other]?.schema ?? '', name: nodes[other]?.name ?? '' }),
    columns,
    name: (item) => names.get(item),
    readingCall: (reference) => {
      const macro = input.macro(node, { ...reference, kind: 'scalarMacro' });
      const found = macro === undefined ? undefined : nodes[macro];
      return found && macro !== undefined && reading.has(macro) ? `${found.schema}.${found.name}` : undefined;
    },
    params,
  };
}

/** Asks DuckDB once for the names of the select items without an alias in the statements. */
export async function itemNames(
  statements: Iterable<unknown>,
  parser: Pick<SqlParser, 'names'>,
): Promise<Map<object, string | undefined>> {
  const items = [...statements].flatMap(unnamedItems);
  const names = parser.names ? await parser.names(items) : [];
  return new Map(items.map((item, index) => [item, names[index]]));
}

/** The lineage of every view that parsed, in the order of what they read. */
export async function lakeLineage(
  input: LineageInput,
  parser: Pick<SqlParser, 'names'>,
  signal?: AbortSignal,
): Promise<Lineage> {
  const { nodes, views, tables } = input;
  const names = await itemNames(
    [...views.values()].map(({ statement }) => statement),
    parser,
  );
  const reading = readingMacros(nodes, input.edges);
  const known = new Map<number, readonly string[]>();
  for (const [index, node] of nodes.entries()) {
    const columns = node.kind === 'table' ? tables.get(node.id) : undefined;
    if (columns) known.set(index, columns);
  }
  const read = new Map<number, BodyLineage | string>();
  const order = viewOrder(
    [...views.keys()].sort((a, b) => a - b),
    input.edges,
  );
  for (const view of order) {
    signal?.throwIfAborted();
    const parsed = views.get(view);
    if (!parsed) continue;
    try {
      const env = lineageEnv(input, view, (node) => known.get(node), names, reading);
      const lineage = bodyLineage(parsed.statement, env, parsed.aliases);
      if (lineage.columns)
        known.set(
          view,
          lineage.columns.map(({ name }) => name),
        );
      read.set(view, lineage);
    } catch (error) {
      // A text nested deeper than the stack, or one the analysis fails on, leaves the others as they are.
      read.set(view, `the analysis could not follow its SQL: ${messageLine(messageOf(error))}`);
    }
  }
  return assemble(nodes, known, read);
}

// The lineage in indexes: every table's and view's columns, then the edges and unknown parts of the view columns.
function assemble(
  nodes: readonly DependencyNode[],
  known: ReadonlyMap<number, readonly string[]>,
  read: ReadonlyMap<number, BodyLineage | string>,
): Lineage {
  const columns: LineageColumn[] = [];
  const index = new Map<string, number>();
  const at = (node: number, name: string): number => {
    const key = `${node}\u0000${name}`;
    let found = index.get(key);
    if (found === undefined) {
      found = columns.length;
      columns.push({ node, name });
      index.set(key, found);
    }
    return found;
  };
  for (const [node, names] of [...known].sort(([a], [b]) => a - b)) {
    for (const name of names) at(node, name);
  }
  const edges: LineageEdge[] = [];
  const unknown: { column: number; detail: string }[] = [];
  const opaque: { node: number; detail: string }[] = [];
  for (const [node, entry] of nodes.entries()) {
    if (entry.kind !== 'view') continue;
    const lineage = read.get(node);
    if (lineage === undefined || typeof lineage === 'string' || !lineage.columns) {
      opaque.push({
        node,
        detail:
          typeof lineage === 'string'
            ? lineage
            : (lineage?.opaque ?? 'its SQL was not read: it is listed under Not followed, or past the limit'),
      });
      continue;
    }
    for (const column of lineage.columns) {
      const from = at(node, column.name);
      for (const { key, use } of column.sources) edges.push({ from, to: at(key.node, key.name), use });
      for (const detail of column.unknown) unknown.push({ column: from, detail });
    }
  }
  return { columns, edges, unknown, opaque };
}
