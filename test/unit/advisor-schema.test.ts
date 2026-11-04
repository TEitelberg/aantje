import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readAdvisor } from '../../src/advisor/read';
import type { AdvisorData, AdvisorScope } from '../../src/advisor/model';
import { advisorMarkdown } from '../../src/advisor/markdown';
import { recommendationsOf } from '../../src/advisor/recommend';
import { accessOf } from './advisor-support';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

describe.each(backends)('the Maintenance Advisor for one schema on a lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('two schemas with the same needs', () => {
    let lake: BackendLake;
    let shop: AdvisorScope;

    const sql = (text: string): Promise<unknown> => lake.connection.run(text);

    async function read(scope?: AdvisorScope): Promise<AdvisorData> {
      const reader = await lake.reader();
      try {
        return await readAdvisor({ reader, access: accessOf(lake) }, 'Lake', new Date(), undefined, scope);
      } finally {
        await reader.close();
      }
    }

    beforeAll(async () => {
      lake = await backend.create();
      for (const schema of ['shop', 'crm']) {
        await sql(`CREATE SCHEMA ${schema}`);
        await sql(`CREATE TABLE ${schema}.small(id INTEGER)`);
        for (let part = 0; part < 6; part++) {
          await sql(`INSERT INTO ${schema}.small SELECT range + ${part * 10} FROM range(10)`);
        }
        await sql(`CREATE TABLE ${schema}.deleted(id INTEGER)`);
        await sql(`INSERT INTO ${schema}.deleted SELECT range FROM range(100)`);
        await sql(`DELETE FROM ${schema}.deleted WHERE id < 96`);
        await sql(`CREATE TABLE ${schema}.inlined(id INTEGER)`);
        await sql(
          `CALL lake.set_option('data_inlining_row_limit', 20000, table_name => 'inlined', schema => '${schema}')`,
        );
        await sql(`INSERT INTO ${schema}.inlined SELECT range FROM range(10500)`);
      }
      await sql('CREATE TABLE lake_level(id INTEGER)');
      const reader = await lake.reader();
      try {
        const schemas = await reader.schemas((await reader.info()).latestSnapshot);
        const found = schemas.find(({ name }) => name === 'shop');
        shop = { kind: 'schema', id: found?.id ?? -1, name: 'shop' };
      } finally {
        await reader.close();
      }
    });
    afterAll(() => lake?.remove());

    const names = (data: AdvisorData): string[] =>
      [...data.merge, ...data.rewrite, ...data.flush].map(({ table }) => `${table.schema}.${table.name}`);

    it('names the tables of the schema for every kind of advice and none of the other', async () => {
      const data = await read(shop);

      expect(data.scope).toEqual(shop);
      expect(names(data).toSorted()).toEqual(['shop.deleted', 'shop.inlined', 'shop.small']);
      expect(data.more).toBeUndefined();
    });

    it('says the same about the tables as the report of the lake does, restricted to the schema', async () => {
      const whole = await read();
      const part = await read(shop);

      expect(names(whole).filter((name) => name.startsWith('shop.'))).toEqual(names(part));
      expect(names(whole)).toContain('crm.small');
      expect(part.merge.map(({ files, smallFiles }) => [files, smallFiles])).toEqual(
        whole.merge
          .filter(({ table }) => table.schema === 'shop')
          .map(({ files, smallFiles }) => [files, smallFiles]),
      );
    });

    it('measures the snapshots and the files of the whole lake and labels them so', async () => {
      const whole = await read();
      const part = await read(shop);

      expect(part.expiry).toEqual(whole.expiry);
      expect(part.scheduled).toEqual(whole.scheduled);
      expect(part.orphans).toEqual(whole.orphans);
      const markdown = advisorMarkdown(part);
      expect(markdown.split('\n')[0]).toContain('shop');
      expect(markdown).toMatch(/Snapshots to expire \(lake-wide\)/);
      expect(markdown).not.toContain('crm');
    });

    it('marks the recommendations about snapshots and files as lake-wide', async () => {
      const part = await read(shop);
      const titles = recommendationsOf(part)
        .filter(({ kind }) => kind === 'expire' || kind === 'cleanup' || kind === 'orphans')
        .map(({ title }) => title);

      expect(titles.every((title) => title.endsWith('(lake-wide)'))).toBe(true);
      expect(
        recommendationsOf(await read())
          .map(({ title }) => title)
          .some((title) => title.includes('lake-wide')),
      ).toBe(false);
    });
  });
});
