import { isArrayOf, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { boundsOf, isBounds } from '../shell/range-state';
import type { Bounds } from '../shell/range-state';
import { CELL_KINDS, comparePoints } from './model';
import type { CellKind, SchemaHistoryData } from './model';

/** The comparison of two snapshots first, then the changes of one column. */
export const TABS = [
  { id: 'compare', label: 'Compare' },
  { id: 'search', label: 'Search Changes' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** The tab, the two snapshots, the filters and the column of Search Changes. */
export interface SchemaHistoryChoices {
  readonly tab: TabId;
  readonly from: number;
  readonly to: number;
  readonly kinds: readonly CellKind[];
  readonly text: string;
  /** The column of Search Changes; none chosen yet when undefined. */
  readonly column?: number | undefined;
}

interface SavedState extends SchemaHistoryChoices {
  readonly connection: string;
  readonly tableId: number;
  /** The oldest and the newest snapshot the comparison could reach: an end there follows the data. */
  readonly bounds: Bounds;
}

const isSavedState = isShape({
  connection: isString,
  tableId: isCount,
  bounds: isBounds,
  tab: isOneOf(...TABS.map(({ id }) => id)),
  from: isCount,
  to: isCount,
  kinds: isArrayOf(isOneOf(...CELL_KINDS)),
  text: isString,
  column: isOptional(isCount),
}) as (value: unknown) => value is SavedState;

/** The whole history: from the oldest snapshot to the newest, every kind of change, no filter. */
export function defaultChoices(data: SchemaHistoryData): SchemaHistoryChoices {
  const points = comparePoints(data);
  return {
    tab: 'compare',
    from: points[0]?.id ?? 0,
    to: points.at(-1)?.id ?? 0,
    kinds: CELL_KINDS,
    text: '',
  };
}

/** What the page keeps for VS Code to hand back. */
export const savedSchemaHistoryState = (
  data: SchemaHistoryData,
  chosen: SchemaHistoryChoices,
): SavedState => ({
  connection: data.connection,
  tableId: data.tableId,
  bounds: boundsOf(comparePoints(data)),
  ...chosen,
});

/**
 * The saved choices of the same table, fitted to the data: an end at the oldest or newest snapshot stays there, an end
 * that is gone goes back to it, and a column that is gone is no longer chosen. The defaults for foreign state.
 */
export function restoreSchemaHistoryChoices(saved: unknown, data: SchemaHistoryData): SchemaHistoryChoices {
  const fresh = defaultChoices(data);
  if (!isSavedState(saved) || saved.connection !== data.connection || saved.tableId !== data.tableId) {
    return fresh;
  }
  const ids = new Set(comparePoints(data).map(({ id }) => id));
  const end = (value: number, was: number, now: number): number =>
    value === was || !ids.has(value) ? now : value;
  return {
    tab: saved.tab,
    from: end(saved.from, saved.bounds.first, fresh.from),
    to: end(saved.to, saved.bounds.last, fresh.to),
    kinds: saved.kinds,
    text: saved.text,
    column: data.columns.some(({ id }) => id === saved.column) ? saved.column : undefined,
  };
}
