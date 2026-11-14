import type { GridColumn, GridValue } from '../data/types';
import { count, formatDuration, groupedPlural } from '../shell/numbers';
import type { SqlEvent } from '../sql/session';
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
  readonly view?: ProfileView;
}

export type ProfileView = 'table' | 'flame' | 'operators' | 'text';

/** The tabs that a profile adds, in their order, with their labels. */
export const PROFILE_VIEWS: readonly (readonly [ProfileView, string])[] = [
  ['table', 'Statistics'],
  ['flame', 'Flame Graph'],
  ['operators', 'Treemap & Top Operators'],
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

export type TabId = 'messages' | number;

const MESSAGE_CHARS = 80;
/** The text above a result grid: the whole statement on one line. */
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
    case 'profile':
      // One tab per view of the profile; the statement's line in Messages keeps its own outcome.
      return {
        ...run,
        resultSets: [
          ...run.resultSets,
          ...PROFILE_VIEWS.map(([view, label]) => ({
            statement: event.index,
            columns: [],
            rows: [],
            truncated: false,
            elapsedMs: 0,
            profile: event.json,
            view,
            label,
          })),
        ],
      };
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

/** `Result 1 (1,234 rows)`, `Result 1 (10,000 of more rows)`, `Execution Plan`, or the label of a text or profile view. Never the statement text. */
function tabLabel(set: ResultSet, number: number): string {
  if (set.view !== undefined) return set.label ?? `Result ${number}`;
  if (isPlan(set)) return 'Execution Plan';
  const rows = set.truncated
    ? `${count(set.rows.length)} of more rows`
    : groupedPlural(set.rows.length, 'row');
  return `Result ${number} (${rows})`;
}

/** The Messages tab first, so that it keeps its place while result sets arrive. */
export function tabsOf(run: ResultsRunState): readonly Tab[] {
  return [
    { id: 'messages', label: 'Messages' },
    ...run.resultSets.map((set, index): Tab => ({ id: index, label: tabLabel(set, index + 1) })),
  ];
}

/**
 * Messages while the run goes on or has no result set; else, unless the user chose a tab, what the run was for: the
 * text that aantje added (the profile of Statistics) before the rows of its statement, otherwise the first result set.
 */
export function selectedTab(run: ResultsRunState, chosen: TabId | undefined): TabId {
  if (chosen === 'messages' || (chosen !== undefined && run.resultSets[chosen])) {
    return chosen;
  }
  if (!run.end || run.resultSets.length === 0) {
    return 'messages';
  }
  const table = run.resultSets.findIndex((set) => set.view === 'table');
  return table >= 0 ? table : 0;
}

export function truncatedBanner(set: ResultSet): string {
  return `Only the first ${count(set.rows.length)} rows were read; sorting and filtering apply to these rows only; Export CSV exports these rows`;
}

/** Where "Go to statement" leads: the position of the error, else the statement. Undefined for a statement that is not known. */
export function revealRange(run: ResultsRunState, index: number): ResultsRange | undefined {
  const statement = run.statements.find((candidate) => candidate.index === index);
  if (!statement) {
    return undefined;
  }
  return statement.error?.position ?? { offset: statement.offset, length: statement.sql.length };
}
