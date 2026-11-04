import { isArrayOf, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { POINT_KINDS } from '../snapshot-report/model';
import type { Model, PointKind } from '../snapshot-report/model';
import { boundsOf, isBounds, restoredRange } from '../shell/range-state';
import type { Bounds } from '../shell/range-state';
import { choices } from './model';
import type { ActivityData } from './model';

// Kept while the panel is hidden or the data is read again.
interface Choices {
  readonly author?: string | undefined;
  readonly table?: string | undefined;
  readonly kinds: readonly PointKind[];
  readonly text: string;
  readonly range: { readonly from: number; readonly to: number };
  readonly selected?: number | undefined;
}

interface SavedState extends Choices {
  readonly connection: string;
  // The snapshots the range was chosen in.
  readonly bounds: Bounds;
}

const isSavedState = isShape({
  connection: isString,
  bounds: isBounds,
  author: isOptional(isString),
  table: isOptional(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  text: isString,
  range: isShape({ from: isCount, to: isCount }),
  selected: isOptional(isCount),
});

/** Restores the saved filters without any author, table or snapshot the data lacks; undefined for foreign state. */
export function restoreActivityChoices(
  saved: unknown,
  data: ActivityData,
  model: Model,
): Choices | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection) {
    return undefined;
  }
  const offered = choices(model);
  return {
    author: offered.authors.some(({ key }) => key === state.author) ? state.author : undefined,
    table: offered.tables.some(({ key }) => key === state.table) ? state.table : undefined,
    kinds: state.kinds,
    text: state.text,
    range: restoredRange(state.range, state.bounds, boundsOf(model.snapshots)),
    selected: model.snapshots.some(({ id }) => id === state.selected) ? state.selected : undefined,
  };
}
