import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engineSkipReason } from './data-support';
import { createLake } from './health-lake-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Auto-compact lake tests are skipped: ${skipReason}`);
}

const ONE_ROW_FILES = (table: string): string[] =>
  [1, 2, 3, 4].map((n) => `INSERT INTO ${table} VALUES (${n})`);

describe.skipIf(skipReason)('auto_compact set to false on a real lake', () => {
  const lake = createLake('aantje-autocompact-');
  afterAll(lake.dispose);

  const filesOf = async (table: string): Promise<number> => {
    const rows = await lake.query(
      `SELECT count(*) AS n FROM ducklake_list_files('lake', '${table}', schema => 'shop') WHERE data_file IS NOT NULL`,
    );
    return Number(rows[0]?.n);
  };

  beforeAll(async () => {
    await lake.stage([
      'CREATE SCHEMA shop',
      'CREATE TABLE shop.off (a INT)',
      'CREATE TABLE shop.fine (a INT)',
      'CREATE TABLE shop.covered (a INT)',
      ...ONE_ROW_FILES('shop.off'),
      ...ONE_ROW_FILES('shop.fine'),
      "CALL lake.set_option('auto_compact', false, table_name => 'off', schema => 'shop')",
    ]);
  });

  it('names the table, explains the skipped merge, and is gone after its fix script ran', async () => {
    const ids = await lake.tableIds();
    const found = (await lake.check()).findings.filter((item) => item.check === 'catalog.auto-compact-off');
    expect(found.map((item) => item.id)).toEqual([`catalog.auto-compact-off:table:${ids.get('off')}`]);
    expect(found[0]?.scope).toMatchObject({ kind: 'table', schema: 'shop', name: 'off' });

    await lake.stage(["CALL ducklake_merge_adjacent_files('lake', 'off', schema => 'shop')"]);
    expect(await filesOf('off')).toBe(4);

    await lake.stage([
      found[0]?.fixSql ?? '',
      "CALL ducklake_merge_adjacent_files('lake', 'off', schema => 'shop')",
    ]);

    expect(await filesOf('off')).toBe(1);
    const after = await lake.check();
    expect(after.findings.map((item) => item.check)).not.toContain('catalog.auto-compact-off');
  });

  it('names a schema and the lake, and a table scope keeps what covers the table', async () => {
    await lake.stage(["CALL lake.set_option('auto_compact', false, schema => 'shop')"]);
    await lake.stage(["CALL lake.set_option('auto_compact', false)"]);
    const ids = await lake.tableIds();

    const all = (await lake.check()).findings.filter((item) => item.check === 'catalog.auto-compact-off');
    expect(all.map((item) => item.scope.kind)).toEqual(['lake', 'schema']);
    expect(all.map((item) => item.id.split(':')[1])).toEqual(['lake', 'schema']);

    const own = (await lake.check(ids.get('covered'))).findings.filter(
      (item) => item.check === 'catalog.auto-compact-off',
    );
    expect(own).toHaveLength(2);

    await lake.stage(all.map((item) => item.fixSql ?? ''));
    const after = (await lake.check()).findings.filter((item) => item.check === 'catalog.auto-compact-off');
    expect(after).toEqual([]);
    expect(await filesOf('fine')).toBe(4);
    await lake.stage(["CALL ducklake_merge_adjacent_files('lake', 'fine', schema => 'shop')"]);
    expect(await filesOf('fine')).toBe(1);
  });
});
