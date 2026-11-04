import { readdir } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type * as GuardModule from '../../src/data/guard';
import { previewTable } from '../../src/data/engine';
import { extensionDirectory } from './data-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

// The author of a catalog writes to it while aantje reads: the hook runs right after the guard has judged the relation
// and before the read starts, which is the gap the guard has to close.
const between = vi.hoisted(() => ({ hook: undefined as (() => Promise<void>) | undefined }));

vi.mock('../../src/data/guard', async (importOriginal) => {
  const original = await importOriginal<typeof GuardModule>();
  return {
    ...original,
    guardRelation: async (...args: Parameters<typeof original.guardRelation>) => {
      await original.guardRelation(...args);
      await between.hook?.();
    },
  };
});

const cleanup = "SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)";

const backends = (await lakeBackends()).filter((backend) => backend.name === 'postgres');

describe.each(backends)(
  'a catalog that changes between the check and the read, on $name metadata',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
      async function prepare(): Promise<{
        lake: BackendLake;
        run: (sql: string) => Promise<void>;
        files: () => Promise<number>;
      }> {
        const lake = await backend.create();
        const run = async (sql: string): Promise<void> => void (await lake.connection.run(sql));
        for (const sql of [
          'CREATE TABLE gone (a INTEGER)',
          'INSERT INTO gone VALUES (1)',
          'INSERT INTO gone VALUES (2)',
          'DROP TABLE gone',
          "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
          'CREATE TABLE live (b INTEGER)',
          'INSERT INTO live VALUES (10)',
          'CREATE VIEW v AS SELECT b FROM live',
        ]) {
          await run(sql);
        }
        return {
          lake,
          run,
          files: async () => (await readdir(lake.dataDirectory, { recursive: true })).length,
        };
      }

      const access = (lake: BackendLake) => ({
        profile: lake.profile,
        ...(lake.password === undefined ? {} : { password: lake.password }),
        s3: {},
        extensionDirectory,
        // The connection is trusted here; the trust gate itself has its own tests.
        viewsTrusted: true,
      });

      it('reads the view that was checked, not the cleanup view that replaced it (which would delete files)', async () => {
        const { lake, run, files } = await prepare();
        try {
          const before = await files();
          let swapped = false;
          between.hook = async () => {
            await run(`CREATE OR REPLACE VIEW v AS ${cleanup}`);
            swapped = true;
          };

          const data = await previewTable(access(lake), { schema: 'main', table: 'v' });

          expect(swapped).toBe(true);
          expect(data.rows).toEqual([[10]]);
          expect(await files()).toBe(before);
        } finally {
          between.hook = undefined;
          await lake.remove();
        }
      });

      it('reads the table that was checked, not the evil view that replaced it', async () => {
        const { lake, run, files } = await prepare();
        try {
          const before = await files();
          between.hook = async () => {
            await run('DROP VIEW v');
            await run('DROP TABLE live');
            await run(`CREATE VIEW live AS ${cleanup}`);
          };

          const data = await previewTable(access(lake), { schema: 'main', table: 'live' });

          expect(data.rows).toEqual([[10]]);
          expect(await files()).toBe(before);
        } finally {
          between.hook = undefined;
          await lake.remove();
        }
      });
    });
  },
);
