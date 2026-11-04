import { beforeAll, describe, expect, it } from 'vitest';
import { clip } from '../../src/grid/model';
import type { ResultsMessage } from '../../src/grid/protocol';
import type { SqlEvent } from '../../src/sql/session';
import {
  applyMessage,
  beginRun,
  endRun,
  endText,
  statementPreview,
  oneLine,
  revealRange,
  selectedTab,
  STATUS_MARKS,
  statementText,
  tabsOf,
  transactionText,
  applyEvent,
} from '../../src/grid/results-model';
import type { ResultsRunState, ResultsRunSummary } from '../../src/grid/results-model';
import { engineSkipReason } from './data-support';
import { HOSTILE_SQL, MAX_ROWS, realRun, SCRIPT } from './results-support';
import type { RealRun } from './results-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The results model tests with a real session are skipped: ${skipReason}`);
}

const DONE: ResultsRunSummary = { cancelled: false, failed: false, elapsedMs: 1234.4, inTransaction: 'none' };

function fold(run: RealRun, count = run.events.length): ResultsRunState {
  return run.events.slice(0, count).reduce(applyEvent, beginRun(run.script));
}

describe('the text of a statement', () => {
  it('shows the first line that has text, shortened with an ellipsis, on one line, without cutting a surrogate pair', () => {
    expect(statementPreview('\n  \n  SELECT a,\n  b FROM t', 80)).toBe('SELECT a,');
    expect(statementPreview('SELECT 1\rFROM t', 80)).toBe('SELECT 1');
    expect(statementPreview('x'.repeat(80), 80)).toBe('x'.repeat(80));
    expect(statementPreview('x'.repeat(81), 80)).toBe(`${'x'.repeat(80)}…`);
    expect(statementPreview('   ', 80)).toBe('');
    expect(oneLine('SELECT a,\n\t b\r\n FROM t', 200)).toBe('SELECT a, b FROM t');
    expect(oneLine(`SELECT ${'y'.repeat(300)}`, 200)).toHaveLength(201);
    expect(clip(`${'a'.repeat(79)}😀 tail`, 80)).toBe(`${'a'.repeat(79)}…`);
    expect(clip('😀', 2)).toBe('😀');
  });
});

describe.skipIf(skipReason)('the state of a real run', () => {
  let real: RealRun;
  beforeAll(async () => {
    real = await realRun();
  });

  it('has one line per statement with its status and result summary, the error with its position, and the result sets in order', () => {
    const run = fold(real);

    expect(
      run.statements.map(({ index, status, summary, sql }) => ({ index, status, summary, sql })),
    ).toEqual([
      {
        index: 0,
        status: 'ok',
        summary: 'Commands completed successfully',
        sql: 'CREATE TABLE made (a INTEGER)',
      },
      { index: 1, status: 'ok', summary: '2 rows affected', sql: 'INSERT INTO made VALUES (1),(2)' },
      { index: 2, status: 'ok', summary: '3 rows', sql: 'SELECT * FROM t ORDER BY id' },
      { index: 3, status: 'ok', summary: '1 row', sql: HOSTILE_SQL },
      {
        index: 4,
        status: 'ok',
        summary: `${MAX_ROWS} rows (more rows exist)`,
        sql: 'SELECT i FROM range(25) r(i)',
      },
      { index: 5, status: 'error', summary: '', sql: 'SELECT * FROM nope' },
    ]);
    expect(run.statements[5]?.elapsedMs).toBeUndefined();

    const failed = run.statements[5];
    expect(failed?.error?.message).toContain('nope');
    expect(failed?.error?.position).toEqual({ offset: SCRIPT.indexOf('nope'), length: 4 });

    const { resultSets } = run;
    expect(resultSets.map(({ statement, rows, truncated }) => [statement, rows.length, truncated])).toEqual([
      [2, 3, false],
      [3, 1, false],
      [4, MAX_ROWS, true],
    ]);
    expect(resultSets[0]?.columns).toEqual(real.preview.columns);
    expect(resultSets[0]?.rows).toEqual(real.preview.rows);
    expect(resultSets[0]?.rows[0]).toEqual([
      1,
      '9007199254740993',
      '1.50',
      '{"name":"a","tags":["x"]}',
      '[{"key":"k","value":1}]',
      'one',
    ]);
    expect(resultSets[0]?.rows[1]).toEqual([2, null, '2.50', null, null, null]);
    expect(tabsOf(run).map(({ id }) => id)).toEqual(['messages', 0, 1, 2]);
  });

  it('selects Messages while the run goes on or has no result set, the first result set afterwards, and the clicked tab while it exists', () => {
    const ended = endRun(fold(real), DONE);

    expect(selectedTab(fold(real), undefined)).toBe('messages');
    expect(selectedTab(beginRun('SELECT 1'), undefined)).toBe('messages');
    expect(selectedTab(ended, undefined)).toBe(0);
    const noResult = endRun(fold(real, 4), DONE);
    expect(noResult.resultSets).toHaveLength(0);
    expect(selectedTab(noResult, undefined)).toBe('messages');
    expect(selectedTab(ended, 'messages')).toBe('messages');
    expect(selectedTab(ended, 2)).toBe(2);
    expect(selectedTab(ended, 3)).toBe(0);
    expect(selectedTab(fold(real), 1)).toBe(1);
  });

  it('leads to the position of the error, else to the statement, found by the index of the events', () => {
    const run = fold(real);
    expect(revealRange(run, 5)).toEqual({ offset: SCRIPT.indexOf('nope'), length: 4 });
    expect(revealRange(run, 2)).toEqual({
      offset: SCRIPT.indexOf('SELECT * FROM t'),
      length: run.statements[2]?.sql.length,
    });
    const withoutPosition = applyEvent(run, { kind: 'error', index: 4, message: 'Out of memory' });
    expect(revealRange(withoutPosition, 4)).toEqual({
      offset: SCRIPT.indexOf('SELECT i FROM range'),
      length: 'SELECT i FROM range(25) r(i)'.length,
    });
    expect(revealRange(run, 99)).toBeUndefined();

    const sparse = applyEvent(beginRun('x'), {
      kind: 'start',
      index: 5,
      statementType: 'SELECT',
      sql: 'SELECT 5',
      offset: 40,
    });
    expect(revealRange(sparse, 5)).toEqual({ offset: 40, length: 8 });
    expect(revealRange(sparse, 0)).toBeUndefined();
  });

  it('marks a statement that never ended as not run, and is the same whether messages arrive one by one or as the whole state', () => {
    const started = fold(real, 5);
    expect(started.statements[2]?.status).toBe('running');
    const ended = endRun(started, { ...DONE, cancelled: true });
    expect(ended.statements.map((statement) => statement.status)).toEqual(['ok', 'ok', 'not-run']);

    const messages: ResultsMessage[] = [
      { type: 'results-begin', script: real.script },
      ...real.events.map((event): ResultsMessage => ({ type: 'results-event', event })),
      { type: 'results-end', summary: DONE },
    ];
    const live = messages.reduce<ResultsRunState | undefined>(applyMessage, undefined);

    expect(applyMessage(undefined, { type: 'results-state', state: live as ResultsRunState })).toEqual(live);
    expect(live?.end).toEqual(DONE);
    expect(applyMessage(live, { type: 'results-begin', script: 'SELECT 2' })).toEqual(beginRun('SELECT 2'));
  });
});

describe('runs without a normal statement', () => {
  it('shows the script as the text of the one line of a parse error and leads to its position; an empty script is a line that is OK', () => {
    const run = applyEvent(beginRun('SELEC 1;\nSELECT 2'), {
      kind: 'error',
      index: 0,
      message: 'Parser Error: syntax error at or near "SELEC". No statement was run.',
      position: { offset: 0, length: 5 },
    });
    const [statement] = run.statements;
    expect(statement && statementText(run, statement)).toBe('SELEC 1; SELECT 2');
    expect(statement?.status).toBe('error');
    expect(revealRange(run, 0)).toEqual({ offset: 0, length: 5 });

    const empty = applyEvent(beginRun('-- nothing'), {
      kind: 'message',
      index: 0,
      text: 'There is nothing to run: the script is empty or has only comments.',
      elapsedMs: 0,
    });
    expect(empty.statements[0]?.status).toBe('ok');
  });

  it('counts rows in the singular and plural, 0 rows included', () => {
    const resultSet: SqlEvent = {
      kind: 'resultSet',
      index: 0,
      columns: [{ name: 'a', type: 'INTEGER', kind: 'number' }],
      rows: [],
      truncated: false,
      elapsedMs: 1,
    };
    expect(applyEvent(beginRun('SELECT 1 WHERE false'), resultSet).statements[0]?.summary).toBe('0 rows');
    expect(applyEvent(beginRun('SELECT 1'), { ...resultSet, rows: [[1]] }).statements[0]?.summary).toBe(
      '1 row',
    );
    const deleted = applyEvent(beginRun('DELETE FROM t'), {
      kind: 'message',
      index: 0,
      text: '0 rows affected.',
      rowsAffected: 0,
      elapsedMs: 1,
    });
    expect(deleted.statements[0]?.summary).toBe('0 rows affected');
  });

  it('ends a run with its rounded time, its outcome and what is left of a transaction, and tells the statuses apart', () => {
    expect(endText({ ...DONE, elapsedMs: 1234.5 })).toContain('1.2 s');
    expect(endText({ ...DONE, elapsedMs: 12.4 })).toContain('12 ms');
    expect(
      new Set(
        [undefined, DONE, { ...DONE, failed: true }, { ...DONE, failed: true, cancelled: true }].map(endText),
      ).size,
    ).toBe(4);
    const open = transactionText({ ...DONE, inTransaction: 'open' });
    const aborted = transactionText({ ...DONE, inTransaction: 'aborted' });
    expect(open).not.toBe(aborted);
    expect(transactionText(DONE)).toBe('');
    expect(transactionText(undefined)).toBe('');
    expect(new Set(Object.values(STATUS_MARKS).map(({ mark }) => mark)).size).toBe(4);
  });
});
