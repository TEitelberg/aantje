import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import type { StorageData, StorageTable } from '../../src/storage-report/model';
import { readStorage } from '../../src/storage-report/read';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** When the reads of the tests happen: the scheduled files of the fixture are some days old then, whatever the day it is run. */
export const READ_AT = new Date('2099-01-01T00:00:00.000Z');

/** The Storage data of the history fixture, read with the real reader on the SQLite variant. */
export async function historyStorage(snapshot = 56): Promise<StorageData> {
  const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  try {
    return await readStorage(reader, 'History lake', snapshot, READ_AT);
  } finally {
    await reader.close();
  }
}

export function table(id: number, name: string, changes: Partial<StorageTable> = {}): StorageTable {
  return {
    id,
    schemaId: 1,
    schema: 'shop',
    name,
    files: 1,
    sizeBytes: 1024,
    rows: 5,
    smallFiles: 0,
    ...changes,
  };
}

/** Storage data that does not depend on a fixture: three tables, one with many small files, and two scheduled files. */
export function sampleStorage(changes: Partial<StorageData> = {}): StorageData {
  const tables = [
    table(1, 'events', { files: 10, sizeBytes: 6 * 1024 * 1024, rows: 1200, smallFiles: 8 }),
    table(2, 'customers', { files: 2, sizeBytes: 2 * 1024 * 1024, rows: 40, approximate: true }),
    table(3, 'notes', { files: 0, sizeBytes: 0, rows: 0 }),
  ];
  return {
    connection: 'Lake',
    scope: { kind: 'lake' },
    snapshot: 12,
    readAt: '2026-11-01T00:00:00.000Z',
    storage: {
      dataPath: '/lake/data/',
      encrypted: false,
      dataFiles: { count: 12, sizeBytes: 7 * 1024 * 1024 },
      deleteFiles: { count: 1, sizeBytes: 1024 * 1024 },
      scheduledForDeletion: {
        count: 2,
        oldestScheduledAt: '2026-10-30T08:00:00.000Z',
        split: {
          age: { text: '2 days', source: 'default' },
          ready: 1,
          waiting: 1,
          nextReadyAt: '2026-11-01T08:00:00.000Z',
        },
      },
      expirableSnapshots: {
        age: { text: '30 days', source: 'default' },
        ready: 100,
        waiting: 20,
        nextReadyAt: '2026-11-04T08:00:00.000Z',
      },
    },
    smallFileBytes: 16 * 1024 * 1024,
    rows: 1240,
    approximate: true,
    tableCount: 3,
    tables,
    growth: [
      {
        snapshot: 3,
        time: '2026-10-01T10:00:00.000Z',
        files: 4,
        sizeBytes: 3 * 1024 * 1024,
        compaction: false,
      },
      {
        snapshot: 7,
        time: '2026-10-15T10:00:00.000Z',
        files: 12,
        sizeBytes: 7 * 1024 * 1024,
        compaction: false,
      },
      { snapshot: 12, time: null, files: 13, sizeBytes: 8 * 1024 * 1024, compaction: true },
    ],
    ...changes,
  };
}
