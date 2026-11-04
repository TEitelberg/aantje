import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewTable } from '../../src/data/engine';
import type { GridData, GridValue } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { HISTORY_ROWS } from '../support/expected-history';
import { accessFor, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`History data tests are skipped: ${skipReason}`);
}

describe.skipIf(skipReason)('the history fixture read by the data engine', () => {
  const fixtures = new Map<'sqlite' | 'duckdb', DataFixture>();

  beforeAll(async () => {
    for (const kind of ['sqlite', 'duckdb'] as const) {
      fixtures.set(kind, await copyHistoryFixture(kind));
    }
  });
  afterAll(async () => {
    await Promise.all([...fixtures.values()].map((fixture) => fixture.remove()));
  });

  describe.each(['sqlite', 'duckdb'] as const)('%s metadata', (kind) => {
    const fixture = (): DataFixture => fixtures.get(kind) as DataFixture;
    // Every read opens its own engine (about 150 ms, most of it loading the extensions): the lake is read-only, so a
    // relation at a snapshot is read once, and the reads of a test run at the same time.
    const reads = new Map<string, Promise<GridData>>();
    const readAt = (schema: string, table: string, snapshot: number): Promise<GridData> => {
      const key = `${schema}.${table}@${snapshot}`;
      let read = reads.get(key);
      if (!read) {
        read = previewTable(accessFor(fixture(), { snapshot }), { schema, table });
        // Awaited by the test that asks for it; the rejection of a dropped table is expected there.
        read.catch(() => undefined);
        reads.set(key, read);
      }
      return read;
    };
    const rowsAt = async (
      schema: string,
      table: string,
      snapshot: number,
    ): Promise<readonly (readonly GridValue[])[]> => (await readAt(schema, table, snapshot)).rows;
    const countsAt = async (schema: string, table: string, expected: Readonly<Record<number, number>>) => {
      const counted = await Promise.all(
        Object.keys(expected).map(async (snapshot) => [
          snapshot,
          (await rowsAt(schema, table, Number(snapshot))).length,
        ]),
      );
      expect(Object.fromEntries(counted), `rows of ${table} per snapshot`).toEqual(expected);
    };

    // Seven reads of a partitioned table: well under a second at once, but more than the default limit while the whole
    // suite loads the machine.
    it('reads the partitioned events table at every snapshot that added rows', async () => {
      await countsAt('shop', 'events', HISTORY_ROWS.eventsAt);
    }, 120_000);

    it('reads the rows of a table as they were at each snapshot: after an update and a delete', async () => {
      await countsAt('shop', 'customers', HISTORY_ROWS.customersAt);
      const bob = (rows: readonly (readonly GridValue[])[]): readonly GridValue[] | undefined =>
        rows.find((row) => row[0] === 2);
      expect(bob(await rowsAt('shop', 'customers', 16))).toEqual([2, 'bob', 'bronze']);
      expect(bob(await rowsAt('shop', 'customers', 17))).toEqual([2, 'bob', 'gold']);
      expect((await rowsAt('shop', 'customers', 17)).map((row) => row[0])).toContain(4);
      expect((await rowsAt('shop', 'customers', 18)).map((row) => row[0])).not.toContain(4);
    });

    it('reads the rows of a table that is inlined in the catalog without a Parquet file at each snapshot', async () => {
      await countsAt('shop', 'notes', HISTORY_ROWS.notesAt);
      const files = await readdir(join(fixture().directory, `${kind}-files`, 'shop', 'notes')).catch(
        () => [],
      );
      expect(files).toEqual([]);
      expect(await rowsAt('shop', 'notes', 20)).toEqual([
        [1, 'first'],
        [2, 'second'],
        [3, 'third'],
      ]);
      expect(await rowsAt('shop', 'notes', 21)).toEqual([
        [1, 'changed'],
        [2, 'second'],
        [3, 'third'],
      ]);
      expect(await rowsAt('shop', 'notes', 22)).toEqual([
        [1, 'changed'],
        [2, 'second'],
      ]);
    });

    it('reads the rows of a table as they were before and after a compaction', async () => {
      await countsAt('shop', 'log', HISTORY_ROWS.logAt);
      const before = await rowsAt('shop', 'log', 54);
      expect(before).toEqual([
        [1, 'line 1'],
        [2, 'line 2'],
        [3, 'line 3'],
        [4, 'line 4'],
      ]);
      expect(await rowsAt('shop', 'log', 55)).toEqual(before);
    });

    it('follows the schema evolution of the renamed table: columns and types differ per snapshot', async () => {
      const columns = async (table: string, snapshot: number): Promise<string[]> =>
        (await readAt('main', table, snapshot)).columns.map((column) => `${column.name} ${column.type}`);
      await Promise.all([
        ...[27, 29, 30, 31, 32].map((snapshot) => readAt('main', 'evolving', snapshot)),
        readAt('main', 'evolved', 36),
      ]);

      expect(await columns('evolving', 27)).toEqual([
        'id INTEGER',
        'name VARCHAR',
        'info STRUCT("a" INTEGER, "b" VARCHAR)',
        'n INTEGER',
      ]);
      expect(await columns('evolving', 29)).toContain('title VARCHAR');
      expect(await columns('evolving', 30)).toContain('n BIGINT');
      expect(await columns('evolving', 31)).not.toContain('extra DOUBLE');
      expect(await columns('evolving', 32)).toContain('info STRUCT("a" INTEGER, "b" VARCHAR, "c" DOUBLE)');
      expect(await columns('evolved', 36)).toEqual([
        'id INTEGER',
        'title VARCHAR',
        'info STRUCT("a" INTEGER, "b" VARCHAR, "c" DOUBLE)',
        'n BIGINT',
        'flag BOOLEAN',
      ]);
      expect(await rowsAt('main', 'evolved', 36)).toEqual([
        [1, 'one', '{"a":1,"b":"x","c":null}', '10', false],
        [2, 'two', '{"a":2,"b":"y","c":2.5}', '20', false],
      ]);
    });

    it('reads a dropped table up to the snapshot before the drop and not after it', async () => {
      const [rows, error] = await Promise.all([
        rowsAt('shop', 'old_stuff', 44),
        readAt('shop', 'old_stuff', 45).then(
          () => undefined,
          (e: unknown) => e,
        ),
      ]);

      expect(rows).toEqual([[1], [2]]);

      expect(error).toBeInstanceOf(AantjeError);
      expect((error as AantjeError).code).toBe('QUERY_FAILED');
    });
  });
});
