import { describe, expect, it, vi } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogEntry } from '../../src/catalog/model';
import { info, metadata } from '../../src/catalog/queries/objects';
import { createCatalogReader } from '../../src/catalog/reader';
import { readAdvisor } from '../../src/advisor/read';
import type { DataAccess } from '../../src/data/types';
import { HISTORY_LATEST_SNAPSHOT, SCHEDULED_FOR_DELETION } from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { recording } from '../support/recording-driver';
import { historyFixture } from '../support/sources/history';

// The dry runs need a lake and an engine; the lists of candidates do not.
vi.mock('../../src/advisor/measure', () => ({
  measureDryRuns: () =>
    Promise.resolve({
      expiry: { state: 'skipped', reason: 'not measured here' },
      cleanup: { state: 'skipped', reason: 'not measured here' },
      orphans: { state: 'skipped', reason: 'not measured here' },
    }),
}));

type Reader = Parameters<typeof readAdvisor>[0]['reader'];

/** The part of a result that the advisor reads. */
const stub = <T>(value: unknown): Promise<T> => Promise.resolve(value as T);

/** Tables 1..count; the facts of each kind are the first `limit` of the items the test gives, as the catalog cuts them. */
function reader(
  count: number,
  facts: {
    smallFiles?: readonly { tableId: number; files: number; small: number; smallBytes: number }[];
    heavy?: readonly { tableId: number; files: number }[];
    inlined?: readonly { tableId: number; rows: number }[];
  },
): Reader {
  const entries: CatalogEntry[] = Array.from({ length: count }, (_, index) => ({
    kind: 'table',
    id: index + 1,
    name: `t${index + 1}`,
    schemaId: 0,
    schemaName: 'main',
  }));
  return {
    info: () => stub({ latestSnapshot: 7 }),
    metadata: () => Promise.resolve([]),
    snapshotCount: () => Promise.resolve(3),
    scheduledForDeletion: () => Promise.resolve({ count: 0, oldestScheduledAt: null, split: null }),
    expirableSnapshots: () => Promise.resolve(null),
    entries: () => Promise.resolve(entries),
    maintenanceFacts: (_scope, limit) =>
      Promise.resolve({
        snapshotGaps: { count: 0, missing: 0, first: [] },
        smallFiles: (facts.smallFiles ?? []).slice(0, limit),
        inlined: (facts.inlined ?? []).slice(0, limit),
      }),
    deleteHeavyTables: (_scope, _floor, _threshold, limit) =>
      Promise.resolve(
        (facts.heavy ?? []).slice(0, limit).map(({ tableId, files }) => ({
          tableId,
          files,
          atThreshold: 0,
          records: 100,
          deleted: 60,
          sizeBytes: 1000,
        })),
      ),
  };
}

const access = {} as DataAccess;
const read = (source: Reader) => readAdvisor({ reader: source, access }, 'Lake', new Date());

const small = (tableId: number, files = 10) => ({ tableId, files, small: files, smallBytes: 100 });
const range = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

describe('the candidates of the Maintenance Advisor are cut at 100 tables of each kind', () => {
  it.each([
    ['small files', (count: number) => reader(count, { smallFiles: range(count).map((id) => small(id)) })],
    [
      'rewrites',
      (count: number) => reader(count, { heavy: range(count).map((tableId) => ({ tableId, files: 1 })) }),
    ],
    [
      'inlined rows',
      (count: number) =>
        reader(count, { inlined: range(count).map((tableId) => ({ tableId, rows: 20_000 })) }),
    ],
  ])('names 100 of 101 tables with %s and says that there are more', async (_kind, make) => {
    const data = await read(make(101));

    expect(data.merge.length + data.rewrite.length + data.flush.length).toBe(100);
    expect(data.more).toBe(true);
  });

  it.each([
    ['small files', (count: number) => reader(count, { smallFiles: range(count).map((id) => small(id)) })],
    [
      'rewrites',
      (count: number) => reader(count, { heavy: range(count).map((tableId) => ({ tableId, files: 1 })) }),
    ],
    [
      'inlined rows',
      (count: number) =>
        reader(count, { inlined: range(count).map((tableId) => ({ tableId, rows: 20_000 })) }),
    ],
  ])(
    'names all of exactly 100 tables with %s and does not claim that there are more',
    async (_kind, make) => {
      const data = await read(make(100));

      expect(data.merge.length + data.rewrite.length + data.flush.length).toBe(100);
      expect(data.more).toBeUndefined();
    },
  );

  it('lists a table with 10,001 inlined rows and not one with 10,000, the table with more rows first, then by id', async () => {
    const data = await read(
      reader(5, {
        inlined: [
          { tableId: 1, rows: 10_000 },
          { tableId: 2, rows: 10_001 },
          { tableId: 3, rows: 50_000 },
          { tableId: 4, rows: 10_001 },
          { tableId: 5, rows: 9_999 },
        ],
      }),
    );

    expect(data.flush.map(({ table, rows }) => [table.name, rows])).toEqual([
      ['t3', 50_000],
      ['t2', 10_001],
      ['t4', 10_001],
    ]);
  });

  it('names the tables with many small files with the most files first, then by id, and not those with a few or mostly large files', async () => {
    const data = await read(
      reader(6, {
        smallFiles: [
          small(4, 30),
          small(2, 12),
          small(1, 12),
          { tableId: 3, files: 4, small: 4, smallBytes: 1 },
          { tableId: 5, files: 20, small: 9, smallBytes: 9 },
          { tableId: 6, files: 20, small: 10, smallBytes: 10 },
        ],
      }),
    );

    expect(data.merge.map(({ table, files }) => [table.name, files])).toEqual([
      ['t4', 30],
      ['t6', 20],
      ['t1', 12],
      ['t2', 12],
    ]);
  });
});

describe('the catalog reads of the Maintenance Advisor', () => {
  it('read the info and the metadata of the catalog once', async () => {
    const driver = recording(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
    const catalog = createCatalogReader(driver);
    try {
      const data = await readAdvisor({ reader: catalog, access }, 'History', new Date());

      expect(data.snapshot).toBe(HISTORY_LATEST_SNAPSHOT);
      expect(data.scheduled.count).toBe(SCHEDULED_FOR_DELETION.length);
      expect([driver.count(info()), driver.count(metadata())]).toEqual([1, 1]);
    } finally {
      await catalog.close();
    }
  });
});
