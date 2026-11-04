import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthFinding, HealthReport } from '../../src/health/model';
import { engineSkipReason } from './data-support';
import { createLake } from './health-lake-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check schema tests are skipped: ${skipReason}`);
}

const tableOf = (item: HealthFinding): string | undefined =>
  item.scope.kind === 'table' ? `${item.scope.schema}.${item.scope.name}` : undefined;

const tables = (report: HealthReport): string[] =>
  [...new Set(report.findings.flatMap((item) => tableOf(item) ?? []))].toSorted();

// Two schemas, each with small files, a table that has auto_compact off and a stray file in its directory; crm also lost
// a data file. The report of one schema must hold what is wrong with its tables and nothing of the other.
describe.skipIf(skipReason)('the health check of one schema of a lake with two', () => {
  const { directory, stage, query, checkScope, check, schemaIds, tableIds, dispose } =
    createLake('aantje-healthschema-');
  let shop = 0;
  let crm = 0;

  beforeAll(async () => {
    const inserts = (table: string): string[] =>
      Array.from({ length: 6 }, (_, index) => `INSERT INTO ${table} VALUES (${index})`);
    await stage([
      'CREATE SCHEMA shop',
      'CREATE SCHEMA crm',
      'CREATE TABLE shop.events (id INT)',
      'CREATE TABLE crm.contacts (id INT)',
      'CREATE TABLE crm.deals (id INT)',
      ...inserts('shop.events'),
      ...inserts('crm.contacts'),
      'INSERT INTO crm.deals VALUES (1)',
      'CREATE TABLE crm.scratch (id INT)',
      'INSERT INTO crm.scratch VALUES (1)',
      'DROP TABLE crm.scratch',
      "CALL lake.set_option('auto_compact', false, schema => 'shop', table_name => 'events')",
      "CALL lake.set_option('auto_compact', false, schema => 'crm', table_name => 'contacts')",
    ]);
    const ids = await schemaIds();
    shop = ids.get('shop') ?? 0;
    crm = ids.get('crm') ?? 0;
    for (const where of ['shop/events', 'crm/contacts']) {
      writeFileSync(join(directory, 'files', where, 'ducklake-stray.parquet'), 'x');
    }
    const lost = readdirSync(join(directory, 'files', 'crm', 'deals')).find((name) =>
      name.endsWith('.parquet'),
    );
    rmSync(join(directory, 'files', 'crm', 'deals', lost ?? ''));
  });
  afterAll(dispose);

  it('reports the tables of the schema and none of the other, with the facts of the schema as its own', async () => {
    const report = await checkScope({ kind: 'schema', schemaId: shop });

    expect(tables(report)).toEqual(['shop.events']);
    expect(report.findings.some((item) => /crm/.test(`${item.id} ${item.detail}`))).toBe(false);
    expect(report.findings.map((item) => item.check)).toEqual(
      expect.arrayContaining(['catalog.small-files', 'catalog.auto-compact-off', 'storage.file-orphaned']),
    );
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
    const orphan = report.findings.find((item) => item.check === 'storage.file-orphaned');
    expect(orphan?.scope).toEqual({ kind: 'schema', id: shop, name: 'shop' });
  });

  it('finds the lost file in the schema that lost it only', async () => {
    const mine = await checkScope({ kind: 'schema', schemaId: crm });
    const other = await checkScope({ kind: 'schema', schemaId: shop });

    expect(tables(mine)).toEqual(['crm.contacts', 'crm.deals']);
    expect(mine.findings.filter((item) => item.check === 'storage.file-missing').map(tableOf)).toEqual([
      'crm.deals',
    ]);
    expect(other.findings.map((item) => item.check)).not.toContain('storage.file-missing');
  });

  it('adds up to the report of the lake for the findings about tables', async () => {
    const whole = await check();
    const parts = [
      ...(await checkScope({ kind: 'schema', schemaId: shop })).findings,
      ...(await checkScope({ kind: 'schema', schemaId: crm })).findings,
    ];
    const ofTables = (items: readonly HealthFinding[]): string[] =>
      items
        .filter((item) => item.scope.kind === 'table')
        .map((item) => item.id)
        .toSorted();

    expect(ofTables(parts)).toEqual(ofTables(whole.findings));
  });

  it('shows what belongs to the whole lake as lake findings, which a table report leaves out', async () => {
    // The creation and the insert of the dropped table: its file is then needed by no snapshot, and the numbering has a gap.
    const newest = await query("SELECT max(snapshot_id) AS id FROM ducklake_snapshots('lake')");
    const last = Number(newest[0]?.id);
    await stage([`CALL ducklake_expire_snapshots('lake', versions => [${last - 2}, ${last - 1}])`]);
    const ids = await tableIds();

    const report = await checkScope({ kind: 'schema', schemaId: shop });
    const lake = report.findings.filter((item) => item.scope.kind === 'lake').map((item) => item.check);
    expect(lake).toContain('catalog.snapshot-gaps');
    expect(lake).toContain('catalog.cleanup-pending');
    const single = await check(ids.get('events'));
    expect(single.findings.map((item) => item.check)).not.toContain('catalog.snapshot-gaps');
  });
});

// A schema whose tables are all gone keeps its options and its directory: it still needs a name in the report.
describe.skipIf(skipReason)('the health check of a lake with a schema that has no table', () => {
  const { stage, schemaIds, checkScope, dispose } = createLake('aantje-healthnotables-');
  let archive = 0;

  beforeAll(async () => {
    await stage([
      'CREATE SCHEMA archive',
      'CREATE TABLE archive.old (id INT)',
      'INSERT INTO archive.old VALUES (1)',
      'DROP TABLE archive.old',
      "CALL lake.set_option('auto_compact', false, schema => 'archive')",
    ]);
    archive = (await schemaIds()).get('archive') ?? 0;
  });
  afterAll(dispose);

  it('reports auto_compact=false of the schema in the report of the lake and in its own report, under its name', async () => {
    for (const scope of [{ kind: 'lake' }, { kind: 'schema', schemaId: archive }] as const) {
      const report = await checkScope(scope);
      const off = report.findings.filter((item) => item.check === 'catalog.auto-compact-off');
      expect(
        off.map((item) => item.id),
        scope.kind,
      ).toEqual([`catalog.auto-compact-off:schema:${archive}`]);
      expect(JSON.stringify(report.findings)).not.toContain(`#${archive}`);
    }
  });
});
