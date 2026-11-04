import { isArrayOf, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { boundsOf, isBounds, restoredRange } from '../shell/range-state';
import type { Bounds } from '../shell/range-state';
import { CELL_KINDS } from './model';
import type { CellKind, SchemaHistoryData } from './model';

interface Choices {
  readonly kinds: readonly CellKind[];
  readonly text: string;
  readonly range: { readonly from: number; readonly to: number };
  readonly selected?: number | undefined;
  readonly column?: number | undefined;
}

interface SavedState extends Choices {
  readonly connection: string;
  readonly tableId: number;
  readonly bounds: Bounds;
}

const isSavedState = isShape({
  connection: isString,
  tableId: isCount,
  bounds: isBounds,
  kinds: isArrayOf(isOneOf(...CELL_KINDS)),
  text: isString,
  range: isShape({ from: isCount, to: isCount }),
  selected: isOptional(isCount),
  column: isOptional(isCount),
});

/** Clamps the range to the snapshots read; a missing snapshot or column selects nothing. */
export function restoreSchemaHistoryChoices(saved: unknown, data: SchemaHistoryData): Choices | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection || state.tableId !== data.tableId) {
    return undefined;
  }
  return {
    kinds: state.kinds,
    text: state.text,
    range: restoredRange(state.range, state.bounds, boundsOf(data.snapshots)),
    selected: state.selected,
    column: state.column,
  };
}
