import { CHANGE_COLUMNS } from '../data/types';
import {
  isArrayOf,
  isBoolean,
  isCount,
  isFiniteNumber,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import type { Test } from '../guards';
import type { GridData, RowKind } from '../data/types';
import type { SqlEvent } from '../sql/session';
import { PROFILE_VIEWS } from './results-model';
import type { ResultsRunState, ResultsRunSummary } from './results-model';

/** What was copied: a cell, a row, all rows of a grid, or the whole text of a profile or plan. */
export type CopyScope = 'cell' | 'row' | 'all' | 'text';

export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'copy'; readonly text: string; readonly what: CopyScope }
  | { readonly type: 'export'; readonly csv: string; readonly suggestedName: string }
  /** Results page only: "Go to statement", the index is the one of the events. */
  | { readonly type: 'reveal'; readonly index: number }
  /** Results page only: "Open as New Query" of a statement that aantje built. */
  | { readonly type: 'openQuery' };

/** A new run, each event of it, its end, and the whole run again for a page that loads later. */
export type ResultsMessage =
  | { readonly type: 'results-begin'; readonly script: string; readonly built?: boolean }
  | { readonly type: 'results-event'; readonly event: SqlEvent }
  | { readonly type: 'results-end'; readonly summary: ResultsRunSummary }
  | { readonly type: 'results-state'; readonly state: ResultsRunState };

export type ExtensionMessage = { readonly type: 'data'; readonly data: GridData } | ResultsMessage;

const COPY_SCOPES: readonly unknown[] = ['cell', 'row', 'all', 'text'] satisfies CopyScope[];

const ROW_KINDS: readonly unknown[] = [
  'insert',
  'delete',
  'update-before',
  'update-after',
] satisfies RowKind[];

/** The row kinds of a change grid; undefined for an ordinary grid or when the kinds do not fit the rows. */
export function rowKindsOf(data: GridData): readonly RowKind[] | undefined {
  const { rowKinds, rows, columns } = data;
  if (!Array.isArray(rowKinds) || rowKinds.length !== rows.length || columns.length < CHANGE_COLUMNS) {
    return undefined;
  }
  const paired = rowKinds.every(
    (kind, index) =>
      ROW_KINDS.includes(kind) &&
      (kind !== 'update-before' || rowKinds[index + 1] === 'update-after') &&
      (kind !== 'update-after' || rowKinds[index - 1] === 'update-before'),
  );
  return paired ? rowKinds : undefined;
}

/**
 * Longest text, in characters, that the page may ask the host to copy or save (128 MiB): more than any honest result
 * reaches at the largest `aantje.sql.maxRows`. A page that sends more is refused.
 */
export const MAX_TRANSFER_CHARS = 128 * 1024 * 1024;

/** Longest suggested file name, in characters. */
export const MAX_FILE_NAME_CHARS = 256;

const withinLimit = (value: unknown, limit: number): boolean =>
  typeof value === 'string' && value.length <= limit;

/** Whether `value` is a copy or export message that only its size disqualifies. */
export function isOversizedTransfer(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  const type = own(value, 'type');
  const text = own(value, type === 'copy' ? 'text' : 'csv');
  const name = type === 'copy' ? '' : own(value, 'suggestedName');
  return (
    (type === 'copy' || type === 'export') &&
    typeof text === 'string' &&
    typeof name === 'string' &&
    (text.length > MAX_TRANSFER_CHARS || name.length > MAX_FILE_NAME_CHARS)
  );
}

/** The extension host must not trust what comes out of a webview. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!isObject(value)) {
    return false;
  }
  switch (own(value, 'type')) {
    case 'ready':
      return true;
    case 'copy':
      return withinLimit(own(value, 'text'), MAX_TRANSFER_CHARS) && COPY_SCOPES.includes(own(value, 'what'));
    case 'export':
      return (
        withinLimit(own(value, 'csv'), MAX_TRANSFER_CHARS) &&
        withinLimit(own(value, 'suggestedName'), MAX_FILE_NAME_CHARS)
      );
    case 'reveal':
      return isCount(own(value, 'index'));
    case 'openQuery':
      return true;
    default:
      return false;
  }
}

const isColumn = isShape({
  name: isString,
  type: isString,
  kind: isOneOf('number', 'boolean', 'text', 'nested'),
});

const isGridValue: Test = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

const hasRows = isShape({ columns: isArrayOf(isColumn), rows: isArrayOf(isArrayOf(isGridValue)) });

const isRange = isShape({ offset: isCount, length: isCount });

const isError = isShape({ message: isString, position: isOptional(isRange) });

const isSqlEvent = (value: unknown): value is SqlEvent => {
  if (!isShape({ index: isCount })(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  switch (own(event, 'kind')) {
    case 'start':
      return isShape({ statementType: isString, sql: isString, offset: isCount })(event);
    case 'resultSet':
      return hasRows(event) && isShape({ truncated: isBoolean, elapsedMs: isFiniteNumber })(event);
    case 'message':
      return isShape({ text: isString, rowsAffected: isOptional(isFiniteNumber), elapsedMs: isFiniteNumber })(
        event,
      );
    case 'error':
      return isError(event);
    case 'profile':
      return isShape({ json: isString })(event);
    default:
      return false;
  }
};

const isRunSummary = isShape({
  cancelled: isBoolean,
  failed: isBoolean,
  elapsedMs: isFiniteNumber,
  inTransaction: isOneOf('none', 'open', 'aborted'),
}) as (value: unknown) => value is ResultsRunSummary;

const isStatement = isShape({
  index: isCount,
  sql: isString,
  offset: isCount,
  status: isOneOf('running', 'ok', 'error', 'not-run'),
  summary: isString,
  elapsedMs: isOptional(isFiniteNumber),
  error: isOptional(isError),
});

const isResultSet: Test = (value) =>
  isShape({
    statement: isCount,
    truncated: isBoolean,
    elapsedMs: isFiniteNumber,
    text: isOptional(isString),
    label: isOptional(isString),
    profile: isOptional(isString),
    view: isOptional(isOneOf(...PROFILE_VIEWS.map(([view]) => view))),
  })(value) && hasRows(value);

const isRunState = isShape({
  script: isString,
  statements: isArrayOf(isStatement),
  resultSets: isArrayOf(isResultSet),
  end: isOptional(isRunSummary),
  built: isOptional(isBoolean),
});

/** Checks the rows of a message: a broken message must not throw in the page. */
export const isGridData = (value: unknown): value is GridData =>
  isShape({
    table: isShape({ schema: isString, table: isString }),
    limit: isCount,
    truncated: isBoolean,
    elapsedMs: isFiniteNumber,
    rowKinds: isOptional(isArrayOf(isString)),
    summary: isOptional(isString),
  })(value) && hasRows(value);

/** The results page checks what it is sent as the extension checks what comes out of the webview. */
export function isResultsMessage(value: unknown): value is ResultsMessage {
  if (!isObject(value)) {
    return false;
  }
  switch (own(value, 'type')) {
    case 'results-begin':
      return isShape({ script: isString, built: isOptional(isBoolean) })(value);
    case 'results-event':
      return isSqlEvent(own(value, 'event'));
    case 'results-end':
      return isRunSummary(own(value, 'summary'));
    case 'results-state':
      return isRunState(own(value, 'state'));
    default:
      return false;
  }
}
