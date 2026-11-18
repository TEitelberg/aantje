import { CHANGE_COLUMNS } from '../data/types';
import {
  isArrayOf,
  isBoolean,
  isCount,
  isFiniteNumber,
  isNullOr,
  isObject,
  isOneOf,
  isOptional,
  isShape,
  isString,
  own,
} from '../guards';
import type { Test } from '../guards';
import type { GridColumn, GridData, GridValue, RowKind } from '../data/types';
import type { MarkdownNull } from '../export/markdown';
import type { SqlEvent } from '../sql/session';
import { TIP_KINDS } from '../tips/model';
import type { SummaryState } from './column-summary';
import { AGGREGATES, CHART_TYPES } from './result-chart';
import type { ChartChoice } from './result-chart';
import { PROFILE_VIEWS } from './results-model';
import type { ResultsRunState, ResultsRunSummary } from './results-model';

/**
 * What was copied: a cell, a row, all rows of a grid, the rows as Markdown, the statistics of the columns as Markdown,
 * or the whole text of a profile or plan.
 */
export type CopyScope = 'cell' | 'row' | 'all' | 'markdown' | 'statistics' | 'text';

/** What a command of the context menu of a grid copies; the page knows the selected cell, the sort and the filters. */
export type MenuCopy = Exclude<CopyScope, 'text'>;

export const MENU_COPIES: readonly MenuCopy[] = ['cell', 'row', 'all', 'markdown', 'statistics'];

/** What the page saves: the rows as CSV, JSON or Markdown, or a chart as PNG (its bytes in base64). */
export type SaveFormat = 'csv' | 'json' | 'markdown' | 'png';

export const SAVE_FORMATS: readonly SaveFormat[] = ['csv', 'json', 'markdown', 'png'];

/** The formats of Export as File, which saves the rows shown. */
export type RowsFormat = Exclude<SaveFormat, 'png'>;

export const ROWS_FORMATS: readonly RowsFormat[] = ['csv', 'json', 'markdown'];

export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'copy'; readonly text: string; readonly what: CopyScope }
  | {
      readonly type: 'export';
      readonly format: SaveFormat;
      readonly text: string;
      readonly suggestedName: string;
    }
  /** Results page only: "Go to statement", the index is the one of the events. */
  | { readonly type: 'reveal'; readonly index: number }
  /** Results page only: "Open as New Query" of a statement that aantje built. */
  | { readonly type: 'openQuery' }
  /** Results page only: "Open script" of a tip; the indexes name the result set and the tip, never the script. */
  | { readonly type: 'openTipScript'; readonly set: number; readonly tip: number }
  /** Results page only: the chart that was chosen, which the extension keeps for the editor. */
  | { readonly type: 'chart'; readonly memory: ChartMemory }
  /** Results page only: Aggregate in DuckDB of a result set, by the choice of its chart. */
  | { readonly type: 'aggregate'; readonly set: number; readonly choice: ChartChoice }
  /** Stops what the page asked DuckDB to compute (Aggregate in DuckDB, the statistics of the columns). */
  | { readonly type: 'cancelCompute' }
  /** The statistics of the columns: of a result set of the results page (`set`), or of the table of a preview. */
  | { readonly type: 'summarize'; readonly set?: number }
  /** The statistics of the columns were shown or hidden; the extension remembers it for the next grid. */
  | { readonly type: 'statistics'; readonly shown: boolean }
  /** Export as File of a grid (`set`, as for `summarize`): the extension asks for the format, the page sends the rows. */
  | { readonly type: 'chooseExport'; readonly set?: number };

/** The chart of a result that the extension keeps for an editor: the choice, and whether its tab was chosen last. */
export interface ChartMemory {
  readonly choice: ChartChoice;
  readonly open: boolean;
}

/** Where Aggregate in DuckDB stands: running, its rows, or why it failed. */
export type AggregateState =
  | { readonly status: 'running' }
  | {
      readonly status: 'done';
      readonly columns: readonly GridColumn[];
      readonly rows: readonly (readonly GridValue[])[];
      readonly truncated: boolean;
    }
  | { readonly status: 'failed'; readonly message: string };

/** What the extension computed for a result set of the run that the page shows; the run itself stays as it is. */
export type ResultsUpdate =
  | {
      readonly type: 'results-aggregate';
      readonly set: number;
      readonly choice: ChartChoice;
      readonly state: AggregateState;
    }
  | { readonly type: 'results-summary'; readonly set: number; readonly state: SummaryState };

/** A new run, each event of it, its end, and the whole run again for a page that loads later. */
export type ResultsMessage =
  | { readonly type: 'results-begin'; readonly script: string; readonly built?: boolean }
  | { readonly type: 'results-event'; readonly event: SqlEvent }
  | { readonly type: 'results-end'; readonly summary: ResultsRunSummary }
  | { readonly type: 'results-state'; readonly state: ResultsRunState };

/** What the page needs besides the rows, from the settings of VS Code; sent on `ready`, before the rows. */
export interface PageSettings {
  /** How a NULL shows in Copy as Markdown and in the Markdown export. */
  readonly markdownNull: MarkdownNull;
  /** Results page only: the chart that was chosen last for the editor. */
  readonly chart?: ChartMemory;
  /** The statistics of the columns are shown in the header of a grid. */
  readonly statistics?: boolean;
  /** The id of the panel, which the page names in the context of its context menu, so that a command reaches it. */
  readonly panel?: string;
}

/**
 * What the extension asks of a grid (`set`: a result set of the results page, else the grid of a preview): a copy that
 * its context menu chose, or the rows shown in the format that Export as File chose.
 */
export type GridRequest =
  | { readonly type: 'menuCopy'; readonly what: MenuCopy; readonly set?: number }
  | { readonly type: 'exportAs'; readonly format: RowsFormat; readonly set?: number };

export type ExtensionMessage =
  /** `summary`: the grid has statistics of the columns, which the extension computes. */
  | { readonly type: 'data'; readonly data: GridData; readonly summary?: true }
  | { readonly type: 'settings'; readonly settings: PageSettings }
  /** The statistics of the columns of the table of a preview. */
  | { readonly type: 'summary'; readonly state: SummaryState }
  | GridRequest
  | ResultsMessage
  | ResultsUpdate;

const COPY_SCOPES: readonly unknown[] = [...MENU_COPIES, 'text'] satisfies CopyScope[];

/** The bytes of a picture in base64: nothing else may come out of the page for a PNG file. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

// Column names are text of the catalog or of the query: bounded, so that a page cannot send megabytes of them.
const NAME_CHARS = 4096;
const isName: Test = (value) => typeof value === 'string' && value.length <= NAME_CHARS;

/** A chart choice as a page sends it and as the extension sends it back. */
export const isChartChoice = isShape({
  type: isOneOf(...CHART_TYPES.map(([type]) => type)),
  x: isNullOr(isName),
  y: (value: unknown) => Array.isArray(value) && value.length <= 1000 && value.every(isName),
  series: isNullOr(isName),
  size: isNullOr(isName),
  aggregate: isOneOf(...AGGREGATES),
}) as (value: unknown) => value is ChartChoice;

const isChartMemory = isShape({ choice: isChartChoice, open: isBoolean });

/** The settings that the page reads, or undefined for a message that is not such. */
export const isPageSettings = isShape({
  markdownNull: isOneOf('empty', 'null'),
  chart: isOptional(isChartMemory),
  statistics: isOptional(isBoolean),
  panel: isOptional(isName),
}) as (value: unknown) => value is PageSettings;

/** A request of the extension to a grid, as the page checks it. */
export const isGridRequest = (value: unknown): value is GridRequest => {
  if (!isObject(value) || !isOptional(isCount)(own(value, 'set'))) return false;
  switch (own(value, 'type')) {
    case 'menuCopy':
      return MENU_COPIES.includes(own(value, 'what') as MenuCopy);
    case 'exportAs':
      return ROWS_FORMATS.includes(own(value, 'format') as RowsFormat);
    default:
      return false;
  }
};

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
  const text = own(value, 'text');
  const name = type === 'copy' ? '' : own(value, 'suggestedName');
  return (
    (type === 'copy' || type === 'export') &&
    typeof text === 'string' &&
    typeof name === 'string' &&
    (text.length > MAX_TRANSFER_CHARS || name.length > MAX_FILE_NAME_CHARS)
  );
}

const always = (): boolean => true;
const ofSet = (value: Record<string, unknown>): boolean => isOptional(isCount)(own(value, 'set'));

/** The messages that a page sends, by their type, each with what the rest of it must be. */
const PAGE_MESSAGES: Readonly<Record<WebviewMessage['type'], (value: Record<string, unknown>) => boolean>> = {
  ready: always,
  copy: (value) =>
    withinLimit(own(value, 'text'), MAX_TRANSFER_CHARS) && COPY_SCOPES.includes(own(value, 'what')),
  export: (value) => {
    const text = own(value, 'text');
    const format = own(value, 'format');
    return (
      SAVE_FORMATS.includes(format as SaveFormat) &&
      withinLimit(text, MAX_TRANSFER_CHARS) &&
      (format !== 'png' || BASE64.test(text as string)) &&
      withinLimit(own(value, 'suggestedName'), MAX_FILE_NAME_CHARS)
    );
  },
  reveal: (value) => isCount(own(value, 'index')),
  openQuery: always,
  openTipScript: (value) => isCount(own(value, 'set')) && isCount(own(value, 'tip')),
  chart: (value) => isChartMemory(own(value, 'memory')),
  aggregate: (value) => isCount(own(value, 'set')) && isChartChoice(own(value, 'choice')),
  cancelCompute: always,
  summarize: ofSet,
  chooseExport: ofSet,
  statistics: (value) => isBoolean(own(value, 'shown')),
};

/** The extension host must not trust what comes out of a webview. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!isObject(value)) {
    return false;
  }
  const type = own(value, 'type');
  return typeof type === 'string' && Object.hasOwn(PAGE_MESSAGES, type)
    ? PAGE_MESSAGES[type as WebviewMessage['type']](value)
    : false;
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

const isTip = isShape({
  kind: isOneOf(...TIP_KINDS),
  title: isString,
  facts: isArrayOf(isString),
  advice: isString,
  script: isOptional(isString),
});

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
      return isShape({ json: isString, tips: isOptional(isArrayOf(isTip)) })(event);
    case 'tips':
      return isShape({ tips: isArrayOf(isTip) })(event);
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
    view: isOptional(isOneOf(...PROFILE_VIEWS.map(([view]) => view), 'tips')),
    tips: isOptional(isArrayOf(isTip)),
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
    rowMode: isOptional(isOneOf('compare')),
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

const isAggregateState: Test = (value) => {
  switch (isObject(value) ? own(value, 'status') : undefined) {
    case 'running':
      return true;
    case 'done':
      return hasRows(value) && isShape({ truncated: isBoolean })(value);
    case 'failed':
      return isShape({ message: isString })(value);
    default:
      return false;
  }
};

const isBin = isShape({ upper: isString, count: isFiniteNumber });
const isPair = (value: unknown): boolean =>
  Array.isArray(value) && value.length === 2 && value.every((item) => isFiniteNumber(item));

const isColumnStats = isShape({
  name: isString,
  type: isString,
  role: isOneOf('number', 'time', 'text', 'boolean', 'other'),
  nulls: isFiniteNumber,
  min: isOptional(isString),
  max: isOptional(isString),
  avg: isOptional(isString),
  distinct: isOptional(isFiniteNumber),
  estimated: isOptional(isBoolean),
  histogram: isOptional(isArrayOf(isBin)),
  truth: isOptional(isPair),
});

const isCover: Test = (value) => {
  switch (isObject(value) ? own(value, 'kind') : undefined) {
    case 'result':
      return isShape({ rows: isCount, sample: isOptional(isCount) })(value);
    case 'table':
      return isShape({ rows: isCount, snapshot: isOptional(isCount), sample: isOptional(isCount) })(value);
    case 'loaded':
      return isShape({ rows: isCount, reason: isOneOf('writes', 'cancelled') })(value);
    default:
      return false;
  }
};

/** A summary of the columns as the extension sends it. */
export const isSummaryState = (value: unknown): value is SummaryState => {
  switch (isObject(value) ? own(value, 'status') : undefined) {
    case 'running':
      return true;
    case 'done':
      return isShape({ summary: isShape({ cover: isCover, columns: isArrayOf(isColumnStats) }) })(value);
    case 'failed':
      return isShape({ message: isString })(value);
    default:
      return false;
  }
};

/** The page checks what the extension computed for it as it checks the run. */
export function isResultsUpdate(value: unknown): value is ResultsUpdate {
  if (!isObject(value) || !isCount(own(value, 'set'))) return false;
  switch (own(value, 'type')) {
    case 'results-aggregate':
      return isChartChoice(own(value, 'choice')) && isAggregateState(own(value, 'state'));
    case 'results-summary':
      return isSummaryState(own(value, 'state'));
    default:
      return false;
  }
}
