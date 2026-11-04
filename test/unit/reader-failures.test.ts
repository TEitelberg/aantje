import { describe, expect, it } from 'vitest';
import type { Driver, Row } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { AantjeError } from '../../src/errors';
import type { ErrorCode } from '../../src/errors';
import { createCatalogReader } from '../../src/catalog/reader';
import { fixturePath, wasmPath } from '../support/fixtures';

/** The failures of the connection itself, which no read may turn into something else. */
const PASSED_ON: readonly ErrorCode[] = ['LOCKED', 'TIMEOUT', 'CONNECTION_FAILED', 'AUTH_FAILED', 'ABORTED'];

/** A database that fails every statement the way a real driver reports it. */
function failingDriver(error: Error): Driver {
  return { query: () => Promise.reject(error), close: () => Promise.resolve() };
}

/** A database whose answers change between calls: it answers by call order, not by SQL text. */
function changingDriver(...answers: Row[][]): Driver {
  let calls = 0;
  return { query: () => Promise.resolve(answers[calls++] ?? []), close: () => Promise.resolve() };
}

describe('catalog reader when the database fails', () => {
  it('reports a failure of the connection as it is instead of calling the database "not a DuckLake"', async () => {
    for (const code of PASSED_ON) {
      const error = new AantjeError(code, 'The driver could not run the statement.');
      await expect(createCatalogReader(failingDriver(error)).info(), code).rejects.toBe(error);
    }
    const bug = new TypeError('driver bug');
    await expect(createCatalogReader(failingDriver(bug)).info()).rejects.toBe(bug);
  });

  it('turns a failed info statement into NOT_A_DUCKLAKE with the driver error as its cause, and leaves other reads alone', async () => {
    const failure = new AantjeError(
      'QUERY_FAILED',
      'The catalog query failed: no such table: ducklake_metadata',
    );
    const reader = createCatalogReader(failingDriver(failure));
    const error: unknown = await reader.info().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AantjeError);
    expect(error).toMatchObject({ code: 'NOT_A_DUCKLAKE', cause: failure });
    await expect(reader.tables(1, 1)).rejects.toBe(failure);
    await expect(reader.columns(2, 1)).rejects.toBe(failure);
  });

  describe('on the tables that a catalog may lack', () => {
    /** Fails the statements that touch one of the optional tables; every other one answers without rows. */
    function optionalFailing(error: Error): Driver {
      const optional =
        /ducklake_(partition_info|sort_info|tag|column_tag|macro|files_scheduled_for_deletion)/;
      return {
        query: (sql) => {
          if (optional.test(sql)) return Promise.reject(error);
          const totals = [
            { kind: 'data', file_count: 0, size_bytes: 0 },
            { kind: 'delete', file_count: 0, size_bytes: 0 },
          ];
          return Promise.resolve(sql.includes('ducklake_data_file') ? totals : []);
        },
        close: () => Promise.resolve(),
      };
    }

    const reads = (reader: ReturnType<typeof createCatalogReader>): [string, () => Promise<unknown>][] => [
      ['partitioning', () => reader.partitioning(1, 1)],
      ['sortOrder', () => reader.sortOrder(1, 1)],
      ['tags', () => reader.tags(1, 1)],
      ['macros', () => reader.macros(1, 1)],
      ['storage', () => reader.storage(1)],
    ];

    it('passes a failure of the connection on from every read of them, as it is', async () => {
      for (const code of PASSED_ON) {
        const error = new AantjeError(code, 'The driver could not run the statement.');
        for (const [name, read] of reads(createCatalogReader(optionalFailing(error)))) {
          await expect(read(), `${code} from ${name}`).rejects.toBe(error);
        }
      }
    });

    it('reads a failed statement as "not there" and answers empty', async () => {
      const failure = new AantjeError('QUERY_FAILED', 'The catalog query failed: no such table');
      const reader = createCatalogReader(optionalFailing(failure));

      await expect(reader.partitioning(1, 1)).resolves.toBeUndefined();
      await expect(reader.sortOrder(1, 1)).resolves.toBeUndefined();
      await expect(reader.tags(1, 1)).resolves.toEqual({ table: [], columns: [] });
      await expect(reader.macros(1, 1)).resolves.toEqual([]);
      await expect(reader.storage(1)).resolves.toMatchObject({
        scheduledForDeletion: { count: 0, oldestScheduledAt: null },
      });
    });
  });

  describe('on a read that falls back to a simpler statement or looks names up', () => {
    /** Answers the statements of one read and fails those that match `fails`. */
    function failingOn(fails: RegExp, error: Error): Driver {
      return {
        query: (sql) => {
          if (fails.test(sql)) return Promise.reject(error);
          if (/FROM ducklake_snapshot_changes WHERE/.test(sql)) {
            return Promise.resolve([{ changes_made: 'inserted_into_table:1' }]);
          }
          if (/FROM ducklake_table o/.test(sql)) {
            return Promise.resolve([{ begin_snapshot: 1, object_name: 't', schema_name: 's' }]);
          }
          return Promise.resolve([]);
        },
        close: () => Promise.resolve(),
      };
    }

    const reads: [string, RegExp, (reader: ReturnType<typeof createCatalogReader>) => Promise<unknown>][] = [
      ['snapshots', /commit_extra_info/, (reader) => reader.snapshots()],
      ['snapshotChanges', /FROM ducklake_table o/, (reader) => reader.snapshotChanges(2)],
    ];

    it('passes a failure of the connection on from the first statement of every one of them, as it is', async () => {
      for (const code of PASSED_ON) {
        const error = new AantjeError(code, 'The driver could not run the statement.');
        for (const [name, fails, read] of reads) {
          await expect(
            read(createCatalogReader(failingOn(fails, error))),
            `${code} from ${name}`,
          ).rejects.toBe(error);
        }
      }
    });
  });
});

describe('a catalog reader keeps no state', () => {
  it('asks the database again for the snapshots and for the latest snapshot on every call', async () => {
    const row = (id: number): Row => ({
      snapshot_id: id,
      snapshot_time: '2026-10-29 21:22:46+00',
      changes_made: null,
    });
    const snapshots = createCatalogReader(changingDriver([row(0)], [row(1), row(0)]));
    expect((await snapshots.snapshots()).map(({ id }) => id)).toEqual([0]);
    expect((await snapshots.snapshots()).map(({ id }) => id)).toEqual([1, 0]);

    const info = createCatalogReader(
      changingDriver([{ version: '1.1', latest_snapshot: 3 }], [{ version: '1.1', latest_snapshot: 4 }]),
    );
    await expect(info.info()).resolves.toEqual({ specVersion: '1.1', latestSnapshot: 3 });
    await expect(info.info()).resolves.toEqual({ specVersion: '1.1', latestSnapshot: 4 });
  });
});

describe('closing the catalog reader', () => {
  it('resolves close() only after the driver has closed, and passes a failure while closing on', async () => {
    let closed = false;
    const slow: Driver = {
      query: () => Promise.resolve([]),
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        closed = true;
      },
    };
    await createCatalogReader(slow).close();
    expect(closed).toBe(true);

    const failing: Driver = {
      query: () => Promise.resolve([]),
      close: () => Promise.reject(new Error('socket hang up')),
    };
    await expect(createCatalogReader(failing).close()).rejects.toThrow('socket hang up');
  });

  it('closes the connection of the driver', async () => {
    const driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
    const reader = createCatalogReader(driver);
    await expect(reader.info()).resolves.toMatchObject({ specVersion: '1.1' });

    await reader.close();

    await expect(driver.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
});
