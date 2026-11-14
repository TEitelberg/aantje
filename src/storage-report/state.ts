import { isBoolean, isCount, isOneOf, isOptional, isShape, isString } from '../guards';
import { DEFAULT_SORT, SORT_KEYS } from './model';
import type { Sort, StorageData } from './model';

export const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'tables', label: 'Tables' },
  { id: 'growth', label: 'Growth' },
] as const;
export type TabId = (typeof TABS)[number]['id'];

/** The choices the page keeps across a hidden panel or a refresh. */
export interface StorageChoices {
  readonly tab: TabId;
  readonly filter: string;
  readonly sort: Sort;
  readonly selected?: number | undefined;
}

interface Saved extends StorageChoices {
  readonly connection: string;
}

const isSaved = isShape({
  connection: isString,
  tab: isOneOf(...TABS.map(({ id }) => id)),
  filter: isString,
  sort: isShape({ key: isOneOf(...SORT_KEYS), descending: isBoolean }),
  selected: isOptional(isCount),
}) as (value: unknown) => value is Saved;

/** What the page keeps for VS Code to hand back. */
export const savedState = (data: StorageData, choices: StorageChoices): Saved => ({
  connection: data.connection,
  ...choices,
});

/** The saved choices of the same connection; the defaults for foreign state or another connection. */
export function restoredChoices(saved: unknown, data: StorageData): StorageChoices {
  return isSaved(saved) && saved.connection === data.connection
    ? saved
    : { tab: 'overview', filter: '', sort: DEFAULT_SORT, selected: undefined };
}
