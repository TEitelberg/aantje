import { isArrayOf, isCount, isObject, isOneOf, isOptional, isShape, isString, own } from '../guards';
import { isReportScope } from '../shell/scope';
import { actionGuard } from '../shell/protocol';
import type { ActionMessage } from '../shell/protocol';
import { NODE_KINDS, UNRESOLVED_REASONS } from './graph';
import { COLUMN_USES } from './lineage-scope';
import type { DependenciesMarkdownView } from './markdown';
import { DEPTHS } from './model';
import { GRAPH_REACHES } from './picture';
import type { DependenciesData } from './model';

type DependenciesMessage = { readonly type: 'dependencies'; readonly data: DependenciesData };

const isNode = isShape({
  kind: isOneOf(...NODE_KINDS),
  id: isCount,
  schemaId: isCount,
  schema: isString,
  name: isString,
});

const isEdge = isShape({ from: isCount, to: isCount, kind: isOneOf('reads', 'calls') });

const isBroken = isShape({
  from: isCount,
  kind: isOneOf('relation', 'scalarMacro', 'tableMacro'),
  schema: isString,
  name: isString,
});

const isUnresolved = isShape({ node: isCount, reason: isOneOf(...UNRESOLVED_REASONS), detail: isString });

const isLineage = isShape({
  columns: isArrayOf(isShape({ node: isCount, name: isString })),
  edges: isArrayOf(isShape({ from: isCount, to: isCount, use: isOneOf(...COLUMN_USES) })),
  unknown: isArrayOf(isShape({ column: isCount, detail: isString })),
  opaque: isArrayOf(isShape({ node: isCount, detail: isString })),
  omitted: isCount,
  focus: isOptional(isCount),
});

const isData = isShape({
  connection: isString,
  scope: isReportScope,
  snapshot: isCount,
  target: (value) => value === null || isCount(value),
  isolated: isCount,
  nodes: isArrayOf(isNode),
  edges: isArrayOf(isEdge),
  broken: isArrayOf(isBroken),
  unresolved: isArrayOf(isUnresolved),
  objects: isCount,
  parsed: isCount,
  lineage: isOptional(isLineage),
});

/** Guard for the messages the extension sends to the page; an index must name a node. */
export function isDependenciesMessage(value: unknown): value is DependenciesMessage {
  if (!isObject(value) || own(value, 'type') !== 'dependencies' || !isData(own(value, 'data'))) {
    return false;
  }
  const data = own(value, 'data') as DependenciesData;
  const known = (index: number): boolean => index < data.nodes.length;
  const lineage = data.lineage;
  const column = (index: number): boolean => index < (lineage?.columns.length ?? 0);
  return (
    (data.target === null || known(data.target)) &&
    data.edges.every(({ from, to }) => known(from) && known(to)) &&
    data.broken.every(({ from }) => known(from)) &&
    data.unresolved.every(({ node }) => known(node)) &&
    (lineage === undefined ||
      (lineage.columns.every(({ node }) => known(node)) &&
        lineage.edges.every(({ from, to }) => column(from) && column(to)) &&
        lineage.unknown.every((part) => column(part.column)) &&
        lineage.opaque.every(({ node }) => known(node)) &&
        (lineage.focus === undefined || column(lineage.focus))))
  );
}

/** The actions of an object, by id; the page never names a command. */
export type DependenciesActionId = 'showInTree' | 'showStatistics' | 'showDependencies';

export type DependenciesAction = ActionMessage & {
  readonly action: DependenciesActionId;
  readonly node: number;
};

/** A known action with one object index and no other field; `planDependenciesAction` checks that it fits. */
export const isDependenciesAction: (value: unknown) => value is DependenciesAction = actionGuard({
  showInTree: { node: isCount },
  showStatistics: { node: isCount },
  showDependencies: { node: isCount },
}) as unknown as (value: unknown) => value is DependenciesAction;

/** The choices that Open as Markdown may name: the depth, the filter of the lake table and what the graph holds. */
export const isDependenciesView: (value: unknown) => value is DependenciesMarkdownView = isShape({
  depth: isOneOf(...DEPTHS),
  text: isString,
  reach: isOptional(isOneOf(...GRAPH_REACHES)),
}) as (value: unknown) => value is DependenciesMarkdownView;
