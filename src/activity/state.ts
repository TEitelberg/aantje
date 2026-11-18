import { isArrayOf, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { POINT_KINDS } from '../snapshot-changes/model';
import type { Model, PointKind } from '../snapshot-changes/model';
import { boundsOf, isBounds, restoredRange } from '../shell/range-state';
import type { Bounds } from '../shell/range-state';
import { choices } from './model';
import type { ActivityData } from './model';

/** The tabs below the key figures; the first is shown until the user picks another. */
export const TABS = [
  { id: 'days', label: 'Commits per day' },
  { id: 'kinds', label: 'Changes by kind' },
  { id: 'authors', label: 'Authors' },
  { id: 'ranking', label: 'Most changed tables' },
  { id: 'tables', label: 'Table changes' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** The tab and the filters, kept while the panel is hidden or the data is read again. */
export interface ActivityChoices {
  readonly tab: TabId;
  readonly author?: string | undefined;
  readonly table?: string | undefined;
  readonly kinds: readonly PointKind[];
  readonly text: string;
  readonly range: { readonly from: number; readonly to: number };
}

interface SavedState extends ActivityChoices {
  readonly connection: string;
  // The snapshots the range was chosen in.
  readonly bounds: Bounds;
}

const isSavedState = isShape({
  connection: isString,
  bounds: isBounds,
  tab: isOneOf(...TABS.map(({ id }) => id)),
  author: isOptional(isString),
  table: isOptional(isString),
  kinds: isArrayOf(isOneOf(...POINT_KINDS)),
  text: isString,
  range: isShape({ from: isCount, to: isCount }),
}) as (value: unknown) => value is SavedState;

/** What the page keeps for VS Code to hand back. */
export const savedActivityState = (
  data: ActivityData,
  model: Model,
  chosen: ActivityChoices,
): SavedState => ({
  connection: data.connection,
  bounds: boundsOf(model.snapshots),
  ...chosen,
});

/** Restores the saved tab and filters without any author or table the data lacks; undefined for foreign state. */
export function restoreActivityChoices(
  saved: unknown,
  data: ActivityData,
  model: Model,
): ActivityChoices | undefined {
  if (!isSavedState(saved) || saved.connection !== data.connection) {
    return undefined;
  }
  const offered = choices(model);
  return {
    tab: saved.tab,
    author: offered.authors.some(({ key }) => key === saved.author) ? saved.author : undefined,
    table: offered.tables.some(({ key }) => key === saved.table) ? saved.table : undefined,
    kinds: saved.kinds,
    text: saved.text,
    range: restoredRange(saved.range, saved.bounds, boundsOf(model.snapshots)),
  };
}
