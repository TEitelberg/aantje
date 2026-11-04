import { afterAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { AantjeError } from '../../src/errors';
import { HISTORY_LATEST_SNAPSHOT } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

const real = await openSqlite({ path: historyFixture.sqlite, wasmPath });
afterAll(() => real.close());

/** The history fixture behind a driver that records every statement with the options it was given. */
function recording(): { driver: Driver; calls: { sql: string; signal: AbortSignal | undefined }[] } {
  const calls: { sql: string; signal: AbortSignal | undefined }[] = [];
  return {
    calls,
    driver: {
      query: (sql, params, options) => {
        calls.push({ sql, signal: options?.signal });
        return real.query(sql, params, options);
      },
      close: () => Promise.resolve(),
    },
  };
}

describe('snapshotActivity', () => {
  it('reads the changes of every snapshot with a handful of statements, not one per snapshot, and hands the signal to each', async () => {
    const { driver, calls } = recording();
    const abort = new AbortController();

    const { snapshots } = await createCatalogReader(driver).snapshotActivity(500, undefined, abort.signal);

    expect(snapshots).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    // The snapshots, then the versions and the created objects of the schemas, tables, views and macros.
    expect(calls.length).toBe(9);
    expect(calls.every(({ signal }) => signal === abort.signal)).toBe(true);
  });

  it('hands the signal on when the catalog has no commit columns and the first statement is repeated', async () => {
    const { calls } = recording();
    const abort = new AbortController();
    let first = true;
    const driver: Driver = {
      query: (sql, params, options) => {
        calls.push({ sql, signal: options?.signal });
        if (first) {
          first = false;
          return Promise.reject(new AantjeError('QUERY_FAILED', 'no such column: c.author'));
        }
        return real.query(sql, params, options);
      },
      close: () => Promise.resolve(),
    };

    const { snapshots } = await createCatalogReader(driver).snapshotActivity(5, undefined, abort.signal);

    expect(snapshots).toHaveLength(5);
    expect(calls.slice(0, 2).map(({ sql }) => sql.includes('c.author'))).toEqual([true, false]);
    expect(calls.every(({ signal }) => signal === abort.signal)).toBe(true);
  });

  it('passes a failure that is not a missing column on instead of reading without commit data', async () => {
    const failure = new AantjeError('LOCKED', 'The catalog is locked.');
    const driver: Driver = { query: () => Promise.reject(failure), close: () => Promise.resolve() };
    await expect(createCatalogReader(driver).snapshotActivity()).rejects.toBe(failure);
  });
});
