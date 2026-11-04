import { describe, expect, it } from 'vitest';
import { growthModelOf, seriesOf } from '../../src/growth/model';
import type { Step } from '../../src/growth/model';
import { readGrowth } from '../../src/growth/read';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

describe.each(backends)('the growth of a lake written by a real DuckLake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
    const run = async (lake: BackendLake, sql: string): Promise<void> =>
      void (await lake.connection.run(sql));
    const count = async (lake: BackendLake, sql: string): Promise<number> =>
      Number((await lake.connection.runAndReadAll(sql)).getRowsJson()[0]?.[0]);

    /** The rows of a table at a snapshot as DuckDB itself counts them with time travel; undefined where the table does not exist. */
    async function rowsAt(lake: BackendLake, snapshot: number, table = 't'): Promise<number | undefined> {
      try {
        return await count(lake, `SELECT count(*) FROM ${table} AT (VERSION => ${snapshot})`);
      } catch {
        return undefined;
      }
    }

    /** The steps of the whole lake, read with the real reader after everything was written. */
    async function stepsOf(lake: BackendLake): Promise<Step[]> {
      const reader = await lake.reader();
      try {
        const data = await readGrowth(reader, 'lake', null);
        return seriesOf(data, growthModelOf(data), undefined);
      } finally {
        await reader.close();
      }
    }

    /** `[snapshot, rows]` of every snapshot after which `t` exists. */
    const rowsOf = (steps: readonly Step[]): number[][] => steps.map((step) => [step.id, step.total.rows]);

    /** A fresh lake that is removed when the scenario is done. */
    async function scenario(statements: readonly string[]): Promise<{ lake: BackendLake; steps: Step[] }> {
      const lake = await backend.create();
      try {
        for (const sql of statements) {
          await run(lake, sql);
        }
        return { lake, steps: await stepsOf(lake) };
      } catch (error) {
        await lake.remove();
        throw error;
      }
    }

    /** Every step that is not marked approximate has the rows that DuckDB's time travel counts. */
    async function expectExact(lake: BackendLake, steps: readonly Step[], tables = ['t']): Promise<void> {
      for (const step of steps) {
        if (step.approximate) {
          continue;
        }
        let truth = 0;
        for (const table of tables) {
          truth = (await rowsAt(lake, step.id, table)) ?? truth;
        }
        expect(step.total.rows, `snapshot ${step.id}`).toBe(truth);
      }
    }

    it('counts the rows that time travel counts at every snapshot: inlined rows, files, delete files, an update, a flush, a merge and expired snapshots', async () => {
      // Up to 3 rows are inlined. A delete of more than 3 rows from a file writes a delete file.
      const counted = await scenario([
        "CALL lake.set_option('data_inlining_row_limit', 3)",
        'CREATE TABLE t (id INTEGER, v VARCHAR)',
        "INSERT INTO t SELECT i, 'a' FROM range(3) r(i)",
        "INSERT INTO t SELECT i, 'b' FROM range(3, 5) r(i)",
        'DELETE FROM t WHERE id = 1',
        "INSERT INTO t SELECT i, 'c' FROM range(100, 130) r(i)",
        'DELETE FROM t WHERE id >= 120',
        "UPDATE t SET v = 'changed' WHERE id = 2",
        "INSERT INTO t SELECT i, 'd' FROM range(200, 204) r(i)",
      ]);
      try {
        expect(counted.steps).toHaveLength(9);
        expect(counted.steps.map((step) => step.approximate)).toEqual(counted.steps.map(() => false));
        await expectExact(counted.lake, counted.steps);
        // 3 inlined, 5, 4 after the delete, 34 with the file, 24 after its delete file, 24 after the update, 28.
        expect(rowsOf(counted.steps).map(([, rows]) => rows)).toEqual([0, 0, 3, 5, 4, 34, 24, 24, 28]);
      } finally {
        await counted.lake.remove();
      }

      // Snapshots before a flush of inlined data and a merge of files are not exact; every value that is not marked is.
      const flushed = await scenario([
        "CALL lake.set_option('data_inlining_row_limit', 10)",
        'CREATE TABLE t (id INTEGER, v VARCHAR)',
        "INSERT INTO t SELECT i, 'a' FROM range(3) r(i)",
        "INSERT INTO t SELECT i, 'b' FROM range(3, 5) r(i)",
        'DELETE FROM t WHERE id = 1',
        "CALL ducklake_flush_inlined_data('lake')",
        "CALL lake.set_option('data_inlining_row_limit', 0)",
        ...['x', 'y', 'z'].map((batch) => `INSERT INTO t VALUES (${batch.charCodeAt(0)}, '${batch}')`),
        "CALL ducklake_merge_adjacent_files('lake')",
        "INSERT INTO t VALUES (500, 'last')",
      ]);
      try {
        expect(flushed.steps.some((step) => step.approximate)).toBe(true);
        expect(flushed.steps.some((step) => !step.approximate && step.id > 0)).toBe(true);
        await expectExact(flushed.lake, flushed.steps);
        // The newest state is always exact.
        const last = flushed.steps.at(-1);
        expect([last?.approximate, last?.total.rows]).toEqual([
          false,
          await rowsAt(flushed.lake, last?.id ?? 0),
        ]);
      } finally {
        await flushed.lake.remove();
      }

      // The state of expired snapshots shows in the first snapshot that is left.
      const expired = await scenario([
        "CALL lake.set_option('data_inlining_row_limit', 3)",
        'CREATE TABLE t (id INTEGER, v VARCHAR)',
        "INSERT INTO t SELECT i, 'a' FROM range(3) r(i)",
        "INSERT INTO t SELECT i, 'b' FROM range(3, 5) r(i)",
        "INSERT INTO t SELECT i, 'c' FROM range(100, 130) r(i)",
        'DELETE FROM t WHERE id >= 120',
        "INSERT INTO t SELECT i, 'd' FROM range(200, 204) r(i)",
        "CALL ducklake_expire_snapshots('lake', versions => [2, 3])",
      ]);
      try {
        expect(expired.steps.map((step) => step.id)).toEqual([0, 1, 4, 5, 6]);
        expect(expired.steps.map((step) => step.approximate)).toEqual([false, false, false, false, false]);
        await expectExact(expired.lake, expired.steps);
        // What snapshots 2 and 3 inserted shows at 4, which is the next snapshot that is left.
        expect(expired.steps.find((step) => step.id === 4)?.delta.rows).toBe(35);
      } finally {
        await expired.lake.remove();
      }
    }, 300_000);

    it('gives back the rows of dropped tables and renamed tables, and marks the delete file that collects the deletes of two snapshots', async () => {
      const dropped = await scenario([
        "CALL lake.set_option('data_inlining_row_limit', 3)",
        'CREATE TABLE t (id INTEGER, v VARCHAR)',
        "INSERT INTO t SELECT i, 'c' FROM range(100, 130) r(i)",
        'DELETE FROM t WHERE id >= 120',
        'DELETE FROM t WHERE id BETWEEN 100 AND 104',
        'DROP TABLE t',
      ]);
      try {
        // The second delete extends the delete file of the first one, which then covers snapshot 4 as well: snapshot 3 is not exact.
        expect(
          dropped.steps.map((step) => [step.id, step.total.rows, step.total.files, step.approximate]),
        ).toEqual([
          [0, 0, 0, false],
          [1, 0, 0, false],
          [2, 30, 1, false],
          [3, 15, 1, true],
          [4, 15, 1, false],
          [5, 0, 0, false],
        ]);
        // The bytes of the data file and the delete file go with the table.
        expect(dropped.steps.map((step) => step.total.bytes > 0)).toEqual([
          false,
          false,
          true,
          true,
          true,
          false,
        ]);
        expect(dropped.steps.at(-1)?.total.bytes).toBe(0);
        await expectExact(dropped.lake, dropped.steps);
      } finally {
        await dropped.lake.remove();
      }

      // DuckLake ends the table but leaves the inlined rows without an end snapshot: DROP TABLE and DROP SCHEMA CASCADE.
      const inlined = await scenario([
        "CALL lake.set_option('data_inlining_row_limit', 10)",
        'CREATE TABLE t (id INTEGER, v VARCHAR)',
        "INSERT INTO t SELECT i, 'a' FROM range(4) r(i)",
        'DROP TABLE t',
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (id INTEGER, v VARCHAR)',
        "INSERT INTO s.t SELECT i, 'b' FROM range(6) r(i)",
        'DROP SCHEMA s CASCADE',
      ]);
      try {
        expect(rowsOf(inlined.steps)).toEqual([
          [0, 0],
          [1, 0],
          [2, 4],
          [3, 0],
          [4, 0],
          [5, 0],
          [6, 6],
          [7, 0],
        ]);
        await expectExact(inlined.lake, inlined.steps, ['t', 's.t']);
      } finally {
        await inlined.lake.remove();
      }

      // The inlined rows of a renamed table stay with it, also with a column added, dropped at the end or not.
      for (const drop of [false, true]) {
        const renamed = await scenario([
          "CALL lake.set_option('data_inlining_row_limit', 10)",
          'CREATE TABLE t (id INTEGER)',
          'INSERT INTO t SELECT i FROM range(4) r(i)',
          'ALTER TABLE t RENAME TO u',
          'INSERT INTO u SELECT i FROM range(2) r(i)',
          'ALTER TABLE u ADD COLUMN v VARCHAR',
          'INSERT INTO u SELECT i, 1 FROM range(3) r(i)',
          ...(drop ? ['DROP TABLE u'] : []),
        ]);
        try {
          expect(rowsOf(renamed.steps).map(([, rows]) => rows)).toEqual([
            0,
            0,
            4,
            4,
            6,
            6,
            9,
            ...(drop ? [0] : []),
          ]);
          await expectExact(renamed.lake, renamed.steps, ['t', 'u']);
        } finally {
          await renamed.lake.remove();
        }
      }
    }, 300_000);

    it('adds the inlined rows and the file rows of one snapshot, and does not subtract the rows of a file that an inlined delete removed, as the tree does not', async () => {
      const lake = await backend.create();
      try {
        await run(lake, "CALL lake.set_option('data_inlining_row_limit', 3)");
        await run(lake, 'CREATE TABLE t (id INTEGER, v VARCHAR)');
        await run(lake, 'BEGIN');
        await run(lake, "INSERT INTO t SELECT i, 'a' FROM range(2) r(i)");
        await run(lake, "INSERT INTO t SELECT i, 'b' FROM range(100, 130) r(i)");
        await run(lake, 'COMMIT');

        const last = (await stepsOf(lake)).at(-1) as Step;
        expect([last.total.rows, last.total.files]).toEqual([32, 1]);
        expect(last.total.bytes).toBeGreaterThan(0);
        expect(last.total.rows).toBe(await rowsAt(lake, last.id));
      } finally {
        await lake.remove();
      }

      const deleted = await backend.create();
      try {
        await run(deleted, "CALL lake.set_option('data_inlining_row_limit', 10)");
        await run(deleted, 'CREATE TABLE t (id INTEGER, v VARCHAR)');
        await run(deleted, "INSERT INTO t SELECT i, 'c' FROM range(100, 130) r(i)");
        // Ten rows or fewer: DuckLake keeps this delete in the catalog table ducklake_inlined_delete_1, not in a delete file.
        await run(deleted, 'DELETE FROM t WHERE id >= 120');

        const steps = await stepsOf(deleted);
        const reader = await deleted.reader();
        try {
          const [schema] = await reader.schemas(3);
          expect(await rowsAt(deleted, 3)).toBe(20);
          expect(steps.at(-1)?.total.rows).toBe(30);
          expect((await reader.tables(schema?.id ?? 0, 3))[0]?.stats.rows).toBe(30);
        } finally {
          await reader.close();
        }
      } finally {
        await deleted.remove();
      }
    }, 300_000);
  });
});
