import { beforeAll, describe, expect, it } from 'vitest';
import type { ResultsMessage } from '../../src/grid/protocol';
import { ResultsRun } from '../../src/grid/results';
import { applyMessage } from '../../src/grid/results-model';
import type { ResultsRunState, ResultsRunSummary } from '../../src/grid/results-model';
import type { SqlEvent } from '../../src/sql/session';
import { engineSkipReason } from './data-support';
import { MAX_ROWS, realRun, SCRIPT } from './results-support';
import type { RealRun } from './results-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The results run tests with a real session are skipped: ${skipReason}`);
}

const DONE: ResultsRunSummary = { cancelled: false, failed: true, elapsedMs: 80, inTransaction: 'none' };

/** A run that sends to a list; `received` is what a page would get. */
function newRun(): { run: ResultsRun; received: ResultsMessage[] } {
  const received: ResultsMessage[] = [];
  return { run: new ResultsRun((message) => received.push(message)), received };
}

function play(run: ResultsRun, real: RealRun, events: readonly SqlEvent[] = real.events): void {
  run.begin(real.script);
  events.forEach((event) => run.event(event));
  run.end(DONE);
}

const resultSets = (state: ResultsRunState | undefined): number[][] =>
  (state?.resultSets ?? []).map((set) => [set.statement, set.rows.length, Number(set.truncated)]);

describe.skipIf(skipReason)('the last run of an editor', () => {
  let real: RealRun;
  beforeAll(async () => {
    real = await realRun();
  });

  describe('before the page says ready', () => {
    it('sends nothing, keeps everything, and sends the whole run once when the page is ready', () => {
      const { run, received } = newRun();
      play(run, real);
      expect(received).toEqual([]);

      run.pageReady();

      expect(received).toHaveLength(1);
      const [message] = received;
      expect(message?.type).toBe('results-state');
      expect(message?.type === 'results-state' && message.state).toEqual(run.state);
      expect(resultSets(run.state)).toEqual([
        [2, 3, 0],
        [3, 1, 0],
        [4, MAX_ROWS, 1],
      ]);
      expect(run.state?.statements.map(({ status }) => status)).toEqual([
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'error',
      ]);
      expect(run.state?.end).toEqual(DONE);
    });

    it('has nothing to send for an editor that did not run anything', () => {
      const { run, received } = newRun();
      run.pageReady();
      expect(received).toEqual([]);
    });
  });

  describe('while the page is there', () => {
    it('sends the begin, each event and the end as they come', () => {
      const { run, received } = newRun();
      run.pageReady();
      play(run, real);

      expect(received.map((message) => message.type)).toEqual([
        'results-begin',
        ...real.events.map(() => 'results-event'),
        'results-end',
      ]);
      expect(
        received.filter((message) => message.type === 'results-event').map((message) => message.event),
      ).toEqual(real.events);
    });

    it('builds in the page the same run as the extension keeps, and the same as a page that loads later', () => {
      const live = newRun();
      live.run.pageReady();
      play(live.run, real);
      const inLivePage = live.received.reduce<ResultsRunState | undefined>(applyMessage, undefined);

      const late = newRun();
      play(late.run, real);
      late.run.pageReady();
      const inLatePage = late.received.reduce<ResultsRunState | undefined>(applyMessage, undefined);

      expect(inLivePage).toEqual(live.run.state);
      expect(inLatePage).toEqual(inLivePage);
      expect(inLivePage?.resultSets[0]?.rows).toEqual(real.preview.rows);
    });

    it('shows a statement as running until its outcome arrives, and the page gets the start at once', () => {
      const { run, received } = newRun();
      run.pageReady();
      run.begin(real.script);
      real.events.slice(0, 3).forEach((event) => run.event(event));

      expect(run.state?.statements.map(({ status }) => status)).toEqual(['ok', 'running']);
      expect(received.at(-1)).toEqual({ type: 'results-event', event: real.events[2] });
      expect(received.reduce<ResultsRunState | undefined>(applyMessage, undefined)).toEqual(run.state);
    });
  });

  describe('when the panel is hidden and shown again', () => {
    it('does not post to the page that is gone, and gives the page that comes back everything that happened meanwhile', () => {
      const { run, received } = newRun();
      run.pageReady();
      run.begin(real.script);
      real.events.slice(0, 4).forEach((event) => run.event(event));
      received.length = 0;

      run.pageGone();
      real.events.slice(4).forEach((event) => run.event(event));
      run.end(DONE);
      expect(received).toEqual([]);

      run.pageReady();
      expect(received).toHaveLength(1);
      const replayed = received.reduce<ResultsRunState | undefined>(applyMessage, undefined);
      expect(replayed).toEqual(run.state);
      expect(resultSets(replayed)).toEqual([
        [2, 3, 0],
        [3, 1, 0],
        [4, MAX_ROWS, 1],
      ]);
      expect(replayed?.end).toEqual(DONE);
    });

    it('sends the events after the replay live again, without a gap and without a repeat', () => {
      const { run, received } = newRun();
      run.begin(real.script);
      real.events.slice(0, 2).forEach((event) => run.event(event));
      run.pageReady();
      real.events.slice(2, 4).forEach((event) => run.event(event));

      expect(received.map((message) => message.type)).toEqual([
        'results-state',
        'results-event',
        'results-event',
      ]);
      expect(received.reduce<ResultsRunState | undefined>(applyMessage, undefined)).toEqual(run.state);
    });
  });

  describe('a new run', () => {
    it('replaces the last one, in the page and in what a page that is loaded later gets', () => {
      const { run, received } = newRun();
      run.pageReady();
      play(run, real);
      received.length = 0;

      run.begin('SELECT 1');
      run.event({ kind: 'start', index: 0, statementType: 'SELECT', sql: 'SELECT 1', offset: 0 });

      expect(received.map((message) => message.type)).toEqual(['results-begin', 'results-event']);
      expect(run.state?.resultSets).toEqual([]);
      expect(run.state?.statements.map(({ sql }) => sql)).toEqual(['SELECT 1']);
      expect(run.state?.end).toBeUndefined();
      run.pageReady();
      expect(received.at(-1)).toEqual({ type: 'results-state', state: run.state });
    });

    it('keeps only a one-line, shortened text of the script, not the script', () => {
      const { run } = newRun();
      run.begin(`SELECT 1;\n${'-- x\n'.repeat(1000)}`);
      expect(run.state?.script).toHaveLength(201);
      expect(run.state?.script.startsWith('SELECT 1; -- x -- x')).toBe(true);
    });
  });

  it('drops the events of a run that was never begun, as when the panel was closed meanwhile', () => {
    const { run, received } = newRun();
    run.pageReady();
    real.events.forEach((event) => run.event(event));
    run.end(DONE);

    expect(run.state).toBeUndefined();
    expect(received).toEqual([]);
  });

  describe('the position of "Go to statement"', () => {
    it('is the position of the error of the statement with that index, else the statement', () => {
      const { run } = newRun();
      play(run, real);

      expect(run.revealRange(5)).toEqual({ offset: SCRIPT.indexOf('nope'), length: 4 });
      expect(run.revealRange(2)?.offset).toBe(SCRIPT.indexOf('SELECT * FROM t'));
      expect(run.revealRange(6)).toBeUndefined();
    });

    it('is nothing before a run', () => {
      expect(newRun().run.revealRange(0)).toBeUndefined();
    });
  });
});
