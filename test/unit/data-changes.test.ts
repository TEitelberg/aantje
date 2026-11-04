import { readdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readChanges } from '../../src/data/engine';
import type { ChangesResult } from '../../src/data/engine';
import type { GridValue, TableRef } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { accessFor, createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture, Lake } from './data-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Change feed tests are skipped: ${skipReason}`);
}

const customers = { schema: 'shop', table: 'customers' };
const FEED_COLUMNS = ['snapshot_id', 'rowid', 'change_type'];

async function failure(call: Promise<unknown>): Promise<AantjeError> {
  const error = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

/** Counts what the engine does to the real DuckDB classes, to prove that nothing is left open. */
function watchEngine(): { counts: () => Record<string, number>; closed: () => Promise<void> } {
  const instances = vi.spyOn(DuckDBInstance, 'create');
  const instanceCloses = vi.spyOn(DuckDBInstance.prototype, 'closeSync');
  const connections = vi.spyOn(DuckDBInstance.prototype, 'connect');
  const connectionCloses = vi.spyOn(DuckDBConnection.prototype, 'closeSync');
  const counts = (): Record<string, number> => ({
    instances: instances.mock.calls.length,
    instanceCloses: instanceCloses.mock.calls.length,
    connections: connections.mock.calls.length,
    connectionCloses: connectionCloses.mock.calls.length,
  });
  return {
    counts,
    closed: () =>
      vi.waitFor(
        () =>
          expect(counts()).toEqual({ instances: 1, instanceCloses: 1, connections: 1, connectionCloses: 1 }),
        { timeout: 15_000, interval: 50 },
      ),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const NOTHING_OPEN = { instances: 0, instanceCloses: 0, connections: 0, connectionCloses: 0 };
const ONCE = { instances: 1, instanceCloses: 1, connections: 1, connectionCloses: 1 };

/** Runs `use` on a temporary DuckLake that is removed afterwards. */
async function withLake<T>(statements: string[], use: (lake: Lake) => Promise<T>): Promise<T> {
  const lake = await createLake(statements);
  try {
    return await use(lake);
  } finally {
    await lake.remove();
  }
}

const feedOf = (
  lake: Lake,
  table: TableRef,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<ChangesResult> =>
  readChanges({ profile: lake.profile, s3: {}, extensionDirectory }, table, { from, to }, signal);

describe.skipIf(skipReason)('readChanges on the history fixture', () => {
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
    const changes = (
      table: TableRef,
      from: number,
      to: number,
      signal?: AbortSignal,
    ): Promise<ChangesResult> => readChanges(accessFor(fixture()), table, { from, to }, signal);

    it('returns the insert, the update pair and the delete of shop.customers with kinds and summary, and maps "since @A until @B" to the changes after A', async () => {
      const { data, summary } = await changes(customers, 15, 18);

      expect(data.columns.map(({ name }) => name)).toEqual([...FEED_COLUMNS, 'id', 'name', 'tier']);
      expect(data.columns.map(({ type }) => type)).toEqual([
        'BIGINT',
        'BIGINT',
        'VARCHAR',
        'INTEGER',
        'VARCHAR',
        'VARCHAR',
      ]);
      expect(data.rows).toEqual([
        ['16', '0', 'insert', 1, 'ada', 'bronze'],
        ['16', '1', 'insert', 2, 'bob', 'bronze'],
        ['16', '2', 'insert', 3, 'cy', 'silver'],
        ['16', '3', 'insert', 4, 'di', 'silver'],
        ['17', '1', 'update_preimage', 2, 'bob', 'bronze'],
        ['17', '1', 'update_postimage', 2, 'bob', 'gold'],
        ['18', '3', 'delete', 4, 'di', 'silver'],
      ]);
      expect(data.rowKinds).toEqual([
        'insert',
        'insert',
        'insert',
        'insert',
        'update-before',
        'update-after',
        'delete',
      ]);
      expect(data).toMatchObject({ table: customers, limit: 1000, truncated: false });
      expect(summary).toEqual({
        from: 15,
        to: 18,
        counts: { insert: 4, update: 1, delete: 1 },
        total: 6,
        unknown: 0,
        snapshots: [
          { snapshot: 16, insert: 4, update: 0, delete: 0 },
          { snapshot: 17, insert: 0, update: 1, delete: 0 },
          { snapshot: 18, insert: 0, update: 0, delete: 1 },
        ],
        truncated: false,
      });

      // The snapshot A itself is not part of the range.
      expect((await changes(customers, 15, 16)).summary.counts).toEqual({ insert: 4, update: 0, delete: 0 });
      expect((await changes(customers, 16, 18)).summary.counts).toEqual({ insert: 0, update: 1, delete: 1 });
      expect((await changes(customers, 16, 17)).data.rows.map((row) => row[2])).toEqual([
        'update_preimage',
        'update_postimage',
      ]);
      expect((await changes(customers, 17, 18)).data.rows).toEqual([
        ['18', '3', 'delete', 4, 'di', 'silver'],
      ]);
      // A range that starts before the table existed, and a range without changes.
      expect((await changes(customers, 1, 18)).summary.counts).toEqual({ insert: 4, update: 1, delete: 1 });
      const quiet = await changes(customers, 18, 22);
      expect(quiet.data.columns.map(({ name }) => name)).toEqual([...FEED_COLUMNS, 'id', 'name', 'tier']);
      expect(quiet.data.rows).toEqual([]);
      expect(quiet.data.rowKinds).toEqual([]);
      expect(quiet.summary).toEqual({
        from: 18,
        to: 22,
        counts: { insert: 0, update: 0, delete: 0 },
        total: 0,
        unknown: 0,
        snapshots: [],
        truncated: false,
      });

      // Two tables that one transaction changed (snapshot 23) are two separate reads.
      const customer = await changes(customers, 22, 23);
      const event = await changes({ schema: 'shop', table: 'events' }, 22, 23);
      expect(customer.data.rows).toEqual([['23', '5', 'insert', 5, 'eve', 'silver']]);
      expect(event.data.rows).toEqual([['23', '51', 'insert', 12, 'view', '2026-04-02 10:00:00', '12.50']]);
      expect(customer.summary.snapshots).toEqual([{ snapshot: 23, insert: 1, update: 0, delete: 0 }]);

      // A row of a change type it does not know (a newer DuckLake) is left out and counted, instead of failing.
      // `table_changes` computes its types, so the test edits the feed that the statements read: ada's insert (row id
      // 0) becomes an "upsert".
      // eslint-disable-next-line @typescript-eslint/unbound-method -- applied to the connection below
      const runAndReadAll = DuckDBConnection.prototype.runAndReadAll;
      vi.spyOn(DuckDBConnection.prototype, 'runAndReadAll').mockImplementation(function (
        this: DuckDBConnection,
        sql,
        values,
        types,
      ) {
        const edited = sql.replaceAll(
          /lake\."shop"\.table_changes\('customers', \d+, \d+\)/g,
          (feed) =>
            `(SELECT * REPLACE (CASE WHEN rowid = 0 THEN 'upsert' ELSE change_type END AS change_type) FROM ${feed})`,
        );
        return runAndReadAll.call(this, edited, values, types);
      });
      const unknown = await changes(customers, 15, 18);
      expect(unknown.data.rows.map((row) => row[1])).toEqual(['1', '2', '3', '1', '1', '3']);
      expect(unknown.summary).toMatchObject({
        counts: { insert: 3, update: 1, delete: 1 },
        total: 5,
        unknown: 1,
        snapshots: [
          { snapshot: 16, insert: 3, update: 0, delete: 0 },
          { snapshot: 17, insert: 0, update: 1, delete: 0 },
          { snapshot: 18, insert: 0, update: 0, delete: 1 },
        ],
      });
      vi.restoreAllMocks();

      // The time of the read is reported in whole milliseconds, both queries included.
      let calls = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => (calls++ === 0 ? 1000 : 1015.4));
      expect((await changes(customers, 15, 18)).data.elapsedMs).toBe(15);
    });

    it('reads partitioned, inlined, evolving and compacted tables with exact rows', async () => {
      const events = await changes({ schema: 'shop', table: 'events' }, 5, 10);
      expect(events.data.rows).toHaveLength(51);
      expect(new Set(events.data.rowKinds)).toEqual(new Set(['insert']));
      expect(events.summary.snapshots).toEqual([
        { snapshot: 6, insert: 6, update: 0, delete: 0 },
        { snapshot: 7, insert: 1, update: 0, delete: 0 },
        { snapshot: 8, insert: 40, update: 0, delete: 0 },
        { snapshot: 10, insert: 4, update: 0, delete: 0 },
      ]);
      expect(events.data.rows.slice(0, 2)).toEqual([
        ['6', '0', 'insert', 1, 'click', '2025-03-01 10:00:00', '1.50'],
        ['6', '1', 'insert', 2, 'click', '2025-03-02 10:00:00', '2.50'],
      ]);
      // Within a snapshot the rows come in row id order, not in the order of the files (partitions).
      expect(events.data.rows.slice(-4).map((row) => [row[1], row[3]])).toEqual([
        ['47', 8],
        ['48', 9],
        ['49', 11],
        ['50', 10],
      ]);
      // The change of the partitioning itself is no row.
      expect(await changes({ schema: 'shop', table: 'events' }, 8, 9)).toMatchObject({
        data: { rows: [] },
        summary: { total: 0, snapshots: [] },
      });

      // Rows that DuckLake keeps inlined in the catalog: insert, update pair and delete.
      const notes = await changes({ schema: 'shop', table: 'notes' }, 19, 22);
      expect(notes.data.rows).toEqual([
        ['20', '0', 'insert', 1, 'first'],
        ['20', '1', 'insert', 2, 'second'],
        ['20', '2', 'insert', 3, 'third'],
        ['21', '0', 'update_preimage', 1, 'first'],
        ['21', '0', 'update_postimage', 1, 'changed'],
        ['22', '2', 'delete', 3, 'third'],
      ]);
      expect(notes.summary.counts).toEqual({ insert: 3, update: 1, delete: 1 });

      // The snapshot that created and filled a table.
      const audit = await changes({ schema: 'shop', table: 'audit' }, 23, 24);
      expect(audit.data.rows).toEqual([['24', '0', 'insert', 1, 'created together with its first row']]);

      // A column that was added later is NULL (or its default) for the earlier changes; the table is named as it
      // is at the end of the range.
      const early = await changes({ schema: 'main', table: 'evolving' }, 26, 30);
      const renamed = await changes({ schema: 'main', table: 'evolved' }, 26, 36);
      expect(early.data.columns.map(({ name }) => name)).toEqual([
        ...FEED_COLUMNS,
        'id',
        'title',
        'info',
        'n',
        'extra',
      ]);
      expect(early.data.rows).toEqual([['27', '0', 'insert', 1, 'one', '{"a":1,"b":"x"}', '10', null]]);
      expect(renamed.data.columns.map(({ name }) => name)).toEqual([
        ...FEED_COLUMNS,
        'id',
        'title',
        'info',
        'n',
        'flag',
      ]);
      // The column flag has the default false, which DuckLake gives to the row of snapshot 27 that was written before it.
      expect(renamed.data.rows).toEqual([
        ['27', '0', 'insert', 1, 'one', '{"a":1,"b":"x","c":null}', '10', false],
        ['36', '1', 'insert', 2, 'two', '{"a":2,"b":"y","c":2.5}', '20', false],
      ]);

      // The rows of a compacted table keep their original snapshots.
      const log = await changes({ schema: 'shop', table: 'log' }, 50, 56);
      expect(log.data.rows.map((row) => [row[0], row[3]])).toEqual([
        ['51', 1],
        ['52', 2],
        ['53', 3],
        ['54', 4],
        ['56', 5],
      ]);
      expect(log.summary.snapshots.map(({ snapshot }) => snapshot)).toEqual([51, 52, 53, 54, 56]);
      expect((await changes({ schema: 'shop', table: 'log' }, 54, 55)).summary.total).toBe(0);
    });
  });

  describe('errors, cancellation and secrets', () => {
    const fixture = (): DataFixture => fixtures.get('sqlite') as DataFixture;
    const changes = (
      table: TableRef,
      from: number,
      to: number,
      signal?: AbortSignal,
    ): Promise<ChangesResult> => readChanges(accessFor(fixture()), table, { from, to }, signal);

    it('rejects an invalid range before it reads anything, and names a missing snapshot, a missing table and a view', async () => {
      for (const [name, from, to] of [
        ['the same snapshot twice', 17, 17],
        ['a start after the end', 18, 17],
        ['a negative start', -1, 5],
        ['a fraction', 16.5, 18],
        ['an end that is a fraction', 16, 17.5],
      ] as const) {
        vi.restoreAllMocks();
        const watch = watchEngine();
        const error = await failure(changes(customers, from, to));
        expect(error.code, name).toBe('QUERY_FAILED');
        expect(watch.counts(), name).toEqual(NOTHING_OPEN);
      }

      const beyond = await failure(changes(customers, 17, 99));
      expect(beyond.code).toBe('QUERY_FAILED');
      expect(beyond.userMessage).toContain('@99');

      const dropped = await failure(changes({ schema: 'shop', table: 'old_stuff' }, 43, 45));
      expect(dropped.userMessage).toContain('"shop.old_stuff"');
      expect(dropped.userMessage).toContain('@45');
      const early = await failure(changes({ schema: 'shop', table: 'customers' }, 1, 4));
      expect(early.userMessage).toContain('"shop.customers"');
      // A view has no changes; DuckLake says so and the message keeps it.
      const view = await failure(changes({ schema: 'shop', table: 'big_events' }, 38, 40));
      expect(view.userMessage).toContain('"big_events"');
      // The last snapshot before the drop still has the changes.
      expect((await changes({ schema: 'shop', table: 'old_stuff' }, 43, 44)).summary.counts.insert).toBe(2);
    });

    it('is released at once and closes the engine when the time limit passes or the user cancels, and after a read or a failure', async () => {
      const timedOutWatch = watchEngine();
      const timedOut = await failure(
        readChanges(accessFor(fixture(), { timeoutMs: 1 }), customers, { from: 15, to: 18 }),
      );
      await timedOutWatch.closed();
      expect(timedOut.code).toBe('TIMEOUT');
      vi.restoreAllMocks();

      const watch = watchEngine();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1);
      const aborted = await failure(changes(customers, 15, 18, controller.signal));
      await watch.closed();
      expect(aborted.code).toBe('ABORTED');
      vi.restoreAllMocks();

      const none = watchEngine();
      expect((await failure(changes(customers, 15, 18, AbortSignal.abort()))).code).toBe('ABORTED');
      expect(none.counts()).toEqual(NOTHING_OPEN);
      vi.restoreAllMocks();

      const ok = watchEngine();
      await changes(customers, 15, 18);
      expect(ok.counts()).toEqual(ONCE);
      vi.restoreAllMocks();

      const failed = watchEngine();
      await failure(changes(customers, 17, 99));
      expect(failed.counts()).toEqual(ONCE);
    });

    it('keeps the S3 secrets out of the error of a failed read', async () => {
      const copy = await copyHistoryFixture('sqlite');
      try {
        const files = join(copy.directory, 'sqlite-files', 'shop', 'customers');
        for (const name of await readdir(files)) {
          await rm(join(files, name));
        }
        // The message of the missing file quotes its path: a key id that is part of the path makes it a canary.
        const keyId = basename(copy.directory);

        const plain = await failure(readChanges(accessFor(copy), customers, { from: 15, to: 18 }));
        expect(plain.userMessage).toContain(keyId);
        const error = await failure(
          readChanges(accessFor(copy, { s3Credentials: { keyId, secretKey: 'customers' } }), customers, {
            from: 15,
            to: 18,
          }),
        );

        for (const text of [error.userMessage, (error.cause as Error).message]) {
          expect(text).not.toContain(keyId);
          expect(text).toContain('***');
        }
      } finally {
        await copy.remove();
      }
    });
  });
});

describe.skipIf(skipReason)('readChanges on a lake that is written by the test', () => {
  const rowsOf = (data: ChangesResult['data']): GridValue[][] => data.rows.map((row) => [...row]);
  const big = { schema: 'main', table: 'big' };

  it('cuts the rows at 1000, still counts every change, and never splits an update pair', async () => {
    // 1500 rows: cut at 1000, every change counted.
    await withLake(
      ['CREATE TABLE big (n INTEGER)', 'INSERT INTO big SELECT range FROM range(1500)'],
      async (lake) => {
        const { data, summary } = await feedOf(lake, big, 1, 2);
        expect(data.rows).toHaveLength(1000);
        expect(data.rowKinds).toHaveLength(1000);
        expect(data.truncated).toBe(true);
        expect(data.rows[999]?.[3]).toBe(999);
        expect(summary).toMatchObject({ counts: { insert: 1500 }, total: 1500, truncated: true });
        expect(data.summary).toContain('1000 of 1500');
      },
    );
    // Exactly 1000 rows: not truncated.
    await withLake(
      ['CREATE TABLE big (n INTEGER)', 'INSERT INTO big SELECT range FROM range(1000)'],
      async (lake) => {
        const { data, summary } = await feedOf(lake, big, 1, 2);
        expect(data.rows).toHaveLength(1000);
        expect([data.truncated, summary.truncated]).toEqual([false, false]);
      },
    );
    // The pair straddles the limit: the grid holds 999 rows.
    await withLake(
      [
        'CREATE TABLE big (n INTEGER, label VARCHAR)',
        "INSERT INTO big SELECT range, 'a' FROM range(999)",
        "UPDATE big SET label = 'b' WHERE n = 5",
      ],
      async (lake) => {
        const { data, summary } = await feedOf(lake, big, 1, 3);
        expect(data.rows).toHaveLength(999);
        expect(new Set(data.rowKinds)).toEqual(new Set(['insert']));
        expect(data.truncated).toBe(true);
        expect(summary.counts).toEqual({ insert: 999, update: 1, delete: 0 });
        expect(data.summary).toContain('999 of 1001');
      },
    );
    // The limit falls behind the pair: the pair stays together.
    await withLake(
      [
        'CREATE TABLE big (n INTEGER, label VARCHAR)',
        "INSERT INTO big SELECT range, 'a' FROM range(998)",
        "UPDATE big SET label = 'b' WHERE n = 5",
        "INSERT INTO big SELECT range + 1000, 'c' FROM range(10)",
      ],
      async (lake) => {
        const { data } = await feedOf(lake, big, 1, 4);
        expect(data.rowKinds?.slice(998, 1000)).toEqual(['update-before', 'update-after']);
        expect(data.rows).toHaveLength(1000);
      },
    );
  });

  it('copes with expired snapshots in between and with data files that were rewritten', async () => {
    // Snapshots: 0 schema, 1 table, 2 to 5 one insert each. Snapshot 3 expires, so 0, 1, 2, 4 and 5 are left.
    await withLake(
      [
        'CREATE TABLE t (n INTEGER)',
        'INSERT INTO t VALUES (2)',
        'INSERT INTO t VALUES (3)',
        'INSERT INTO t VALUES (4)',
        'INSERT INTO t VALUES (5)',
        "CALL ducklake_expire_snapshots('lake', versions => [3])",
      ],
      async (lake) => {
        const t = { schema: 'main', table: 't' };
        const afterTheGap = await feedOf(lake, t, 2, 5);
        const toTheGap = await feedOf(lake, t, 2, 4);
        expect(afterTheGap.data.rows.map((row) => [row[0], row[3]])).toEqual([
          ['4', 4],
          ['5', 5],
        ]);
        expect(toTheGap.data.rows.map((row) => [row[0], row[3]])).toEqual([['4', 4]]);
        expect(toTheGap.summary).toMatchObject({ from: 2, to: 4, total: 1 });
        // The changes of an expired snapshot inside the range are still listed.
        expect((await feedOf(lake, t, 1, 5)).summary.snapshots.map(({ snapshot }) => snapshot)).toEqual([
          2, 3, 4, 5,
        ]);
        // The expired snapshot as the end does not exist.
        const error = await failure(feedOf(lake, t, 2, 3));
        expect(error.code).toBe('QUERY_FAILED');
        expect(error.userMessage).toContain('@3');
      },
    );

    // Snapshot 3 deletes one row of a file, 4 changes another one, 5 rewrites the file: every row that survived is
    // written again under its old row id, which table_changes reports as an update that changes nothing.
    await withLake(
      [
        'CREATE TABLE t (id INTEGER, label VARCHAR, ratio DOUBLE, attrs MAP(VARCHAR, INTEGER), customer STRUCT(a INTEGER, b VARCHAR[]))',
        `INSERT INTO t VALUES
           (1, 'a', 1.5, MAP {'x': 1}, {'a': 1, 'b': ['q', NULL]}),
           (2, 'b', NULL, MAP {}, NULL),
           (3, 'c', 'NaN', NULL, {'a': NULL, 'b': NULL}),
           (4, 'd', 2, MAP {'k': NULL}, {'a': 4, 'b': []})`,
        'DELETE FROM t WHERE id = 1',
        "UPDATE t SET label = 'B' WHERE id = 2",
        "CALL ducklake_rewrite_data_files('lake', 't', delete_threshold => 0.0)",
      ],
      async (lake) => {
        const t = { schema: 'main', table: 't' };
        // No change for the snapshot that rewrote the files, whatever the values are (NULL, NaN, nested).
        const rewrite = await feedOf(lake, t, 4, 5);
        expect(rewrite.data.rows).toEqual([]);
        expect(rewrite.summary.total).toBe(0);

        const { data, summary } = await feedOf(lake, t, 1, 5);
        expect(data.rows.map((row) => [row[0], row[2], row[3], row[4]])).toEqual([
          ['2', 'insert', 1, 'a'],
          ['2', 'insert', 2, 'b'],
          ['2', 'insert', 3, 'c'],
          ['2', 'insert', 4, 'd'],
          ['3', 'delete', 1, 'a'],
          ['4', 'update_preimage', 2, 'b'],
          ['4', 'update_postimage', 2, 'B'],
        ]);
        expect(summary.counts).toEqual({ insert: 4, update: 1, delete: 1 });
        expect(summary.snapshots.map(({ snapshot }) => snapshot)).toEqual([2, 3, 4]);
      },
    );
  });

  it('reads feeds of awkward tables: created and filled at @0, identical rows, clashing column names, hostile names', async () => {
    await withLake(['CREATE TABLE t AS SELECT 1 AS n'], async (lake) => {
      const { data, summary } = await feedOf(lake, { schema: 'main', table: 't' }, 0, 1);
      expect(data.rows).toEqual([['1', '0', 'insert', 1]]);
      expect(summary.counts).toEqual({ insert: 1, update: 0, delete: 0 });
    });

    // Rows that hold the same values are told apart by their row ids only.
    await withLake(
      ['CREATE TABLE twins (v VARCHAR)', "INSERT INTO twins VALUES ('a'), ('a')", "UPDATE twins SET v = 'b'"],
      async (lake) => {
        const { data, summary } = await feedOf(lake, { schema: 'main', table: 'twins' }, 2, 3);
        expect(data.rows.map((row) => [row[1], row[2], row[3]])).toEqual([
          ['0', 'update_preimage', 'a'],
          ['0', 'update_postimage', 'b'],
          ['1', 'update_preimage', 'a'],
          ['1', 'update_postimage', 'b'],
        ]);
        expect(summary.counts.update).toBe(2);
      },
    );

    // The feed columns stay first when the table has columns of the same names, which DuckDB renames.
    await withLake(
      [
        'CREATE TABLE t (rowid INTEGER, change_type VARCHAR, snapshot_id INTEGER)',
        "INSERT INTO t VALUES (7, 'x', 9)",
      ],
      async (lake) => {
        const { data } = await feedOf(lake, { schema: 'main', table: 't' }, 1, 2);
        expect(data.columns.map(({ name }) => name)).toEqual([
          'snapshot_id',
          'rowid',
          'change_type',
          'rowid_1',
          'change_type_1',
          'snapshot_id_1',
        ]);
        expect(rowsOf(data)).toEqual([['2', '0', 'insert', 7, 'x', 9]]);
        expect(data.rowKinds).toEqual(['insert']);
      },
    );

    // Columns that clash in another case or need quoting, with the real update kept.
    await withLake(
      [
        'CREATE TABLE t ("Rowid" INTEGER, "Snapshot_ID" VARCHAR, "CHANGE_TYPE" INTEGER, "a b" INTEGER, "a b " INTEGER)',
        "INSERT INTO t VALUES (1, 'x', 2, 3, 4)",
        'UPDATE t SET "a b" = 9',
      ],
      async (lake) => {
        const { data, summary } = await feedOf(lake, { schema: 'main', table: 't' }, 2, 3);
        expect(data.columns.map(({ name }) => name)).toEqual([
          'snapshot_id',
          'rowid',
          'change_type',
          'Rowid_1',
          'Snapshot_ID_1',
          'CHANGE_TYPE_1',
          'a b',
          'a b ',
        ]);
        expect(rowsOf(data)).toEqual([
          ['3', '0', 'update_preimage', 1, 'x', 2, 3, 4],
          ['3', '0', 'update_postimage', 1, 'x', 2, 9, 4],
        ]);
        expect(summary.counts.update).toBe(1);
      },
    );

    // A schema and a name that need quoting, and hostile text shown as it is.
    await withLake(
      [
        'CREATE SCHEMA "my schema"',
        `CREATE TABLE "my schema"."it's ""odd"""(a VARCHAR)`,
        `INSERT INTO "my schema"."it's ""odd""" VALUES ('<script>alert(1)</script>'), ('x''; DROP TABLE y; --')`,
      ],
      async (lake) => {
        const { data } = await feedOf(lake, { schema: 'my schema', table: 'it\'s "odd"' }, 2, 3);
        expect(rowsOf(data)).toEqual([
          ['3', '0', 'insert', '<script>alert(1)</script>'],
          ['3', '1', 'insert', "x'; DROP TABLE y; --"],
        ]);
      },
    );
  });
});
