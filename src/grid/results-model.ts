import type { GridColumn, GridValue } from '../data/types';
import { count, formatDuration, groupedPlural } from '../shell/numbers';
import type { SqlEvent } from '../sql/session';
import type { Tip } from '../tips/model';
import { clip } from './model';
import type { ResultsMessage } from './protocol';

// The extension keeps this state with the same reducer, so a reloaded page gets the whole run.

type StatementStatus = 'running' | 'ok' | 'error' | 'not-run';

export interface Statement {
  readonly index: number;
  /** Empty when the statement did not start, e.g. a script that does not parse. */
  readonly sql: string;
  readonly offset: number;
  readonly status: StatementStatus;
  /** `3 rows affected`, `Commands completed successfully`, `12 rows`; empty while running and after an error. */
  readonly summary: string;
  readonly elapsedMs: number | undefined;
  readonly error: { readonly message: string; readonly position?: ResultsRange } | undefined;
  /** A query in which nothing writes: the summary of its columns and Aggregate in DuckDB may run it again. */
  readonly readsOnly?: boolean;
}

export interface ResultsRange {
  readonly offset: number;
  readonly length: number;
}

export interface ResultSet {
  /** The index of the statement that produced it. */
  readonly statement: number;
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridValue[])[];
  readonly truncated: boolean;
  readonly elapsedMs: number;
  /** The name of the tab of a profile view. */
  readonly label?: string;
  /** The profile of Statistics (DuckDB's JSON) and the view of it that this tab shows. */
  readonly profile?: string;
  readonly view?: ProfileView | 'tips';
  /** The performance tips of a profile (view `tips`). */
  readonly tips?: readonly Tip[];
}

export type ProfileView = 'table' | 'flame' | 'text';

/** The label of the Tips tab: how many tips it has. */
export const tipsLabel = (tips: readonly Tip[]): string => `Tips (${count(tips.length)})`;

const tabOf = (statement: number) => ({ statement, columns: [], rows: [], truncated: false, elapsedMs: 0 });

/** The result set of the Tips tab, or none without tips. */
const tipsSets = (statement: number, tips: readonly Tip[] = []): ResultSet[] =>
  tips.length === 0 ? [] : [{ ...tabOf(statement), view: 'tips', label: tipsLabel(tips), tips }];

/** The tabs that a profile adds, in their order, with their labels. */
export const PROFILE_VIEWS: readonly (readonly [ProfileView, string])[] = [
  ['table', 'Statistics'],
  ['flame', 'Flame Graph'],
  ['text', 'Text Statistics'],
];

/** Whether the result is a plan of EXPLAIN or EXPLAIN ANALYZE: DuckDB returns it as key and value columns. */
export function isPlan(set: ResultSet): boolean {
  return set.columns.map(({ name }) => name).join() === 'explain_key,explain_value';
}

/** The plan as DuckDB draws it; with more than one plan (`explain_output`), each under its key. */
export function planText(set: ResultSet): string {
  const plans = set.rows.map(([key, value]) => ({ key: String(key ?? ''), value: String(value ?? '') }));
  return plans.length === 1
    ? (plans[0]?.value ?? '')
    : plans.map(({ key, value }) => `${key}\n${value}`).join('\n');
}

export interface ResultsRunSummary {
  readonly cancelled: boolean;
  readonly failed: boolean;
  readonly elapsedMs: number;
  readonly inTransaction: 'none' | 'open' | 'aborted';
}

export interface ResultsRunState {
  /** The script on one line, shortened: the text of a statement that never started. */
  readonly script: string;
  readonly statements: readonly Statement[];
  readonly resultSets: readonly ResultSet[];
  /** Undefined while the run is going on. */
  readonly end: ResultsRunSummary | undefined;
  /** aantje built the statement (a CTE on its own): it is not in the document, but can be opened as a new query. */
  readonly built?: boolean;
}

/** The tab of the chart of a result set, right after the tab of its rows. */
export type ChartTabId = `chart-${number}`;

/** Messages, a result set by its place, or the chart of a result set. */
export type TabId = 'messages' | number | ChartTabId;

export const chartTab = (set: number): ChartTabId => `chart-${set}`;

/** The result set whose chart a tab shows; undefined for any other tab. */
export function chartSetOf(id: TabId | undefined): number | undefined {
  if (typeof id !== 'string' || !id.startsWith('chart-')) return undefined;
  const set = Number(id.slice('chart-'.length));
  return Number.isInteger(set) && set >= 0 ? set : undefined;
}

const MESSAGE_CHARS = 80;
/** The script on one line, the text of a statement that never started. */
export const HEADER_CHARS = 200;
/** The tooltip of the statement text. */
export const TITLE_CHARS = 1000;

/** The first line that has text, shortened. */
export function statementPreview(text: string, max: number): string {
  return clip(
    text
      .split(/\r\n|\r|\n/)
      .find((line) => line.trim() !== '')
      ?.trim() ?? '',
    max,
  );
}

/** All the text on one line, shortened. */
export function oneLine(text: string, max: number): string {
  return clip(text.replace(/\s+/g, ' ').trim(), max);
}

export function beginRun(script: string, built = false): ResultsRunState {
  return {
    script: oneLine(script, HEADER_CHARS),
    statements: [],
    resultSets: [],
    end: undefined,
    ...(built ? { built: true } : {}),
  };
}

function update(run: ResultsRunState, index: number, change: Partial<Statement>): ResultsRunState {
  const known = run.statements.some((statement) => statement.index === index);
  const base: Statement = {
    index,
    sql: '',
    offset: 0,
    status: 'running',
    summary: '',
    elapsedMs: undefined,
    error: undefined,
  };
  return {
    ...run,
    statements: known
      ? run.statements.map((statement) =>
          statement.index === index ? { ...statement, ...change } : statement,
        )
      : [...run.statements, { ...base, ...change }],
  };
}

function messageSummary(event: Extract<SqlEvent, { kind: 'message' }>): string {
  return event.rowsAffected === undefined
    ? event.text.replace(/\.$/, '')
    : `${groupedPlural(event.rowsAffected, 'row')} affected`;
}

export function applyEvent(run: ResultsRunState, event: SqlEvent): ResultsRunState {
  switch (event.kind) {
    case 'start':
      return update(run, event.index, {
        sql: event.sql,
        offset: event.offset,
        status: 'running',
        summary: '',
        elapsedMs: undefined,
        error: undefined,
        ...(event.readsOnly ? { readsOnly: true } : {}),
      });
    case 'resultSet':
      return {
        ...update(run, event.index, {
          status: 'ok',
          summary: `${groupedPlural(event.rows.length, 'row')}${event.truncated ? ' (more rows exist)' : ''}`,
          elapsedMs: event.elapsedMs,
        }),
        resultSets: [
          ...run.resultSets,
          {
            statement: event.index,
            columns: event.columns,
            rows: event.rows,
            truncated: event.truncated,
            elapsedMs: event.elapsedMs,
          },
        ],
      };
    case 'message':
      return update(run, event.index, {
        status: 'ok',
        summary: messageSummary(event),
        elapsedMs: event.elapsedMs,
      });
    case 'error':
      return update(run, event.index, {
        status: 'error',
        summary: '',
        error: { message: event.message, ...(event.position ? { position: event.position } : {}) },
      });
    case 'profile': {
      // One tab per view of the profile, the tips right after the table; the statement's line in Messages keeps its
      // own outcome. All at once: the page keeps its tabs by their place, so result sets are only ever appended.
      const [table, ...rest] = PROFILE_VIEWS.map(([view, label]): ResultSet => ({
        ...tabOf(event.index),
        profile: event.json,
        view,
        label,
      }));
      return {
        ...run,
        resultSets: [
          ...run.resultSets,
          ...(table ? [table] : []),
          ...tipsSets(event.index, event.tips),
          ...rest,
        ],
      };
    }
    case 'tips':
      // Analysis: its plan is the last result set, so the tips follow it.
      return { ...run, resultSets: [...run.resultSets, ...tipsSets(event.index, event.tips)] };
  }
}

/** A statement that started and never reported an outcome (the run was abandoned) did not run to its end. */
export function endRun(run: ResultsRunState, end: ResultsRunSummary): ResultsRunState {
  return {
    ...run,
    statements: run.statements.map((statement) =>
      statement.status === 'running' ? { ...statement, status: 'not-run' } : statement,
    ),
    end,
  };
}

/** The run after a message of the extension. The page and the tests use this one function. */
export function applyMessage(
  run: ResultsRunState | undefined,
  message: ResultsMessage,
): ResultsRunState | undefined {
  switch (message.type) {
    case 'results-begin':
      return beginRun(message.script, message.built === true);
    case 'results-state':
      return message.state;
    case 'results-event':
      return run && applyEvent(run, message.event);
    case 'results-end':
      return run && endRun(run, message.summary);
  }
}

export const STATUS_MARKS: Readonly<
  Record<StatementStatus, { readonly mark: string; readonly label: string }>
> = {
  ok: { mark: '✓', label: 'OK' },
  error: { mark: '✗', label: 'Error' },
  running: { mark: '…', label: 'Running' },
  'not-run': { mark: '–', label: 'Not run' },
};

/** The text of a statement for its line in the Messages tab. */
export function statementText(run: ResultsRunState, statement: Statement): string {
  return statement.sql === '' ? run.script : statementPreview(statement.sql, MESSAGE_CHARS);
}

export const elapsedText = formatDuration;

/** `Completed in 12 ms`, `Cancelled after 1.2 s`, `Failed after 3.4 s`; `Running...` until the end. */
export function endText(end: ResultsRunSummary | undefined): string {
  if (!end) {
    return 'Running...';
  }
  const elapsed = elapsedText(end.elapsedMs);
  return end.cancelled
    ? `Cancelled after ${elapsed}`
    : end.failed
      ? `Failed after ${elapsed}`
      : `Completed in ${elapsed}`;
}

/** Empty when no transaction is open. */
export function transactionText(end: ResultsRunSummary | undefined): string {
  return end?.inTransaction === 'open'
    ? 'Transaction open'
    : end?.inTransaction === 'aborted'
      ? 'Transaction aborted: run ROLLBACK'
      : '';
}

interface Tab {
  readonly id: TabId;
  readonly label: string;
}

/** A result set of rows: no plan, no profile, no tips. */
const isRows = (set: ResultSet): boolean => set.view === undefined && !isPlan(set);

/** `Result`, or `Result 2` when the run has several result sets of rows; `Execution Plan`, or the label of a view. */
function tabLabel(set: ResultSet, number: number | undefined): string {
  if (set.view !== undefined) return set.label ?? 'Result';
  if (isPlan(set)) return 'Execution Plan';
  return number === undefined ? 'Result' : `Result ${number}`;
}

/** Rows that are no plan: they have a chart, in a tab of its own right after theirs. A profile, the tips, none. */
export function hasChart(set: ResultSet | undefined): boolean {
  return set !== undefined && isRows(set) && set.rows.length > 0;
}

/**
 * The Messages tab first, so that it keeps its place while result sets arrive; each result set of rows is followed by
 * the tab of its chart: `Result` and `Chart`, numbered (`Result 2`, `Chart 2`) only when the run has several result
 * sets of rows. The row count is in the status line of the grid, not in the tab.
 */
export function tabsOf(run: ResultsRunState): readonly Tab[] {
  const numbered = run.resultSets.filter(isRows).length > 1;
  let position = 0;
  return [
    { id: 'messages', label: 'Messages' },
    ...run.resultSets.flatMap((set, index): Tab[] => {
      const number = numbered && isRows(set) ? ++position : undefined;
      const suffix = number === undefined ? '' : ` ${number}`;
      return [
        { id: index, label: tabLabel(set, number) },
        ...(hasChart(set) ? [{ id: chartTab(index), label: `Chart${suffix}` }] : []),
      ];
    }),
  ];
}

/** Whether the tab exists in the run. */
function exists(run: ResultsRunState, id: TabId): boolean {
  if (id === 'messages') return true;
  if (typeof id === 'number') return run.resultSets[id] !== undefined;
  const set = chartSetOf(id);
  return set !== undefined && hasChart(run.resultSets[set]);
}

/**
 * Messages while the run goes on or has no result set; else, unless the user chose a tab, what the run was for: the
 * text that aantje added (the profile of Statistics) before the rows of its statement, otherwise the first result set,
 * or its chart when `chart` (the chart was the tab chosen last).
 */
export function selectedTab(run: ResultsRunState, chosen: TabId | undefined, chart = false): TabId {
  if (chosen !== undefined && exists(run, chosen)) {
    return chosen;
  }
  if (!run.end || run.resultSets.length === 0) {
    return 'messages';
  }
  const table = run.resultSets.findIndex((set) => set.view === 'table');
  const first = table >= 0 ? table : 0;
  return chart && hasChart(run.resultSets[first]) ? chartTab(first) : first;
}

/** Where "Go to statement" leads: the position of the error, else the statement. Undefined for a statement that is not known. */
export function revealRange(run: ResultsRunState, index: number): ResultsRange | undefined {
  const statement = run.statements.find((candidate) => candidate.index === index);
  if (!statement) {
    return undefined;
  }
  return statement.error?.position ?? { offset: statement.offset, length: statement.sql.length };
}
