import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBConnection } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LakeFailure, withLakeSession } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { accessFor, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Engine session tests are skipped: ${skipReason}`);
}

// The session of the one-shot engine that the health check shares between its groups.
describe.skipIf(skipReason)('withLakeSession', () => {
  const fixtures: DataFixture[] = [];
  const open = async (): Promise<DataFixture> => {
    const fixture = await copyHistoryFixture('sqlite');
    fixtures.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
  });

  const SLOW = 'SELECT count(*) FROM range(100000000000) a, range(1000) b';

  /**
   * Watches the real connection class: when the slow statement settles, when the connection is closed and how often
   * it was interrupted by then. `statement` replaces what the slow statement returns.
   */
  function watchConnection(statement?: () => Promise<never>): {
    order: string[];
    interrupts: () => number;
  } {
    const order: string[] = [];
    const interrupt = vi.spyOn(DuckDBConnection.prototype, 'interrupt');
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the connection below
    const runAndReadAll = DuckDBConnection.prototype.runAndReadAll;
    vi.spyOn(DuckDBConnection.prototype, 'runAndReadAll').mockImplementation(function (
      this: DuckDBConnection,
      sql,
      values,
      types,
    ) {
      const running = sql === SLOW && statement ? statement() : runAndReadAll.call(this, sql, values, types);
      if (sql === SLOW) {
        const settled = (): number => order.push('statement settled');
        running.then(settled, settled);
      }
      return running;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the connection below
    const closeSync = DuckDBConnection.prototype.closeSync;
    vi.spyOn(DuckDBConnection.prototype, 'closeSync').mockImplementation(function (this: DuckDBConnection) {
      order.push(`close connection after ${interrupt.mock.calls.length} interrupts`);
      closeSync.call(this);
    });
    return { order, interrupts: () => interrupt.mock.calls.length };
  }

  async function failure(call: Promise<unknown>): Promise<unknown> {
    return call.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('reads the newest snapshot of the lake even when the access pins an older one (shop.customers did not exist at snapshot 5), and gives scalar rows', async () => {
    const fixture = await open();

    const rows = await withLakeSession(accessFor(fixture, { snapshot: 5 }), undefined, async (session) => [
      await session.rows('SELECT count(*) FROM lake.shop.customers'),
      await session.rows("SELECT 'a', 2, true, NULL, [1, 2]"),
    ]);

    expect(rows).toEqual([[['5']], [['a', 2, true, null, '[1,2]']]]);
  });

  it('does not apply the time limit of the access to the whole session: it is the limit of a statement', async () => {
    const fixture = await open();

    // Every statement is far below the limit of the access, together they are not.
    const took = await withLakeSession(
      accessFor(fixture, { timeoutMs: 3000 }),
      undefined,
      async (session) => {
        const started = performance.now();
        while (performance.now() - started < 3500) {
          await session.rows('SELECT 1');
        }
        return performance.now() - started;
      },
    );

    expect(took).toBeGreaterThanOrEqual(3500);
  });

  it('ends an attach that never answers at the time limit of the access, although the statements have limits of their own', async () => {
    const fixture = await open();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the connection below
    const run = DuckDBConnection.prototype.run;
    vi.spyOn(DuckDBConnection.prototype, 'run').mockImplementation(async function (
      this: DuckDBConnection,
      sql,
      ...rest
    ) {
      if (sql.startsWith('ATTACH')) await held;
      return run.call(this, sql, ...rest);
    });

    // The attach is held until the end of the test: without a limit this call never returns.
    const error: unknown = await withLakeSession(accessFor(fixture, { timeoutMs: 300 }), undefined, () =>
      Promise.resolve(1),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: 'TIMEOUT' });
    // The stuck attach ends and the engine closes now, not during the next test.
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));
  });

  it('ends a statement at its own limit with a failure that says so, and runs the next one', async () => {
    const fixture = await open();

    const result = await withLakeSession(accessFor(fixture), undefined, async (session) => {
      const started = performance.now();
      const slow = await failure(
        session.rows('SELECT count(*) FROM range(100000000000) a, range(1000) b', 300),
      );
      const took = performance.now() - started;
      return { slow, took, next: await session.rows('SELECT 1') };
    });

    expect(result.slow).toBeInstanceOf(LakeFailure);
    expect(result.slow).toMatchObject({
      phase: 'query',
      timedOut: true,
      message: 'The statement exceeded its time limit of 0.3 s and was cancelled.',
    });
    expect(result.took).toBeLessThan(5000);
    expect(result.next).toEqual([[1]]);
  });

  it('closes the engine only after a statement that exceeded its limit has ended, and stops interrupting it before the close', async () => {
    const fixture = await open();
    const watch = watchConnection();

    await withLakeSession(accessFor(fixture), undefined, async (session) => {
      const slow = await failure(session.rows(SLOW, 50));
      expect(slow).toMatchObject({ timedOut: true });
      // `use` ends while the statement may still run: the session must wait for it, not the caller.
    });
    const interruptsAtClose = watch.interrupts();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(watch.order).toEqual([
      'statement settled',
      `close connection after ${interruptsAtClose} interrupts`,
    ]);
    expect(interruptsAtClose).toBeGreaterThan(0);
    expect(watch.interrupts()).toBe(interruptsAtClose);
  });

  it('gives up waiting for a statement that the interrupt does not end after 3 s, says so in the log and closes anyway', async () => {
    const fixture = await open();
    // A blocked network read: the statement never settles and the interrupt does nothing.
    const watch = watchConnection(() => new Promise<never>(() => undefined));
    const warnings: string[] = [];
    let useEnded = 0;

    await withLakeSession(
      accessFor(fixture, { log: { warn: (message) => void warnings.push(message) } }),
      undefined,
      async (session) => {
        await failure(session.rows(SLOW, 50));
        useEnded = performance.now();
      },
    );
    const waited = performance.now() - useEnded;
    const interruptsAtClose = watch.interrupts();
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(waited).toBeGreaterThanOrEqual(2900);
    expect(waited).toBeLessThan(6000);
    expect(warnings).toEqual([
      'A statement that exceeded its time limit did not end within 3 s of being interrupted; the engine is closed anyway.',
    ]);
    expect(watch.order).toEqual([`close connection after ${interruptsAtClose} interrupts`]);
    expect(watch.interrupts()).toBe(interruptsAtClose);
  });

  it('gives a failed statement as a failure with the whole text of the engine and without the statement behind it', async () => {
    const fixture = await open();

    const error = await withLakeSession(accessFor(fixture), undefined, (session) =>
      failure(session.rows('SELECT * FROM no_such_table')),
    );

    expect(error).toBeInstanceOf(LakeFailure);
    expect((error as LakeFailure).phase).toBe('query');
    expect((error as LakeFailure).timedOut).toBe(false);
    expect((error as LakeFailure).text).toMatch(
      /^Catalog Error: Table with name no_such_table does not exist!/,
    );
    expect((error as LakeFailure).text).not.toContain('LINE 1');
    expect((error as LakeFailure).message).toBe((error as LakeFailure).text.split('\n')[0]);
  });

  it('leaves the password and the S3 keys out of the text of a failure', async () => {
    const fixture = await open();

    const error = await withLakeSession(
      accessFor(fixture, {
        password: 'pw-secret-1',
        s3Credentials: { keyId: 'KEYID-2', secretKey: 'sekrit-3' },
      }),
      undefined,
      (session) => failure(session.rows("SELECT error('boom pw-secret-1 KEYID-2 sekrit-3')")),
    );

    expect((error as LakeFailure).text).toContain('boom *** *** ***');
  });

  it('fails the setup as a failure with the phase it happened in', async () => {
    const fixture = await open();
    const broken = join(fixture.directory, 'broken.sqlite');
    writeFileSync(broken, 'not a database');

    const error = await failure(
      withLakeSession(accessFor(fixture, { profile: { ...fixture.profile, path: broken } }), undefined, () =>
        Promise.resolve(),
      ),
    );

    expect(error).toBeInstanceOf(LakeFailure);
    expect((error as LakeFailure).phase).toBe('setup');
  });

  it('releases the caller at once when the signal fires during a statement', async () => {
    const fixture = await open();
    const controller = new AbortController();

    const started = performance.now();
    const error = await failure(
      withLakeSession(accessFor(fixture), controller.signal, async (session) => {
        setTimeout(() => controller.abort(), 200);
        return session.rows('SELECT count(*) FROM range(100000000000) a, range(1000) b');
      }),
    );

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).code).toBe('ABORTED');
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
