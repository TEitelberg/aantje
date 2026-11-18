import { isDays } from './model';
import type { InactiveData, InactiveTable } from './model';
import type { InactiveAction, TableActionId } from './protocol';

/** What a page request asks for, checked against the data the extension sent. */
export type InactivePlan =
  | { readonly action: 'days'; readonly days: number }
  /** An action on a table of the report, with the snapshot the report was read at. */
  | { readonly action: TableActionId; readonly table: InactiveTable; readonly snapshot: number };

/** The plan of a request: days from 1 to the most, or a table that the page was sent; undefined for anything else. */
export function planInactiveAction(data: InactiveData, message: InactiveAction): InactivePlan | undefined {
  if (message.action === 'days') {
    return isDays(message.days) ? { action: 'days', days: message.days } : undefined;
  }
  const table = data.tables.find((candidate) => candidate.id === message.table);
  return table ? { action: message.action, table, snapshot: data.snapshot } : undefined;
}
