import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAdvisor } from '../../src/advisor/read';
import type { AdvisorData, AdvisorScope } from '../../src/advisor/model';
import { recommendationsOf } from '../../src/advisor/recommend';
import { advisorScriptOf } from '../../src/advisor/script';
import { accessOf, buildAdvisorLake } from './advisor-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const [backend] = (await lakeBackends()).filter(({ name }) => name === 'sqlite');

async function read(lake: BackendLake, scope?: AdvisorScope): Promise<AdvisorData> {
  const reader = await lake.reader();
  try {
    return await readAdvisor({ reader, access: accessOf(lake) }, 'Lake', new Date(), undefined, scope);
  } finally {
    await reader.close();
  }
}

/** What a user does with the script: the dry runs go, the real calls are uncommented, and the age is 0 so that today's files are not spared. */
function runnable(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.includes('dry_run => true'))
    .map((line) => line.replace(/^-- (CALL .*)$/, '$1').replaceAll('INTERVAL 30 DAY', 'INTERVAL 0 DAY'))
    .filter((line) => line !== '' && !line.startsWith('--'));
}

const run = async (lake: BackendLake, script: string): Promise<void> => {
  for (const statement of runnable(script)) await lake.connection.run(statement);
};

const kinds = (data: AdvisorData): string[] =>
  recommendationsOf(data).map(({ id }) => id.split(':')[0] ?? '');

describe.skipIf(backend?.skipReason !== undefined)(
  'the maintenance script for the recommendations of a real lake',
  () => {
    let lake: BackendLake;

    beforeAll(async () => {
      lake = await backend!.create();
      await buildAdvisorLake(lake);
    }, 180_000);
    afterAll(() => lake?.remove());

    it('has the blocks in the order of the steps, with the dry run active and the real call commented out', async () => {
      const data = await read(lake);
      const script = advisorScriptOf(data) ?? '';
      const at = (text: string): number => script.indexOf(text);
      const order = [
        'ducklake_merge_adjacent_files',
        'ducklake_flush_inlined_data',
        'ducklake_rewrite_data_files',
        'ducklake_expire_snapshots',
        'ducklake_cleanup_old_files',
        'ducklake_delete_orphaned_files',
      ].map(at);
      expect(order.every((position) => position > 0)).toBe(true);
      // Merge and flush share a step and go by table; the rewrite follows both.
      expect(order.slice(2)).toEqual(order.slice(2).toSorted((a, b) => a - b));
      expect(Math.max(order[0] ?? 0, order[1] ?? 0)).toBeLessThan(order[2] ?? 0);
      expect(script).toMatch(/^CALL ducklake_expire_snapshots\('lake', older_than => .*dry_run => true\);$/m);
      expect(script).toMatch(/^-- CALL ducklake_expire_snapshots\('lake', older_than => [^;]*\);$/m);
      expect(script).toMatch(
        /^CALL ducklake_delete_orphaned_files\('lake'(, older_than => [^;]*)?, dry_run => true\);$/m,
      );
      expect(script).toContain('Estimated fewer files');
    });

    it('removes the recommendations it covers when it runs, and the rest is a decision about the threshold', async () => {
      const first = await read(lake);
      expect(kinds(first)).toEqual(
        expect.arrayContaining(['merge', 'rewrite', 'flush', 'expire', 'cleanup', 'orphans']),
      );

      await run(lake, advisorScriptOf(first) ?? '');

      const second = await read(lake);
      expect(kinds(second).filter((kind) => kind !== 'rewrite')).toEqual([]);
      // Only the table whose files are below the rewrite threshold is left; the plain call rewrites nothing for it.
      expect(second.rewrite.map(({ table, atThreshold }) => [table.name, atThreshold])).toEqual([
        ['half_deleted', 0],
      ]);
    }, 120_000);
  },
);

describe.skipIf(backend?.skipReason !== undefined)(
  'the maintenance script of the Advisor of one schema',
  () => {
    let lake: BackendLake;
    let shop: AdvisorScope;

    beforeAll(async () => {
      lake = await backend!.create();
      const sql = (text: string): Promise<unknown> => lake.connection.run(text);
      for (const schema of ['shop', 'crm']) {
        await sql(`CREATE SCHEMA ${schema}`);
        await sql(`CREATE TABLE ${schema}.small(id INTEGER)`);
        for (let part = 0; part < 6; part++) {
          await sql(`INSERT INTO ${schema}.small SELECT range + ${part * 10} FROM range(10)`);
        }
      }
      const reader = await lake.reader();
      try {
        const found = (await reader.schemas((await reader.info()).latestSnapshot)).find(
          ({ name }) => name === 'shop',
        );
        shop = { kind: 'schema', id: found?.id ?? -1, name: 'shop' };
      } finally {
        await reader.close();
      }
    }, 120_000);
    afterAll(() => lake?.remove());

    it('covers the tables of the schema only, and leaves the other schema as it was', async () => {
      const script = advisorScriptOf(await read(lake, shop)) ?? '';
      expect(script).toContain("'small', schema => 'shop'");
      expect(script).not.toContain("schema => 'crm'");

      await run(lake, script);

      expect(kinds(await read(lake, shop))).toEqual([]);
      expect((await read(lake)).merge.map(({ table }) => table.schema)).toEqual(['crm']);
    });

    it('is undefined when nothing is recommended', async () => {
      const data = await read(lake, { kind: 'schema', id: -1, name: 'none' });
      expect(advisorScriptOf({ ...data, merge: [], rewrite: [], flush: [] })).toBeUndefined();
    });
  },
);
