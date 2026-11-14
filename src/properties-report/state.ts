import { isShape, isString } from '../guards';
import type { PropertiesData } from './model';

interface Saved {
  readonly connection: string;
  readonly filter: string;
}

const isSaved = isShape({ connection: isString, filter: isString }) as (value: unknown) => value is Saved;

/** What the page keeps for VS Code to hand back: the filter of the metadata. */
export const savedState = (data: PropertiesData, filter: string): Saved => ({
  connection: data.connection,
  filter,
});

/** The saved filter of the same connection; empty for foreign state or another connection. */
export function restoredFilter(saved: unknown, data: PropertiesData): string {
  return isSaved(saved) && saved.connection === data.connection ? saved.filter : '';
}
