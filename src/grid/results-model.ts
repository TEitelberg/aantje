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

export function beginRun(script: string): ResultsRunState {
  return { script: oneLine(script, HEADER_CHARS), statements: [], resultSets: [], end: undefined };
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
      return beginRun(message.script);
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

/** `Result 1 (1,234 rows)`, `Result 1 (10,000 of more rows)`. The statement text is never part of the label. */
export function tabLabel(set: ResultSet, number: number): string {
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

/** Messages while the run goes on or has no result set; else the first result set unless the user chose a tab. */
export function selectedTab(run: ResultsRunState, chosen: TabId | undefined): TabId {
  if (chosen === 'messages' || (chosen !== undefined && run.resultSets[chosen])) {
    return chosen;
  }
  return run.end && run.resultSets.length > 0 ? 0 : 'messages';
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
