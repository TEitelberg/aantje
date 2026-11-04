import { formatUtc } from '../snapshot';

// Shared by every report's pure part: severities, key figures and number formats.
export { formatBytes } from '../tree/format';
export { count, files, groupedPlural, plural } from './numbers';
export { formatUtc };

/** A time as `formatUtc` writes it, without ` UTC`, for tables whose header names the zone. */
export const withoutUtc = (text: string): string => text.replace(/ UTC$/, '');

/** `formatUtc` without ` UTC`, for tables whose header names the zone. */
export const shortUtc = (iso: string): string => withoutUtc(formatUtc(iso));

/** `shortUtc` to the minute, for a narrow column. */
export const shortUtcMinutes = (iso: string): string => shortUtc(iso).slice(0, 16);

/** Rows of a list on a report page and in its Markdown; the filter reaches the others. */
export const LIST_ROWS = 200;

/** `schema.name`, or the bare name for a table without a schema. */
export const tableLabel = (table: { readonly schema: string | null; readonly name: string }): string =>
  table.schema === null ? table.name : `${table.schema}.${table.name}`;

export type Severity = 'ok' | 'warning' | 'error';

export interface Card {
  readonly label: string;
  readonly value: string;
  readonly detail?: string;
  readonly severity: Severity;
  readonly hint?: string;
}
