import { isCount, isNullOr, isOneOf, isOptional, isShape, isString } from '../guards';
import { nodeKey } from './graph';
import { DEPTHS } from './model';
import type { DependenciesData } from './model';
import { GRAPH_REACHES } from './picture';
import type { GraphReach } from './picture';

/** The tabs of the page: the objects (List or Objects), the columns, the graph of the objects and of the columns. */
export const TAB_IDS = ['list', 'columns', 'graph', 'columnGraph'] as const;
export type DependenciesTab = (typeof TAB_IDS)[number];

/**
 * The tabs of a report, in their order: List and Graph for the lake or a schema; for an object Objects and Object
 * Graph, and with the column lineage of a table or view also Columns and Column Graph.
 */
export function dependenciesTabs(
  data: DependenciesData,
): readonly { readonly id: DependenciesTab; readonly label: string }[] {
  if (data.target === null) {
    return [
      { id: 'list', label: 'List' },
      { id: 'graph', label: 'Graph' },
    ];
  }
  const columns = data.lineage !== undefined;
  return [
    { id: 'list', label: 'Objects' },
    ...(columns ? [{ id: 'columns', label: 'Columns' } as const] : []),
    { id: 'graph', label: 'Object Graph' },
    ...(columns ? [{ id: 'columnGraph', label: 'Column Graph' } as const] : []),
  ];
}

/** The tab that a report opens on: Columns for the lineage of one column (Show Column Lineage), else the first. */
export const firstTab = (data: DependenciesData): DependenciesTab =>
  data.lineage?.focus === undefined ? 'list' : 'columns';

/** The choices, kept while the panel is hidden or the data is read again. */
export interface DependenciesChoices {
  readonly tab: DependenciesTab;
  readonly reach: GraphReach;
  /** The depth of the tables of an object. */
  readonly depth: number;
  /** The text of the filter box of the table of the lake or a schema. */
  readonly text: string;
  /** The page of that table; undefined for the first. */
  readonly page?: number | undefined;
  /** The object selected in the graph, an index into the nodes of the data. */
  readonly selected?: number | undefined;
}

// The page hands this to VS Code; the selection is kept by name, as the numbers may shift.
interface SavedState {
  readonly connection: string;
  // `kind:id` of the object of the report; null for the lake or a schema.
  readonly target: string | null;
  // Missing in the state of an older version.
  readonly tab?: DependenciesTab | undefined;
  readonly reach?: GraphReach | undefined;
  readonly depth: number;
  readonly text: string;
  readonly page?: number | undefined;
  readonly selected?: string | undefined;
}

const isSavedState = isShape({
  connection: isString,
  target: isNullOr(isString),
  tab: isOptional(isOneOf(...TAB_IDS)),
  reach: isOptional(isOneOf(...GRAPH_REACHES)),
  depth: isOneOf(...DEPTHS),
  text: isString,
  page: isOptional(isCount),
  selected: isOptional(isString),
});

const targetKey = (data: DependenciesData): string | null => {
  const node = data.target === null ? undefined : data.nodes[data.target];
  return node ? nodeKey(node) : null;
};

export function saveChoices(data: DependenciesData, choices: DependenciesChoices): SavedState {
  const node = choices.selected === undefined ? undefined : data.nodes[choices.selected];
  return {
    connection: data.connection,
    target: targetKey(data),
    tab: choices.tab,
    reach: choices.reach,
    depth: choices.depth,
    text: choices.text,
    ...(choices.page === undefined ? {} : { page: choices.page }),
    selected: node ? nodeKey(node) : undefined,
  };
}

/**
 * Restores the choices for the same report: the selected object if it still exists, the tab if the report has it.
 * Undefined for foreign state, another connection or another object.
 */
export function restoreDependenciesChoices(
  saved: unknown,
  data: DependenciesData,
): DependenciesChoices | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection || state.target !== targetKey(data)) {
    return undefined;
  }
  const selected = data.nodes.findIndex((node) => nodeKey(node) === state.selected);
  return {
    tab: dependenciesTabs(data).find(({ id }) => id === state.tab)?.id ?? firstTab(data),
    reach: state.reach ?? 'connected',
    depth: state.depth,
    text: state.text,
    page: state.page,
    selected: selected < 0 ? undefined : selected,
  };
}
