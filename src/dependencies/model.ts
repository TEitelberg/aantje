import { count, plural } from '../shell/model';
import type { Card } from '../shell/model';
import type { ReportScope } from '../shell/scope';
import type {
  BrokenReference,
  DependencyEdge,
  DependencyGraph,
  DependencyNode,
  NodeKind,
  Unresolved,
  UnresolvedReason,
} from './graph';

/** The graph of the objects that matter for the report, and what it is about. */
export interface DependenciesData extends DependencyGraph {
  readonly connection: string;
  /** The lake, or one schema: the report then lists its objects and their direct neighbours in other schemas. */
  readonly scope: ReportScope;
  readonly snapshot: number;
  /** The object of the report (an index into `nodes`); null for the report of the whole lake. */
  readonly target: number | null;
  /** Objects that no other object uses and that use none; the lake report leaves them out. */
  readonly isolated: number;
}

/** Whose dependencies a list shows: the objects that use this one, or the objects that this one uses. */
export type Direction = 'usedBy' | 'dependsOn';

export const DIRECTIONS: readonly Direction[] = ['usedBy', 'dependsOn'];
export const DIRECTION_LABEL: Readonly<Record<Direction, string>> = {
  usedBy: 'Used by',
  dependsOn: 'Depends on',
};

export const MAX_DEPTH = 5;
export const DEPTHS: readonly number[] = [1, 2, 3, 4, 5];

// Rows of a list shown at most; a filter or a smaller depth reaches the others.
const MAX_ROWS = 500;
export const MAX_LAKE_ROWS = 200;
export const MAX_ISSUES = 100;
const MAX_NAMES = 10;

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

/** The key of the panel and of the saved state for an object. */
export const nodeKey = (node: DependencyNode): string => `${node.kind}:${node.id}`;

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
  const next = new Map<number, { readonly to: number; readonly via: DependencyEdge['kind'] }[]>();
  for (const { from, to, kind } of data.edges) {
    const [source, target] = direction === 'usedBy' ? [to, from] : [from, to];
    next.set(source, [...(next.get(source) ?? []), { to: target, via: kind }]);
  }
  for (const list of next.values()) {
    list.sort((a, b) => a.to - b.to);
  }
  const parents = new Map<number, Row>();
  const children = new Map<number, Row[]>();
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
          children.set(from, [...(children.get(from) ?? []), row]);
          following.push(to);
        }
      }
    }
    level = following;
  }
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

// Every object that uses the dropped one, directly or through others, fails.
interface DropImpact {
  readonly objects: readonly number[];
  // `2 views and 1 table macro`; empty when nothing breaks.
  readonly summary: string;
  // The first `MAX_NAMES` by name, and how many more there are.
  readonly names: readonly string[];
  readonly more: number;
}

export function dropImpact(data: DependenciesData, target: number): DropImpact {
  // Only the objects reached count, at any depth; the rows of the list are not needed.
  const { reached: objects } = traverse(data, target, 'usedBy', 0);
  const perKind = new Map<NodeKind, number>();
  for (const index of objects) {
    const kind = data.nodes[index]?.kind;
    if (kind) {
      perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
    }
  }
  const phrase: Record<NodeKind, [string, string]> = {
    table: ['table', 'tables'],
    view: ['view', 'views'],
    scalarMacro: ['scalar macro', 'scalar macros'],
    tableMacro: ['table macro', 'table macros'],
  };
  const names = objects
    .map((index) => data.nodes[index])
    .filter((node): node is DependencyNode => node !== undefined)
    .map(nodeName);
  return {
    objects,
    summary: (Object.keys(phrase) as NodeKind[])
      .filter((kind) => perKind.has(kind))
      .map((kind) => plural(perKind.get(kind) ?? 0, ...phrase[kind]))
      .join(', '),
    names: names.slice(0, MAX_NAMES),
    more: Math.max(names.length - MAX_NAMES, 0),
  };
}

/** The name of an object by index, empty for an index that is no node. */
export function nameAt(data: Pick<DependenciesData, 'nodes'>, index: number): string {
  const node = data.nodes[index];
  return node ? nodeName(node) : '';
}

/** The sentence for the impact; `name` is how the object is written, code in a document. */
export function impactText(name: string, impact: DropImpact): string {
  return impact.objects.length === 0
    ? `Nothing in this lake uses ${name}; dropping it breaks no view or macro.`
    : `Dropping ${name} breaks ${plural(impact.objects.length, 'object', 'objects')}: ${impact.summary}.`;
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

export const BROKEN_KIND: Readonly<Record<BrokenReference['kind'], string>> = {
  relation: 'table or view',
  scalarMacro: 'macro or unknown function',
  tableMacro: 'table macro or unknown function',
};

/** Why an object could not be followed; the detail after it is catalog text. */
export const REASON_TEXT: Readonly<Record<UnresolvedReason, string>> = {
  dialect: 'Stored in another SQL dialect, which is not read:',
  tooLong: 'Too long to read:',
  syntax: 'DuckDB cannot parse the text:',
  unsupported: 'DuckDB cannot read the text as a SELECT:',
  callerSchema:
    'Names an object that only the schema of this macro has; a macro finds names in the schema of its caller:',
  catalog: 'Reads another catalog than the lake:',
  file: 'Reads a file or a URL:',
  dynamic: 'Looks up a table at run time with',
};

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

/** The lake's objects, most used first; `text` keeps those whose name or kind contains it, ignoring case. */
export function lakeRows(
  data: DependenciesData,
  text: string,
  limit = MAX_LAKE_ROWS,
): { readonly rows: LakeRow[]; readonly omitted: number } {
  const used = new Map<number, number>();
  const uses = new Map<number, number>();
  for (const { from, to } of data.edges) {
    used.set(to, (used.get(to) ?? 0) + 1);
    uses.set(from, (uses.get(from) ?? 0) + 1);
  }
  const needle = text.trim().toLowerCase();
  const all = data.nodes
    .map((node, index) => ({ index, node }))
    .filter(
      ({ node }) =>
        needle === '' ||
        `${nodeName(node)} ${DEPENDENCIES_KIND_LABEL[node.kind]}`.toLowerCase().includes(needle),
    )
    .map(({ index }) => ({ node: index, usedBy: used.get(index) ?? 0, dependsOn: uses.get(index) ?? 0 }))
    .sort((a, b) => b.usedBy - a.usedBy || a.node - b.node);
  return { rows: all.slice(0, limit), omitted: Math.max(all.length - limit, 0) };
}

export const edgeVerb = (via: DependencyEdge['kind'], direction: Direction): string =>
  direction === 'usedBy' ? (via === 'reads' ? 'reads' : 'calls') : via === 'reads' ? 'read by' : 'called by';
