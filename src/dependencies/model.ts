import { groupBy } from '../order';
import { count } from '../shell/model';
import type { Card } from '../shell/model';
import type { ReportScope } from '../shell/scope';
import type { ReportLineage } from './columns';
import type {
  BrokenReference,
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  NodeKind,
  Unresolved,
} from './graph';

/** The graph of the objects that matter for the report, and what it is about. */
export interface DependenciesData extends Omit<DependencyGraph, 'lineage'> {
  /** The column lineage around the object of the report; none for the lake or a schema. */
  readonly lineage?: ReportLineage | undefined;
  readonly connection: string;
  /** The lake, or one schema: the report then lists its objects and their direct neighbours in other schemas. */
  readonly scope: ReportScope;
  readonly snapshot: number;
  /** The object of the report (an index into `nodes`); null for the report of the whole lake. */
  readonly target: number | null;
  /** Objects that no other object uses and that use none; the lake report leaves them out. */
  readonly isolated: number;
}

/** Whose dependencies a table shows: the objects that this one uses, or the objects that use this one. */
export type Direction = 'usedBy' | 'dependsOn';

/** In the order of the tables of an object: what it depends on, then what uses it. */
export const DIRECTIONS: readonly Direction[] = ['dependsOn', 'usedBy'];
export const DIRECTION_LABEL: Readonly<Record<Direction, string>> = {
  usedBy: 'Used by',
  dependsOn: 'Depends on',
};

export const MAX_DEPTH = 5;
export const DEPTHS: readonly number[] = [1, 2, 3, 4, 5];

// Rows of a table of an object shown at most; a smaller depth reaches the others.
const MAX_ROWS = 500;

export const DEPENDENCIES_KIND_LABEL: Readonly<Record<NodeKind, string>> = {
  table: 'table',
  view: 'view',
  scalarMacro: 'scalar macro',
  tableMacro: 'table macro',
};

/** A sign before the name: the kind then does not depend on colour or the icon font. */
export const KIND_SIGN: Readonly<Record<NodeKind, string>> = {
  table: '▦',
  view: '◧',
  scalarMacro: 'ƒ',
  tableMacro: 'ƒ▦',
};

/** `shop.events`: the names as the tree shows them, without quotes. */
export const nodeName = (node: DependencyNode): string => `${node.schema}.${node.name}`;

// One object of a list, reached from `parent` over one edge.
interface Row {
  readonly node: number;
  // 1 for an object next to the start.
  readonly depth: number;
  readonly parent: number;
  // What the edge says; the direction of the list tells who reads whom.
  readonly via: DependencyEdge['kind'];
}

interface Traversal {
  // The objects up to the depth in preorder: the children of an object follow it, in node order.
  readonly rows: readonly Row[];
  // Every object reached at any depth, in node order.
  readonly reached: readonly number[];
  // Rows left out because the list is cut at `MAX_ROWS`.
  readonly omitted: number;
  // An object is reached from itself: a view that reads itself, macros that call each other.
  readonly cycle: boolean;
}

/** The objects that use `start` (`usedBy`) or that it uses (`dependsOn`), up to `depth` levels; each once. */
export function traverse(
  data: Pick<DependenciesData, 'edges'>,
  start: number,
  direction: Direction,
  depth: number,
): Traversal {
  const next = groupBy(
    data.edges,
    ({ from, to }) => (direction === 'usedBy' ? to : from),
    ({ from, to, kind }) => ({ to: direction === 'usedBy' ? from : to, via: kind }),
  );
  for (const list of next.values()) {
    list.sort((a, b) => a.to - b.to);
  }
  const parents = new Map<number, Row>();
  const seen = new Set([start]);
  let cycle = false;
  const isAncestor = (candidate: number, of: number): boolean => {
    for (let at: number | undefined = of; at !== undefined; at = parents.get(at)?.parent) {
      if (at === candidate) {
        return true;
      }
    }
    return false;
  };
  for (let level = [start], at = 1; level.length > 0; at++) {
    const following: number[] = [];
    for (const from of level) {
      for (const { to, via } of next.get(from) ?? []) {
        if (isAncestor(to, from)) {
          cycle = true;
        } else if (!seen.has(to)) {
          seen.add(to);
          const row = { node: to, depth: at, parent: from, via };
          parents.set(to, row);
          following.push(to);
        }
      }
    }
    level = following;
  }
  // Every node reached once, below the node it was reached from, in the order it was reached.
  const children = groupBy(parents.values(), (row) => row.parent);
  const rows: Row[] = [];
  const visit = (from: number): void => {
    for (const row of children.get(from) ?? []) {
      if (row.depth <= depth) {
        rows.push(row);
        visit(row.node);
      }
    }
  };
  visit(start);
  return {
    rows: rows.slice(0, MAX_ROWS),
    reached: [...parents.keys()].sort((a, b) => a - b),
    omitted: Math.max(rows.length - MAX_ROWS, 0),
    cycle,
  };
}

/** The name of an object by index, empty for an index that is no node. */
export function nameAt(data: Pick<DependenciesData, 'nodes'>, index: number): string {
  const node = data.nodes[index];
  return node ? nodeName(node) : '';
}

/** The broken and the unresolved references of the given objects (all of them without a set). */
export function issuesOf(
  data: DependenciesData,
  nodes?: ReadonlySet<number>,
): { readonly broken: BrokenReference[]; readonly unresolved: Unresolved[] } {
  const keep = (index: number): boolean => nodes === undefined || nodes.has(index);
  return {
    broken: data.broken.filter(({ from }) => keep(from)),
    unresolved: data.unresolved.filter(({ node }) => keep(node)),
  };
}

export function brokenName(broken: BrokenReference): string {
  return broken.kind === 'relation'
    ? `${broken.schema}.${broken.name}`
    : `${broken.schema === '' ? '' : `${broken.schema}.`}${broken.name}()`;
}

export function cards(data: DependenciesData): Card[] {
  const issues = issuesOf(data);
  const problems: Card[] = [
    {
      label: 'Broken references',
      value: count(issues.broken.length),
      detail: 'Names that no object has',
      severity: issues.broken.length > 0 ? 'warning' : 'ok',
      hint: 'A view or macro names a table, view or macro that the lake does not have at this snapshot, or a function that DuckDB does not have built in (a function of an extension counts too).',
    },
    {
      label: 'Not followed',
      value: count(issues.unresolved.length),
      detail: 'Texts that could not be read',
      severity: issues.unresolved.length > 0 ? 'warning' : 'ok',
      hint: 'SQL in another dialect, or that DuckDB cannot parse or the analysis cannot follow. Their dependencies are unknown.',
    },
  ];
  if (data.target === null) {
    return [
      { label: 'Objects with dependencies', value: count(data.nodes.length), severity: 'ok' },
      { label: 'Dependencies', value: count(data.edges.length), severity: 'ok' },
      ...problems,
    ];
  }
  const used = traverse(data, data.target, 'usedBy', 1);
  const uses = traverse(data, data.target, 'dependsOn', 1);
  const total = (all: Traversal): string => `${count(all.reached.length)} in all`;
  return [
    {
      label: 'Used by',
      value: count(used.rows.length),
      detail: total(traverse(data, data.target, 'usedBy', MAX_DEPTH)),
      severity: 'ok',
    },
    {
      label: 'Depends on',
      value: count(uses.rows.length),
      detail: total(traverse(data, data.target, 'dependsOn', MAX_DEPTH)),
      severity: 'ok',
    },
    ...problems,
  ];
}

/** Says that the object limit was exceeded and the rest was not read; undefined otherwise. */
export function limitNote(data: DependenciesData): string | undefined {
  return data.parsed < data.objects
    ? `Only ${count(data.parsed)} of ${count(data.objects)} views and macros were read. The others show no dependencies and their references are missing here.`
    : undefined;
}

interface LakeRow {
  readonly node: number;
  readonly usedBy: number;
  readonly dependsOn: number;
}

/**
 * Whether the name or the kind of an object contains the filter `text`, ignoring case; an empty text keeps all. The
 * filter box of the table of the page finds the same rows: it looks in the name and in the kind.
 */
function matchesFilter(node: DependencyNode, text: string): boolean {
  const needle = text.trim().toLowerCase();
  return (
    needle === '' ||
    nodeName(node).toLowerCase().includes(needle) ||
    DEPENDENCIES_KIND_LABEL[node.kind].toLowerCase().includes(needle)
  );
}

/**
 * The objects of the lake or schema that match the filter `text`, with the number of direct users and of direct
 * dependencies: most used first, then in node order (by schema and name). At most `limit` when one is given.
 */
export function lakeRows(
  data: DependenciesData,
  text: string,
  limit?: number,
): { readonly rows: LakeRow[]; readonly omitted: number } {
  const used = new Map<number, number>();
  const uses = new Map<number, number>();
  for (const { from, to } of data.edges) {
    used.set(to, (used.get(to) ?? 0) + 1);
    uses.set(from, (uses.get(from) ?? 0) + 1);
  }
  const all = data.nodes
    .map((node, index) => ({ index, node }))
    .filter(({ node }) => matchesFilter(node, text))
    .map(({ index }) => ({ node: index, usedBy: used.get(index) ?? 0, dependsOn: uses.get(index) ?? 0 }))
    .sort((a, b) => b.usedBy - a.usedBy || a.node - b.node);
  return limit === undefined
    ? { rows: all, omitted: 0 }
    : { rows: all.slice(0, limit), omitted: Math.max(all.length - limit, 0) };
}
