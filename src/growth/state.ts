import { isCount, isOneOf, isOptional, isShape, isString, isNullOr } from '../guards';
import { METRICS, growthModelOf, growthTableChoices } from './model';
import type { GrowthData, Metric, GrowthXAxis } from './model';

/** The tabs below the key figures: the chart, named after the value it shows, then the table of the snapshots. */
export const TAB_IDS = ['chart', 'snapshots'] as const;
export type TabId = (typeof TAB_IDS)[number];

/** The choices and the selection, kept while the panel is hidden or the data is read again. */
export interface Choices {
  readonly table?: number | undefined;
  readonly metric: Metric;
  readonly axis: GrowthXAxis;
  readonly selected?: number | undefined;
  readonly tab: TabId;
  /** The text of the filter box of the table. */
  readonly text: string;
  /** The page of the table; undefined for the page of the selected snapshot. */
  readonly page?: number | undefined;
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
  tab: isOneOf(...TAB_IDS),
  text: isString,
  page: isOptional(isCount),
});

/** What the page keeps for VS Code to hand back. */
export const savedGrowthState = (data: GrowthData, chosen: Choices): SavedState => ({
  connection: data.connection,
  focus: data.focus,
  ...chosen,
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
    tab: state.tab,
    text: state.text,
    page: state.page,
  };
}
