import { afterEach, describe, expect, it, vi } from 'vitest';
import { openQuack } from '../../src/catalog/drivers/quack';
import type { Engine } from '../../src/data/open-lake';

// A stand-in for the native engine that plays a Quack server: it answers a query with one row, can lose the connection
// of the attach once (a restarted server) and can hang. Each attach is one instance; the driver must attach again when
// the server lost it, let the queries take turns, and close without waiting for a query that never ends.
function fakeServer() {
  const server = {
    instances: 0,
    closed: 0,
    running: 0,
    mostAtOnce: 0,
    restartNext: false,
    hang: false,
  };
  const instance = () => {
    server.instances++;
    return {
      connect: () =>
        Promise.resolve({
          run: async (sql: string) => {
            if (!/^SELECT/.test(sql)) return undefined;
            if (server.restartNext) {
              server.restartNext = false;
              throw new Error('IO Error: Invalid connection id 7');
            }
            server.running++;
            server.mostAtOnce = Math.max(server.mostAtOnce, server.running);
            try {
              if (server.hang) await new Promise(() => undefined);
              await new Promise((resolve) => setTimeout(resolve, 5));
              return { getRowObjects: () => Promise.resolve([{ answer: 42 }]), closeSync: () => undefined };
            } finally {
              server.running--;
            }
          },
          interrupt: () => undefined,
          closeSync: () => undefined,
        }),
      closeSync: () => void server.closed++,
    };
  };
  const engine = { DuckDBInstance: { create: () => Promise.resolve(instance()) } } as unknown as Engine;
  return { server, engine };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the Quack driver over a server that restarts or hangs', () => {
  it('attaches again when the server lost the connection and runs the query once more', async () => {
    const { server, engine } = fakeServer();
    const driver = await openQuack({ host: 'duckdb', port: 9494, ssl: false, engine });
    await expect(driver.query('SELECT 1')).resolves.toEqual([{ answer: 42 }]);

    server.restartNext = true;
    await expect(driver.query('SELECT 1')).resolves.toEqual([{ answer: 42 }]);

    expect(server.instances).toBe(2);
    await driver.close();
  });

  it('lets the queries take turns: the server never runs two at once', async () => {
    const { server, engine } = fakeServer();
    const driver = await openQuack({ host: 'duckdb', port: 9494, ssl: false, engine });
    const answers = await Promise.all([1, 2, 3, 4].map(() => driver.query('SELECT 1')));
    expect(answers).toHaveLength(4);
    expect(server.mostAtOnce).toBe(1);
    await driver.close();
  });

  it('closes after its grace while a query hangs, gives the query up and closes the instance when it would end', async () => {
    const { server, engine } = fakeServer();
    const driver = await openQuack({ host: 'duckdb', port: 9494, ssl: false, engine });
    server.hang = true;
    const hanging = driver.query('SELECT 1');
    hanging.catch(() => undefined);
    await vi.waitFor(() => expect(server.running).toBe(1));

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const closing = driver.close();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(closing).resolves.toBeUndefined();
    await expect(hanging).rejects.toMatchObject({ code: 'ABORTED' });
    // The hanging call still holds the instance, so it is not closed under it.
    expect(server.closed).toBe(0);
  });
});
