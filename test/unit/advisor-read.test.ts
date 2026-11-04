import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAdvisorMessage } from '../../src/advisor/protocol';
import { policyOf, readAdvisor } from '../../src/advisor/read';
import type { AdvisorData } from '../../src/advisor/model';
import {
  ORPHAN_BYTES,
  YOUNG_ORPHAN,
  accessOf,
  buildAdvisorLake,
  catalogFingerprint,
  directoryFingerprint,
  editMetadata,
  rows,
} from './advisor-support';
import { startFakeStore } from './health-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

/** Reads the advisor data of a lake with the real catalog reader and the real read-only engine. */
async function read(lake: BackendLake, access = accessOf(lake), signal?: AbortSignal): Promise<AdvisorData> {
  const reader = await lake.reader();
  try {
    return await readAdvisor({ reader, access }, 'Lake', new Date(), signal);
  } finally {
    await reader.close();
  }
}

const DAY = 86_400_000;

describe.each(backends)('the Maintenance Advisor on a lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('measured with the dry runs', () => {
    let lake: BackendLake;
    let data: AdvisorData;
    let before: { catalog: Record<string, string>; data: Record<string, string> };
    let after: typeof before;

    const sizeOf = (paths: readonly string[]): number =>
      paths.reduce((sum, path) => sum + statSync(resolve(lake.dataDirectory, path)).size, 0);

    beforeAll(async () => {
      lake = await backend.create();
      await buildAdvisorLake(lake);
      before = {
        catalog: await catalogFingerprint(lake),
        data: directoryFingerprint(lake.dataDirectory),
      };
      data = await read(lake);
      after = {
        catalog: await catalogFingerprint(lake),
        data: directoryFingerprint(lake.dataDirectory),
      };
    }, 180_000);

    afterAll(() => lake?.remove());

    it('measures what the dry runs would do, with exact sizes, and names the tables that need work', async () => {
      // Snapshots that expiring with the default age would remove, with the oldest and the newest.
      const [aged] = await rows(
        lake,
        'SELECT count(*), epoch_ms(min(snapshot_time)), epoch_ms(max(snapshot_time)) FROM lake.snapshots() WHERE snapshot_time < now() - INTERVAL 30 DAY',
      );
      expect(data.policy.expire).toEqual({ text: '30 days', source: 'default' });
      expect(data.expiry).toEqual({
        state: 'measured',
        value: {
          snapshots: 21,
          expiring: 8,
          oldest: new Date(Number(aged?.[1])).toISOString(),
          newest: new Date(Number(aged?.[2])).toISOString(),
        },
      });
      expect(Number(aged?.[0])).toBe(8);
      expect(data.snapshot).toBe(28);
      const { value } = data.expiry as Extract<typeof data.expiry, { state: 'measured' }>;
      // The ages were set one minute apart, from the oldest remaining snapshot to the last one that was aged.
      expect(Date.parse(value.newest ?? '') - Date.parse(value.oldest ?? '')).toBe(7 * 60_000);

      // The files the cleanup would delete, with their exact size, and not the file that is too young.
      const ready = (
        await rows(
          lake,
          "SELECT path FROM __ducklake_metadata_lake.ducklake_files_scheduled_for_deletion WHERE path LIKE '%merged%'",
        )
      ).map((row) => String(row[0]));
      expect(ready).toHaveLength(3);
      expect(data.cleanup).toEqual({
        state: 'measured',
        value: { files: 3, bytes: sizeOf(ready), sized: 3 },
      });
      // Four files wait; the one of the dropped table was scheduled just now.
      expect(data.scheduled.count).toBe(4);
      const waited = Date.parse(data.readAt) - Date.parse(data.scheduled.oldestScheduledAt ?? '');
      expect(Math.abs(waited - 10 * DAY)).toBeLessThan(5 * 60_000);

      // The orphaned files with their exact size, and not the one that is too young for the age of DuckLake.
      expect(data.orphans).toEqual({
        state: 'measured',
        value: { files: 2, bytes: ORPHAN_BYTES, sized: 2 },
      });
      expect(YOUNG_ORPHAN.bytes).toBeGreaterThan(0);

      // Tables with many small files, with the estimate of the files after a merge.
      const bytes = sizeOf(
        (await rows(lake, "SELECT data_file FROM ducklake_list_files('lake', 'many')")).map((row) =>
          String(row[0]),
        ),
      );
      expect(data.merge).toEqual([
        {
          table: { id: 3, schemaId: 0, schema: 'main', name: 'many' },
          files: 6,
          smallFiles: 6,
          smallBytes: bytes,
          estimatedAfter: 1,
        },
      ]);

      // Files that have lost their rows: one past the threshold of DuckLake, one only past half.
      expect(
        data.rewrite.map(({ table, files, atThreshold, records, deleted }) => [
          table.name,
          files,
          atThreshold,
          deleted,
          records,
        ]),
      ).toEqual([
        ['mostly_deleted', 1, 1, 96, 100],
        ['half_deleted', 1, 0, 60, 100],
      ]);

      // A large amount of inlined rows, and not the table with five.
      expect(data.flush.map(({ table, rows: inlined }) => [table.name, inlined])).toEqual([
        ['inlined', 10_500],
      ]);
    });

    it('is data the page accepts after the trip through JSON, changes nothing, and stops with ABORTED', async () => {
      expect(isAdvisorMessage(JSON.parse(JSON.stringify({ type: 'advisor', data })))).toBe(true);
      expect(after.catalog).toEqual(before.catalog);
      expect(after.data).toEqual(before.data);
      expect(Object.keys(after.data).filter((path) => path.includes('orphan'))).toHaveLength(3);

      const controller = new AbortController();
      controller.abort();
      await expect(read(lake, accessOf(lake), controller.signal)).rejects.toMatchObject({
        code: 'ABORTED',
      });
    });
  });
});

describe('the policy that the options of the lake set', () => {
  const entry = (key: string, value: string, scope: string | null = null) => ({
    key,
    value,
    scope,
    scopeId: scope === null ? null : 1,
  });

  it('is the defaults when the lake sets nothing, and the global options of the lake when it does', () => {
    expect(policyOf([entry('version', '1.1')])).toEqual({
      expire: { text: '30 days', source: 'default' },
      delete: null,
      rewrite: { share: 0.95, source: 'default' },
      target: { bytes: 512_000_000, source: 'default' },
      unreadable: [],
    });
    expect(
      policyOf([
        entry('expire_older_than', '7 days'),
        entry('delete_older_than', '2 hours'),
        entry('rewrite_delete_threshold', '0.500000'),
        entry('target_file_size', '100000000'),
        entry('target_file_size', '5', 'table'),
      ]),
    ).toEqual({
      expire: { text: '7 days', source: 'option' },
      delete: '2 hours',
      rewrite: { share: 0.5, source: 'option' },
      target: { bytes: 100_000_000, source: 'option' },
      unreadable: [],
    });
    // The global option wins whatever the order, and a scoped one alone is no option.
    const policy = policyOf([
      entry('expire_older_than', '3 days', 'table'),
      entry('delete_older_than', '5 hours', 'table'),
      entry('expire_older_than', '9 days'),
      entry('delete_older_than', '8 hours'),
    ]);
    expect([policy.expire.text, policy.delete]).toEqual(['9 days', '8 hours']);
    expect(policyOf([entry('delete_older_than', '5 hours', 'table')]).delete).toBeNull();
  });

  it('reads intervals of several units, trims blanks, accepts a threshold of 0 and 1, and shortens a long age', () => {
    expect(policyOf([entry('expire_older_than', '1 day 12 hours')]).expire.text).toBe('1 day 12 hours');
    expect(policyOf([entry('expire_older_than', ' 90 minutes ')]).expire.text).toBe('90 minutes');
    expect(policyOf([entry('rewrite_delete_threshold', ' 0.7 ')]).rewrite.share).toBe(0.7);
    expect(policyOf([entry('rewrite_delete_threshold', '0')]).rewrite.share).toBe(0);
    expect(policyOf([entry('rewrite_delete_threshold', '1')]).rewrite.share).toBe(1);
    expect(policyOf([entry('delete_older_than', '')]).delete).toBeNull();
    expect(policyOf([entry('delete_older_than', 'x'.repeat(150))]).delete).toBe('x'.repeat(100));
  });

  it('uses the default and names the option when its value cannot be read, SQL text included', () => {
    const unreadable: [string, string][] = [
      ['expire_older_than', "1 day'; DROP TABLE x; --"],
      ['expire_older_than', '30'],
      ['expire_older_than', 'soon'],
      ['expire_older_than', 'about 5 days'],
      ['expire_older_than', '5 days ago'],
      ['expire_older_than', '1234567 days'],
      ['expire_older_than', ''],
      ['rewrite_delete_threshold', ''],
      ['rewrite_delete_threshold', '1.5'],
      ['rewrite_delete_threshold', '-0.1'],
      ['rewrite_delete_threshold', '95'],
      ['rewrite_delete_threshold', 'high'],
      ['target_file_size', '512MB'],
      ['target_file_size', '0'],
    ];
    for (const [key, value] of unreadable) {
      const policy = policyOf([entry(key, value)]);
      expect(policy.unreadable, `${key} ${value}`).toEqual([key]);
      expect(policy.expire).toEqual({ text: '30 days', source: 'default' });
      expect(policy.rewrite).toEqual({ share: 0.95, source: 'default' });
      expect(policy.target).toEqual({ bytes: 512_000_000, source: 'default' });
    }
  });
});

describe.each(backends)(
  'the Maintenance Advisor on a lake with $name metadata (options and failures)',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
      let lake: BackendLake;

      beforeAll(async () => {
        lake = await backend.create();
        await buildAdvisorLake(lake);
      }, 180_000);

      afterAll(() => lake?.remove());

      it('measures with the options of the lake, predicts what the real calls do, and skips what the engine cannot open', async () => {
        const set = (name: string, value: string): Promise<unknown> =>
          lake.connection.run(`CALL lake.set_option('${name}', '${value}')`);
        await set('expire_older_than', '41 days');
        let data = await read(lake);
        expect(data.policy.expire).toEqual({ text: '41 days', source: 'option' });
        expect(data.expiry).toMatchObject({
          state: 'measured',
          value: { expiring: 0, oldest: null, newest: null },
        });

        await set('expire_older_than', '39 days');
        data = await read(lake);
        expect(data.expiry).toMatchObject({ state: 'measured', value: { expiring: 8 } });

        await set('rewrite_delete_threshold', '0.5');
        await set('target_file_size', '1KB');
        data = await read(lake);
        expect(data.policy.rewrite).toEqual({ share: 0.5, source: 'option' });
        expect(data.rewrite.map(({ table, atThreshold }) => [table.name, atThreshold])).toEqual([
          ['mostly_deleted', 1],
          ['half_deleted', 1],
        ]);
        // The six files of a few hundred bytes each add up to more than one and less than six targets of 1,000 bytes.
        const small = data.merge[0]?.smallBytes ?? 0;
        expect(small).toBeGreaterThan(1000);
        expect(small).toBeLessThan(6000);
        expect(data.merge[0]).toMatchObject({
          files: 6,
          smallFiles: 6,
          estimatedAfter: Math.ceil(small / 1000),
        });

        await set('delete_older_than', '0 seconds');
        data = await read(lake);
        expect(data.policy.delete).toBe('0 seconds');
        expect(data.cleanup).toMatchObject({ state: 'measured', value: { files: 4 } });
        expect(data.orphans).toMatchObject({
          state: 'measured',
          value: {
            files: 3,
            bytes: ORPHAN_BYTES + YOUNG_ORPHAN.bytes,
            sized: 3,
          },
        });

        // A threshold that a table meets exactly: 60 of its 100 rows are deleted.
        await set('rewrite_delete_threshold', '0.6');
        await set('delete_older_than', '0 seconds');
        data = await read(lake);
        const named = (rows: unknown[][]): string[] => rows.map((row) => String(row[1])).toSorted();

        expect(
          data.rewrite
            .filter(({ atThreshold }) => atThreshold > 0)
            .map(({ table }) => table.name)
            .toSorted(),
        ).toEqual(['half_deleted', 'mostly_deleted']);
        const rewritten = (
          await lake.connection.runAndReadAll("CALL ducklake_rewrite_data_files('lake')")
        ).getRowsJson();
        expect(named(rewritten)).toEqual(['half_deleted', 'mostly_deleted']);

        const cleaned = (
          await lake.connection.runAndReadAll("CALL ducklake_cleanup_old_files('lake')")
        ).getRowsJson();
        const orphans = (
          await lake.connection.runAndReadAll("CALL ducklake_delete_orphaned_files('lake')")
        ).getRowsJson();
        expect(data.cleanup).toMatchObject({ state: 'measured', value: { files: cleaned.length } });
        expect(data.orphans).toMatchObject({ state: 'measured', value: { files: orphans.length } });
        expect([cleaned.length, orphans.length]).toEqual([4, 3]);
        // The real cleanup deleted the files that the dry run had sized.
        expect(cleaned.every((row) => typeof row[0] === 'string' && !existsSync(row[0]))).toBe(true);

        const { profile } = lake;
        const broken =
          profile.kind === 'postgres'
            ? { ...profile, port: 1 }
            : profile.kind === 'sqlite'
              ? { ...profile, path: `${lake.dataDirectory}/missing.sqlite` }
              : profile;
        data = await read(lake, accessOf(lake, { profile: broken }));
        for (const measure of [data.expiry, data.cleanup, data.orphans]) {
          expect(measure.state).toBe('skipped');
          expect(measure.state === 'skipped' ? measure.reason : '').toMatch(/\S/);
        }
        expect(data.merge.map(({ table }) => table.name)).toEqual(['many']);
      });
    });
  },
);

describe.each(backends)(
  'the Maintenance Advisor on a lake with $name metadata in an object store',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
      let lake: BackendLake;

      beforeAll(async () => {
        lake = await backend.create();
        await buildAdvisorLake(lake);
      }, 180_000);

      afterAll(() => lake?.remove());

      it('measures the orphaned files of a lake in an object store, sizes included, and skips only that measurement when the store refuses', async () => {
        const store = await startFakeStore(lake.dataDirectory, 'advisor', 'lake');
        try {
          await editMetadata(lake, [
            "UPDATE meta.ducklake_metadata SET value = 's3://advisor/lake/' WHERE key = 'data_path'",
          ]);
          const access = accessOf(lake, {
            s3: { endpoint: store.endpoint, urlStyle: 'path' },
            s3Credentials: { keyId: 'key', secretKey: 'secret' },
          });
          let data = await read(lake, access);
          // The store is asked for a listing and for the size of each file; no object is ever downloaded. The files
          // that wait for deletion are sized too when the catalog stores them relative to the data path (not on Windows).
          expect(store.requests.filter((request) => !request.includes('/main/merged/'))).toEqual([
            'GET /advisor/?encoding-type=url&list-type=2&prefix=lake%2F',
            'HEAD /advisor/lake/old-orphan.parquet',
            'HEAD /advisor/lake/sub/older-orphan.parquet',
          ]);
          expect(data.orphans).toEqual({
            state: 'measured',
            value: { files: 2, bytes: ORPHAN_BYTES, sized: 2 },
          });

          store.mode.value = 'denied';
          data = await read(lake, access);
          expect(data.expiry.state).toBe('measured');
          expect(data.cleanup.state).toBe('measured');
          expect(data.orphans.state === 'skipped' ? data.orphans.reason : '').toContain('403');
        } finally {
          await store.close();
        }
      });
    });
  },
);
