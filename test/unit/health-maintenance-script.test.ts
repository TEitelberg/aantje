import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HealthReport } from '../../src/health/model';
import { maintenanceScriptOf } from '../../src/health/maintenance-script';
import { engineSkipReason } from './data-support';
import { createLake } from './health-lake-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Maintenance script lake tests are skipped: ${skipReason}`);
}

const INSERTS = (table: string): string[] =>
  [1, 2, 3, 4, 5, 6].map((n) => `INSERT INTO ${table} VALUES (${n})`);

/** What a user does with the script: the dry runs go, the real calls are uncommented, and the explicit age is 0 so that today's files are not spared. */
function runnable(script: string): string[] {
  return script
    .split('\n')
    .filter((line) => !line.includes('dry_run => true'))
    .map((line) => line.replace(/^-- (CALL .*)$/, '$1').replace(/INTERVAL (?:30|7) DAY/g, 'INTERVAL 0 DAY'))
    .filter((line) => line !== '' && !line.startsWith('--'));
}

const checks = (report: HealthReport): string[] => report.findings.map((finding) => finding.check);

describe.skipIf(skipReason)('the maintenance script for the findings of a real lake', () => {
  const lake = createLake('aantje-healthscript-');
  afterAll(lake.dispose);

  beforeAll(async () => {
    await lake.stage([
      'CREATE SCHEMA shop',
      'CREATE TABLE shop.small (a INT)',
      'CREATE TABLE shop.off (a INT)',
      'CREATE TABLE shop.inl (a INT)',
      'CREATE TABLE shop.lost (a INT)',
      ...INSERTS('shop.small'),
      ...INSERTS('shop.off'),
      "CALL lake.set_option('auto_compact', false, table_name => 'off', schema => 'shop')",
      "CALL lake.set_option('data_inlining_row_limit', 20000, table_name => 'inl', schema => 'shop')",
      'INSERT INTO shop.inl SELECT range FROM range(10001)',
      'INSERT INTO shop.lost VALUES (1)',
    ]);
    const stray = join(lake.directory, 'files', 'main');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'stray.parquet'), 'not a parquet file');
    const lostDirectory = join(lake.directory, 'files', 'shop', 'lost');
    for (const file of readdirSync(lostDirectory)) rmSync(join(lostDirectory, file));
  });

  it('puts the option first, the compaction before the cleanup and the orphans last, and lists the lost file as a decision', async () => {
    const report = await lake.check();
    const script = maintenanceScriptOf(report.findings) ?? '';

    const at = (text: string): number => script.indexOf(text);
    const order = [
      "set_option('lake', 'auto_compact', true",
      'ducklake_merge_adjacent_files',
      'ducklake_delete_orphaned_files',
    ].map(at);
    expect(order.every((position) => position > 0)).toBe(true);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(script.indexOf('-- These findings need a decision')).toBeGreaterThan(0);
    expect(script.indexOf('-- These findings need a decision')).toBeLessThan(order[0] ?? 0);
    expect(script).toContain('storage.file-missing');
    // Destructive calls: the dry run is active and the real call is commented out.
    expect(script).toMatch(/^CALL ducklake_delete_orphaned_files\('lake', dry_run => true\);$/m);
    expect(script).toMatch(/^-- CALL ducklake_delete_orphaned_files\('lake'\);$/m);
  });

  it('removes the findings it covers when it runs, and the cleanup that the merge makes necessary goes in the next script', async () => {
    const first = await lake.check();
    const covered = ['catalog.auto-compact-off', 'catalog.small-files', 'catalog.large-inlined-data'];
    expect(covered.every((check) => checks(first).includes(check))).toBe(true);

    await lake.stage(runnable(maintenanceScriptOf(first.findings) ?? ''));

    const second = await lake.check();
    expect(checks(second).filter((check) => covered.includes(check))).toEqual([]);
    expect(checks(second)).not.toContain('storage.file-orphaned');
    expect(checks(second)).toContain('catalog.cleanup-pending');

    await lake.stage(runnable(maintenanceScriptOf(second.findings) ?? ''));

    expect(checks(await lake.check())).not.toContain('catalog.cleanup-pending');
  });
});
