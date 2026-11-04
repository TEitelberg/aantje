import { isCount, isOneOf, isOptional, isShape, isString, isNullOr } from '../guards';
import { METRICS, growthModelOf, growthTableChoices } from './model';
import type { GrowthData, Metric, GrowthXAxis } from './model';

interface Choices {
  readonly table?: number | undefined;
  readonly metric: Metric;
  readonly axis: GrowthXAxis;
  readonly selected?: number | undefined;
}

interface SavedState extends Choices {
  readonly connection: string;
  readonly focus: number | null;
}

const isSavedState = isShape({
  connection: isString,
  focus: isNullOr(isCount),
  table: isOptional(isCount),
  metric: isOneOf(...METRICS),
  axis: isOneOf('snapshot', 'time'),
  selected: isOptional(isCount),
});

/** Restores the table and snapshot if they exist; undefined for foreign state, another connection or another focus. */
export function restoreGrowthChoices(saved: unknown, data: GrowthData): Choices | undefined {
  if (!isSavedState(saved)) {
    return undefined;
  }
  const state = saved as SavedState;
  if (state.connection !== data.connection || state.focus !== data.focus) {
    return undefined;
  }
  return {
    table: growthTableChoices(data, growthModelOf(data)).some(({ id }) => id === state.table)
      ? state.table
      : undefined,
    metric: state.metric,
    axis: state.axis,
    selected: data.snapshots.some(({ id }) => id === state.selected) ? state.selected : undefined,
  };
}
