import { readdirSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { maintenanceOf } from '../../src/maintenance';
import { extensionDirectory } from './data-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const [sqlite] = await lakeBackends();
const backend = sqlite as NonNullable<typeof sqlite>;

const HOUR = 3_600_000;

describe.skipIf(backend.skipReason !== undefined)(
  'the scheduled files: ready and waiting as the reader tells them, and as Clean Up Old Files treats them',
  () => {
    const rows = async (lake: BackendLake, sql: string): Promise<unknown[][]> =>
      (await lake.connection.runAndReadAll(sql)).getRowsJson();
    const run = async (lake: BackendLake, sql: string): Promise<void> =>
      void (await lake.connection.run(sql));

    /** A lake of four tables, each merged once, so that eight files are scheduled for deletion. */
    async function lakeWithScheduled(): Promise<BackendLake> {
      const lake = await backend.create();
      try {
        for (const table of ['a', 'b', 'c', 'd']) {
          await run(lake, `CREATE TABLE ${table} (x INTEGER)`);
          await run(lake, `INSERT INTO ${table} VALUES (1)`);
          await run(lake, `INSERT INTO ${table} VALUES (2)`);
        }
        await run(lake, "CALL ducklake_merge_adjacent_files('lake')");
        return lake;
      } catch (error) {
        await lake.remove();
        throw error;
      }
    }

    /** The lake keeps its metadata file locked, so the schedule times are set back through a second connection. */
    async function setBack(lake: BackendLake, fileId: number, hours: number): Promise<void> {
      const path = (lake.profile as { path: string }).path.replaceAll('\\', '/');
      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      try {
        await connection.run('LOAD sqlite');
        await connection.run(`ATTACH '${path}' AS raw (TYPE sqlite)`);
        await connection.run(
          `UPDATE raw.ducklake_files_scheduled_for_deletion SET schedule_start = CAST(CAST(now() - INTERVAL ${hours} HOUR AS TIMESTAMPTZ) AS VARCHAR) WHERE data_file_id = ${fileId}`,
        );
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    }

    const scheduledIds = async (lake: BackendLake): Promise<number[]> =>
      (
        await rows(
          lake,
          'SELECT data_file_id FROM __ducklake_metadata_lake.ducklake_files_scheduled_for_deletion ORDER BY 1',
        )
      ).map(([id]) => Number(id));

    const listed = async (lake: BackendLake): Promise<number> =>
      (await rows(lake, "CALL ducklake_cleanup_old_files('lake', dry_run => true)")).length;

    const cleanupScript = (): string =>
      maintenanceOf({ state: () => ({ status: 'connected', snapshot: 'latest' }) }, 'cleanup', {
        kind: 'connection',
        connectionId: 'l',
      }) ?? '';

    const split = async (lake: BackendLake) => {
      const reader = await lake.reader();
      try {
        return (await reader.scheduledForDeletion()).split;
      } finally {
        await reader.close();
      }
    };

    it('counts the files that the engine would delete now as ready, with the default age and with the age of the lake', async () => {
      const lake = await lakeWithScheduled();
      try {
        const [oldest, middle, ...young] = await scheduledIds(lake);
        expect(young).toHaveLength(6);

        // Scheduled just now: nothing is ready, and the files become ready two days after their schedule time.
        const fresh = await split(lake);
        expect(fresh).toMatchObject({ age: { text: '2 days', source: 'default' }, ready: 0, waiting: 8 });
        expect(await listed(lake)).toBe(0);
        const readyIn = Date.parse(fresh?.nextReadyAt ?? '') - Date.now();
        expect(readyIn).toBeGreaterThan(47 * HOUR);
        expect(readyIn).toBeLessThan(48 * HOUR);

        // One file is three days old, one 30 hours old: the default age makes the first ready.
        await setBack(lake, oldest as number, 72);
        await setBack(lake, middle as number, 30);
        const byDefault = await split(lake);
        expect(byDefault).toMatchObject({ ready: 1, waiting: 7 });
        expect(await listed(lake)).toBe(byDefault?.ready);
        const nextIn = Date.parse(byDefault?.nextReadyAt ?? '') - Date.now();
        expect(Math.abs(nextIn - 18 * HOUR)).toBeLessThan(HOUR / 2);

        // With delete_older_than of one day the file of 30 hours is ready too.
        await run(lake, "CALL lake.set_option('delete_older_than', '1 day')");
        const byOption = await split(lake);
        expect(byOption).toMatchObject({ age: { text: '1 day', source: 'option' }, ready: 2, waiting: 6 });
        expect(await listed(lake)).toBe(byOption?.ready);

        // An age of months has no fixed length, so no split is claimed.
        await run(lake, "CALL lake.set_option('delete_older_than', '1 month')");
        expect(await split(lake)).toBeNull();
      } finally {
        await lake.remove();
      }
    });

    it('lets Clean Up Old Files as generated list and delete the ready files only, and cleanup_all the rest', async () => {
      const lake = await lakeWithScheduled();
      try {
        const [oldest, middle] = await scheduledIds(lake);
        await setBack(lake, oldest as number, 72);
        await setBack(lake, middle as number, 72);
        const script = cleanupScript();
        const calls = [...script.matchAll(/^(?:-- )?CALL [^\n]*;$/gm)].map(([call]) => call);
        const [dryRun, real, everything, ...others] = calls;
        expect(others).toEqual([]);
        expect(dryRun).toContain('dry_run => true');
        expect(dryRun).not.toContain('older_than');
        expect(real).not.toContain('dry_run');
        expect(everything).toContain('cleanup_all => true');
        expect(script).toContain(`\n${dryRun}\n-- CALL`);

        const parquet = (): number =>
          readdirSync(lake.dataDirectory, { recursive: true, encoding: 'utf8' }).filter((name) =>
            name.endsWith('.parquet'),
          ).length;
        const files = parquet();
        expect((await split(lake))?.ready).toBe(2);

        // The active statement lists what is ready and deletes nothing.
        expect(await rows(lake, dryRun as string)).toHaveLength(2);
        expect([parquet(), (await scheduledIds(lake)).length]).toEqual([files, 8]);

        await run(lake, (real as string).replace('-- ', ''));
        expect([parquet(), (await scheduledIds(lake)).length]).toEqual([files - 2, 6]);
        expect(await split(lake)).toMatchObject({ ready: 0, waiting: 6 });

        await run(lake, (everything as string).replace('-- ', ''));
        expect([parquet(), (await scheduledIds(lake)).length]).toEqual([files - 8, 0]);
        expect(await rows(lake, 'SELECT x FROM a ORDER BY x')).toEqual([[1], [2]]);
      } finally {
        await lake.remove();
      }
    });
  },
);
