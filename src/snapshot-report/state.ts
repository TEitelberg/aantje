import { isArrayOf, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { boundsOf, isBounds, restoredRange } from '../shell/range-state';
import type { Bounds } from '../shell/range-state';

import type { SnapshotReportXAxis } from './chart-options';
import { POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import type { SnapshotReportData } from './model';

interface ViewState {
  readonly lanes: readonly string[];
  readonly kinds: readonly PointKind[];
  readonly range: { readonly from: number; readonly to: number };
  readonly axis: SnapshotReportXAxis;
  readonly selected?: number | undefined;
  readonly other?: number | undefined;
}

interface SavedState extends ViewState {
  readonly connection: string;
  readonly bounds: Bounds;
}

const isSavedState = isShape({
  connection: isString,
  bounds: isBounds,
  lanes: isArrayOf(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  range: isShape({ from: isCount, to: isCount }),
  axis: isOneOf('order', 'time'),
  selected: isOptional(isCount),
  other: isOptional(isCount),
});

/** Restores the choices that still apply; undefined for foreign state or another connection. */
export function restoreState(saved: unknown, data: SnapshotReportData, model: Model): ViewState | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection) {
    return undefined;
  }
  const known = (id: number | undefined): number | undefined =>
    model.snapshots.some((snapshot) => snapshot.id === id) ? id : undefined;
  return {
    lanes: state.lanes.filter((key) => model.lanes.some((lane) => lane.key === key)),
    kinds: state.kinds,
    range: restoredRange(state.range, state.bounds, boundsOf(model.snapshots)),
    axis: state.axis,
    selected: known(state.selected),
    other: known(state.other),
  };
}
