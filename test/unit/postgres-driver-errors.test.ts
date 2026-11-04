import type * as Pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import { AantjeError, networkReason } from '../../src/errors';

// A stand-in for the client that fails to connect with whatever value the test sets; nothing talks to a server.
const stub = vi.hoisted((): { failure: unknown; ended: number; endFails: boolean } => ({
  failure: undefined,
  ended: 0,
  endFails: false,
}));

vi.mock('pg', async (importOriginal) => {
  const original = await importOriginal<typeof Pg>();
  class Client {
    on(): this {
      return this;
    }
    connect(): Promise<void> {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the value under test is no Error
      return Promise.reject(stub.failure);
    }
    end(): Promise<void> {
      stub.ended++;
      return stub.endFails ? Promise.reject(new Error('already closed')) : Promise.resolve();
    }
  }
  return { ...original, Client };
});

const options = { host: 'db.example', port: 5432, database: 'lake', user: 'app' };

describe('the connect error of the PostgreSQL driver', () => {
  beforeEach(() => {
    stub.ended = 0;
    stub.endFails = false;
  });

  it.each([
    [null, 'unknown error'],
    [undefined, 'unknown error'],
    ['the proxy said no', 'the proxy said no'],
    [
      Object.assign(new Error(''), { code: 'ECONNREFUSED' }),
      networkReason(Object.assign(new Error(''), { code: 'ECONNREFUSED' })),
    ],
    [
      Object.assign(new Error(''), { code: 'ENOTFOUND' }),
      networkReason(Object.assign(new Error(''), { code: 'ENOTFOUND' })),
    ],
  ])('names a thrown %j without throwing itself', async (failure, reason) => {
    stub.failure = failure;

    const error = await openPostgres(options).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(AantjeError);
    expect(error).toMatchObject({
      code: 'CONNECTION_FAILED',
      userMessage: `Cannot connect to db.example:5432: ${reason}.`,
    });
  });

  it('gives up the half-open client, and a failing close does not become an unhandled rejection', async () => {
    stub.failure = new Error('timeout expired');
    stub.endFails = true;

    await expect(openPostgres(options)).rejects.toMatchObject({
      userMessage: 'Cannot connect to db.example:5432: no response within 10 s.',
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(stub.ended).toBe(1);
  });
});
