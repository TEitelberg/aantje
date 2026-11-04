import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { maintenanceOf } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import { lakeOptionsOf } from '../../src/maintenance-header';
import { extensionDirectory } from './data-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const [sqlite] = await lakeBackends();
const backend = sqlite as NonNullable<typeof sqlite>;

const DAY = 86_400_000;

describe.skipIf(backend.skipReason !== undefined)(
  'Expire Snapshots and Delete Orphaned Files: the age follows the lake, and the pages count what the script takes',
  () => {
    const rows = async (lake: BackendLake, sql: string): Promise<unknown[][]> =>
      (await lake.connection.runAndReadAll(sql)).getRowsJson();
    const run = async (lake: BackendLake, sql: string): Promise<void> =>
      void (await lake.connection.run(sql));

    /** Snapshots 0 to 5: the schema, the table and four inserts. */
    async function lakeWithSnapshots(): Promise<BackendLake> {
      const lake = await backend.create();
      try {
        await run(lake, 'CREATE TABLE t (x INTEGER)');
        for (const value of [1, 2, 3, 4]) await run(lake, `INSERT INTO t VALUES (${value})`);
        return lake;
      } catch (error) {
        await lake.remove();
        throw error;
      }
    }

    /** The lake keeps its metadata file locked, so the snapshot times are set back through a second connection. */
    async function setBack(lake: BackendLake, daysBySnapshot: Record<number, number>): Promise<void> {
      const path = (lake.profile as { path: string }).path.replaceAll('\\', '/');
      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      try {
        await connection.run('LOAD sqlite');
        await connection.run(`ATTACH '${path}' AS raw (TYPE sqlite)`);
        for (const [id, days] of Object.entries(daysBySnapshot)) {
          await connection.run(
            `UPDATE raw.ducklake_snapshot SET snapshot_time = CAST(CAST(now() - INTERVAL ${days} DAY AS TIMESTAMPTZ) AS VARCHAR) WHERE snapshot_id = ${id}`,
          );
        }
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    }

    const snapshotCount = async (lake: BackendLake): Promise<number> =>
      Number((await rows(lake, 'SELECT count(*) FROM lake.snapshots()'))[0]?.[0]);

    /** The script as the commands make it: with the option values that the catalog holds now. */
    async function scriptOf(lake: BackendLake, kind: MaintenanceKind): Promise<string> {
      const reader = await lake.reader();
      try {
        const options = lakeOptionsOf(await reader.metadata());
        const tree = { state: () => ({ status: 'connected', snapshot: 'latest' }) } as never;
        return maintenanceOf(tree, kind, { kind: 'connection', connectionId: 'l' }, options) ?? '';
      } finally {
        await reader.close();
      }
    }

    const callsOf = (script: string): string[] =>
      [...script.matchAll(/^(?:-- )?CALL [^\n]*;$/gm)].map(([call]) => call);

    const uncommented = (call: string | undefined): string => (call ?? '').replace(/^-- /, '');

    async function expirable(lake: BackendLake) {
      const reader = await lake.reader();
      try {
        const split = await reader.expirableSnapshots();
        expect((await reader.storage(5)).expirableSnapshots).toEqual(split);
        return split;
      } finally {
        await reader.close();
      }
    }

    it('names an age of its own while the lake sets none, follows expire_older_than once it is set, and the split counts what the dry run lists', async () => {
      const lake = await lakeWithSnapshots();
      try {
        await setBack(lake, { 0: 40, 1: 40, 2: 20, 3: 10 });

        // A call without older_than expires nothing while the option is not set, however old the snapshots are.
        expect(await rows(lake, "CALL ducklake_expire_snapshots('lake', dry_run => true)")).toEqual([]);

        const unset = await scriptOf(lake, 'expire');
        const [dryRun, real, ...others] = callsOf(unset);
        expect(others).toEqual([]);
        expect(dryRun).toContain('INTERVAL 30 DAY');
        expect(dryRun).toContain('dry_run => true');
        expect(real).toContain('INTERVAL 30 DAY');
        expect(real).not.toContain('dry_run');
        expect(unset).toContain(`\n${dryRun}\n-- CALL`);
        const byDefault = await expirable(lake);
        expect(byDefault).toMatchObject({
          age: { text: '30 days', source: 'default' },
          ready: 2,
          waiting: 3,
        });
        expect(await rows(lake, dryRun as string)).toHaveLength(byDefault?.ready as number);

        // An empty option expires nothing either, so the script still names the age.
        await run(lake, "CALL lake.set_option('expire_older_than', '')");
        expect(callsOf(await scriptOf(lake, 'expire'))[0]).toContain('INTERVAL 30 DAY');
        expect(await expirable(lake)).toMatchObject({ age: { source: 'default' }, ready: 2 });

        await run(lake, "CALL lake.set_option('expire_older_than', '15 days')");
        const [followed, realCall, withAge, ...rest] = callsOf(await scriptOf(lake, 'expire'));
        expect(rest).toEqual([]);
        expect(followed).not.toContain('older_than');
        expect(followed).toContain('dry_run => true');
        expect(realCall).not.toContain('dry_run');
        expect(withAge).toContain('older_than =>');
        const byOption = await expirable(lake);
        expect(byOption).toMatchObject({ age: { text: '15 days', source: 'option' }, ready: 3, waiting: 2 });

        const before = await snapshotCount(lake);
        expect(await rows(lake, followed as string)).toHaveLength(byOption?.ready as number);
        expect(await snapshotCount(lake)).toBe(before);

        await run(lake, uncommented(realCall));
        expect(await snapshotCount(lake)).toBe(before - (byOption?.ready as number));
        expect(await expirable(lake)).toMatchObject({ ready: 0, waiting: 2 });
        expect(await rows(lake, 'SELECT x FROM t ORDER BY x')).toEqual([[1], [2], [3], [4]]);
      } finally {
        await lake.remove();
      }
    });

    it('lets Delete Orphaned Files follow delete_older_than, and names an age when the option is empty, because the call fails then', async () => {
      const lake = await lakeWithSnapshots();
      try {
        const directory = `${lake.dataDirectory}/main/t`;
        mkdirSync(directory, { recursive: true });
        const posix = (path: string): string => path.replaceAll('\\', '/');
        const orphan = (name: string, ageMs: number): string => {
          const path = `${directory}/${name}.parquet`;
          writeFileSync(path, 'not in the catalog');
          const time = new Date(Date.now() - ageMs);
          utimesSync(path, time, time);
          return path;
        };
        const [old, hours, fresh] = [orphan('old', 5 * DAY), orphan('hours', 3_600_000), orphan('fresh', 0)];
        const listed = async (sql: string): Promise<string[]> =>
          (await rows(lake, sql)).map(([path]) => posix(String(path))).sort();

        // Unset: the engine takes 2 days, so only the old file is listed.
        const unset = await scriptOf(lake, 'orphans');
        const [dryRun, real, withAge, ...others] = callsOf(unset);
        expect(others).toEqual([]);
        expect(dryRun).not.toContain('older_than');
        expect(dryRun).toContain('dry_run => true');
        expect(real).not.toContain('dry_run');
        expect(withAge).toContain('older_than =>');
        expect(unset).toContain(`\n${dryRun}\n-- CALL`);
        expect(await listed(dryRun as string)).toEqual([posix(old)]);

        await run(lake, "CALL lake.set_option('delete_older_than', '30 minutes')");
        const followed = callsOf(await scriptOf(lake, 'orphans'))[0] as string;
        expect(await listed(followed)).toEqual([posix(hours), posix(old)].sort());

        // An empty option makes the call without older_than fail, so the script names an age.
        await run(lake, "CALL lake.set_option('delete_older_than', '')");
        await expect(listed(followed)).rejects.toThrow(/older_than/);
        const [namedDryRun, namedReal] = callsOf(await scriptOf(lake, 'orphans'));
        expect(namedDryRun).toContain('INTERVAL 2 DAY');
        expect(namedReal).toContain('INTERVAL 2 DAY');
        expect(await listed(namedDryRun as string)).toEqual([posix(old)]);

        await run(lake, uncommented(namedReal));
        expect([existsSync(old), existsSync(hours), existsSync(fresh)]).toEqual([false, true, true]);
      } finally {
        await lake.remove();
      }
    });
  },
);
