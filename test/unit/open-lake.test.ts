import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAll, guardedOpen, interruptRepeatedly } from '../../src/data/open-lake';
import type { Engine, GuardedOpen } from '../../src/data/open-lake';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';

const INTERRUPT_INTERVAL_MS = 50;

afterEach(() => {
  vi.useRealTimers();
});

describe('closeAll', () => {
  it('closes every handle and removes the temporary directory, then rethrows the first of the failures', () => {
    const temp = mkdtempSync(join(tmpdir(), 'aantje-closeall-'));
    mkdirSync(join(temp, 'spill'));
    writeFileSync(join(temp, 'spill', 'block.tmp'), 'x');
    const closed: string[] = [];
    const failing = (name: string) => ({
      closeSync: () => {
        closed.push(name);
        throw new Error(`${name} failed`);
      },
    });
    const handle = (name: string) => ({ closeSync: () => void closed.push(name) });

    expect(() =>
      closeAll([failing('parser'), handle('connection'), undefined, failing('instance')], {
        temp_directory: temp,
      }),
    ).toThrow('parser failed');

    expect(closed).toEqual(['parser', 'connection', 'instance']);
    expect(existsSync(temp)).toBe(false);
  });
});

describe('interruptRepeatedly', () => {
  it('interrupts every INTERRUPT_INTERVAL_MS until stopped, without keeping the process alive', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const interrupt = vi.fn();

    const stop = interruptRepeatedly({ interrupt });
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    vi.advanceTimersByTime(INTERRUPT_INTERVAL_MS * 3);
    expect(interrupt).toHaveBeenCalledTimes(3);

    stop();
    vi.advanceTimersByTime(INTERRUPT_INTERVAL_MS * 3);
    expect(interrupt).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
});

interface Behaviour {
  readonly connectionCloseFails?: boolean;
  readonly run?: (sql: string) => Promise<unknown>;
}

/** A stand-in for the native binding that records what is opened and closed; no statement runs on a real engine. */
function fakeEngine(behaviour: Behaviour = {}) {
  const calls: string[] = [];
  const interrupted = { count: 0 };
  const connection = {
    run: (sql: string): Promise<unknown> => {
      calls.push(sql);
      return behaviour.run ? behaviour.run(sql) : Promise.resolve();
    },
    interrupt: () => void interrupted.count++,
    closeSync: () => {
      calls.push('close connection');
      if (behaviour.connectionCloseFails) throw new Error('connection close failed');
    },
  };
  const instance = {
    connect: () => Promise.resolve(connection),
    closeSync: () => void calls.push('close instance'),
  };
  const engine = { DuckDBInstance: { create: () => Promise.resolve(instance) } } as unknown as Engine;
  return { engine, calls, interrupted, connection };
}

const lake = {
  profile: { id: 'lake', name: 'Lake', kind: 'duckdb', path: 'x.duckdb' },
  s3: {},
} as DataAccess;

function opening<T, WithParser extends boolean = false>(
  engine: Engine,
  overrides: Partial<GuardedOpen<T, WithParser>> & Pick<GuardedOpen<T, WithParser>, 'use'>,
): GuardedOpen<T, WithParser> {
  return {
    engine,
    access: lake,
    signal: undefined,
    setup: ['INSTALL ducklake', 'LOAD ducklake', 'ATTACH x'],
    cancelledText: 'Opening was cancelled.',
    activity: 'Opening',
    fail: (cause) => Promise.resolve(cause instanceof Error ? cause : new Error(String(cause))),
    ...overrides,
  };
}

describe('guardedOpen', () => {
  it('runs the setup, then use, and closes connection and instance afterwards, also when closing the connection throws', async () => {
    const { engine, calls } = fakeEngine();
    const value = await guardedOpen(opening(engine, { use: () => Promise.resolve(42) }));
    expect(value).toBe(42);
    expect(calls).toEqual([
      'INSTALL ducklake',
      'LOAD ducklake',
      'ATTACH x',
      'close connection',
      'close instance',
    ]);

    const throwing = fakeEngine({ connectionCloseFails: true });
    await guardedOpen(opening(throwing.engine, { use: () => Promise.resolve(1) })).catch(() => undefined);
    expect(throwing.calls).toContain('close instance');
  });

  it('limits the setup only, not use, when asked to: the caller limits each of its statements', async () => {
    const slowUse = (): Promise<number> => new Promise((resolve) => setTimeout(resolve, 400, 7));
    const access = { ...lake, timeoutMs: 150 };

    const { engine } = fakeEngine();
    await expect(guardedOpen(opening(engine, { access, limitSetupOnly: true, use: slowUse }))).resolves.toBe(
      7,
    );
    // Without it the limit of the access runs through use.
    const second = fakeEngine();
    await expect(guardedOpen(opening(second.engine, { access, use: slowUse }))).rejects.toMatchObject({
      code: 'TIMEOUT',
    });

    // A setup that never answers is ended at the limit, with or without the option.
    const stuck = fakeEngine({
      run: (sql) => (sql === 'ATTACH x' ? new Promise(() => undefined) : Promise.resolve()),
    });
    await expect(
      guardedOpen(opening(stuck.engine, { access, limitSetupOnly: true, use: () => Promise.resolve(1) })),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('keeps everything open after use when asked to, and closes both connections on failure', async () => {
    const kept = fakeEngine();
    await guardedOpen(opening(kept.engine, { keepOpen: true, use: () => Promise.resolve('session') }));
    expect(kept.calls).not.toContain('close instance');

    const failed = fakeEngine();
    await expect(
      guardedOpen(
        opening(failed.engine, {
          keepOpen: true,
          parser: true,
          use: ({ parser }) => {
            expect(parser).toBeDefined();
            return Promise.reject(new Error('use failed'));
          },
        }),
      ),
    ).rejects.toThrow('use failed');
    expect(failed.calls.filter((call) => call === 'close connection')).toHaveLength(2);
    expect(failed.calls.at(-1)).toBe('close instance');
  });

  it('maps a failed setup statement through fail, with the phase it happened in', async () => {
    const { engine } = fakeEngine({
      run: (sql) => (sql === 'ATTACH x' ? Promise.reject(new Error('attach failed')) : Promise.resolve()),
    });
    const fail = vi.fn((cause: unknown) =>
      Promise.resolve(new AantjeError('CONNECTION_FAILED', String(cause))),
    );

    await expect(guardedOpen(opening(engine, { fail, use: () => Promise.resolve(1) }))).rejects.toMatchObject(
      { code: 'CONNECTION_FAILED' },
    );
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'attach failed' }),
      'setup',
      expect.anything(),
    );
  });

  it('throws ABORTED with the given text before anything is opened when the signal is already aborted', async () => {
    const { engine, calls } = fakeEngine();

    await expect(
      guardedOpen(opening(engine, { signal: AbortSignal.abort(), use: () => Promise.resolve(1) })),
    ).rejects.toMatchObject({ code: 'ABORTED', userMessage: 'Opening was cancelled.' });
    expect(calls).toEqual([]);
  });

  describe('a statement that ends only when it is interrupted', () => {
    function stuckAttach() {
      const state = fakeEngine();
      const release: { end?: () => void } = {};
      state.connection.run = (sql: string) => {
        state.calls.push(sql);
        return sql === 'ATTACH x'
          ? new Promise<void>((resolve) => {
              release.end = resolve;
            })
          : Promise.resolve();
      };
      return { ...state, release };
    }

    it('ends a slow attach at its time limit, interrupts it and closes everything', async () => {
      const { engine, calls, interrupted, release } = stuckAttach();
      const access = { ...lake, timeoutMs: 100 };
      const opened = guardedOpen(
        opening(engine, { access, lockingFile: true, use: () => Promise.resolve(1) }),
      );
      opened.catch(() => undefined);
      await vi.waitFor(() => expect(interrupted.count).toBeGreaterThan(0));

      release.end?.();

      await expect(opened).rejects.toMatchObject({ code: 'TIMEOUT' });
      expect(calls.at(-1)).toBe('close instance');
    });

    it('releases the caller at once on a cancel when the attach does not lock a file', async () => {
      const { engine, calls, release } = stuckAttach();
      const controller = new AbortController();
      const opened = guardedOpen(
        opening(engine, { signal: controller.signal, use: () => Promise.resolve(1) }),
      );
      await vi.waitFor(() => expect(calls).toContain('ATTACH x'));

      controller.abort();

      await expect(opened).rejects.toMatchObject({ code: 'ABORTED' });
      expect(calls).not.toContain('close instance');
      release.end?.();
      await vi.waitFor(() => expect(calls).toContain('close instance'));
    });

    it('reports a cancel only after the instance is closed when the attach locks the file', async () => {
      const { engine, calls, release } = stuckAttach();
      const controller = new AbortController();
      let settled = false;
      const opened = guardedOpen(
        opening(engine, { signal: controller.signal, lockingFile: true, use: () => Promise.resolve(1) }),
      ).finally(() => {
        settled = true;
      });
      opened.catch(() => undefined);
      await vi.waitFor(() => expect(calls).toContain('ATTACH x'));

      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 3 * INTERRUPT_INTERVAL_MS));
      expect(settled).toBe(false);

      release.end?.();
      await expect(opened).rejects.toMatchObject({ code: 'ABORTED' });
      expect(calls.at(-1)).toBe('close instance');
    });
  });
});
