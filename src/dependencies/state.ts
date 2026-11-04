import { isNullOr, isOneOf, isOptional, isShape, isString } from '../guards';
import { DEPTHS, DIRECTIONS, nodeKey } from './model';
import type { DependenciesData, Direction } from './model';

// Kept while the panel is hidden or the data is read again.
interface Choices {
  readonly direction: Direction;
  readonly depth: number;
  readonly text: string;
  // An index into the nodes of the data.
  readonly selected?: number | undefined;
}

// The page hands this to VS Code; the selection is kept by name, as the numbers may shift.
interface SavedState {
  readonly connection: string;
  // `kind:id` of the object of the report; null for the lake.
  readonly target: string | null;
  readonly direction: Direction;
  readonly depth: number;
  readonly text: string;
  readonly selected?: string | undefined;
}

const isSavedState = isShape({
  connection: isString,
  target: isNullOr(isString),
  direction: isOneOf(...DIRECTIONS),
  depth: isOneOf(...DEPTHS),
  text: isString,
  selected: isOptional(isString),
});

const targetKey = (data: DependenciesData): string | null => {
  const node = data.target === null ? undefined : data.nodes[data.target];
  return node ? nodeKey(node) : null;
};

export function saveChoices(data: DependenciesData, choices: Choices): SavedState {
  const node = choices.selected === undefined ? undefined : data.nodes[choices.selected];
  return {
    connection: data.connection,
    target: targetKey(data),
    direction: choices.direction,
    depth: choices.depth,
    text: choices.text,
    selected: node ? nodeKey(node) : undefined,
  };
}

/** Restores the selected object if it still exists; undefined for foreign state, another connection or object. */
export function restoreDependenciesChoices(saved: unknown, data: DependenciesData): Choices | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection || state.target !== targetKey(data)) {
    return undefined;
  }
  const selected = data.nodes.findIndex((node) => nodeKey(node) === state.selected);
  return {
    direction: state.direction,
    depth: state.depth,
    text: state.text,
    selected: selected < 0 ? undefined : selected,
  };
}
