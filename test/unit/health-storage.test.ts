import { readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import type { HealthFinding, HealthReport } from '../../src/health/model';
import { engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, editCatalog, ids, lake, NOW, problems } from './health-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check storage tests are skipped: ${skipReason}`);
}

const HEALTHY_INFOS = ['catalog.cleanup-pending', 'catalog.small-files:table:3'];

const EVENTS_FILE = 'shop/events/kind=click/year=2025/ducklake-01a18cd6-3c4f-7d55-94b2-e4f075f8b0d6.parquet';
const CUSTOMERS_DELETE_FILE = 'shop/customers/ducklake-01a18cd6-3de1-751e-828c-76b7ae4e68ee-delete.parquet';
const OLD_STUFF_FILE = 'shop/old_stuff/ducklake-01a18cd6-426f-79df-8103-ccd041b47cd7.parquet';

const find = (report: HealthReport, check: string): HealthFinding[] =>
  report.findings.filter((item) => item.check === check);

describe.skipIf(skipReason)('the files in the store against the catalog, on a lake on the local disk', () => {
  const fixtures: DataFixture[] = [];
  const open = async (
    kind: 'sqlite' | 'duckdb' = 'sqlite',
  ): Promise<{ fixture: DataFixture; files: string }> => {
    const fixture = await copyHistoryFixture(kind);
    fixtures.push(fixture);
    return { fixture, files: join(fixture.directory, `${kind}-files`) };
  };
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
  });
  const unrooted = (files: string, id: string): string => id.replace(files.replaceAll('\\', '/'), '<files>');

  // The golden run per catalog kind: the whole report of the healthy fixture, with the deep check.
  it.each(['sqlite', 'duckdb'] as const)(
    'finds nothing wrong in the healthy history fixture (%s metadata), not even with the deep check',
    async (kind) => {
      const { fixture, files } = await open(kind);
      const reader =
        kind === 'sqlite' ? undefined : createCatalogReader(await openDuckdb({ path: fixture.profile.path }));
      try {
        const report = await checkFixture(
          fixture,
          { scope: lake, depth: 'deep' },
          {},
          reader ? { reader } : {},
        );

        expect(problems(report)).toEqual([]);
        expect(ids(report)).toEqual(HEALTHY_INFOS);
        expect(report.groups).toEqual([
          { group: 'catalog', state: 'done' },
          { group: 'connection', state: 'done' },
          { group: 'storage', state: 'done' },
          { group: 'deep', state: 'done' },
        ]);
        expect(report.summary).toMatchObject({
          errors: 0,
          warnings: 0,
          infos: 2,
          omitted: 0,
          cancelled: false,
        });
        expect(report.snapshot).toBe(56);
        // The four files that the merge replaced are still in the store next to the two that are in use: no orphans.
        expect(readdirSync(join(files, 'shop/log'))).toHaveLength(6);
      } finally {
        await reader?.close();
      }
    },
  );

  it('names a data file and a delete file that the store lost: the table, the key and the SQL to inspect them', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    rmSync(join(files, CUSTOMERS_DELETE_FILE));

    const report = await checkFixture(fixture, { scope: lake });

    // In key order: shop/customers before shop/events.
    const missing = find(report, 'storage.file-missing');
    expect(missing.map((item) => [item.id, item.severity])).toEqual([
      ['storage.file-missing:delete:12', 'error'],
      ['storage.file-missing:data:0', 'error'],
    ]);
    expect(missing[1]).toMatchObject({
      group: 'storage',
      scope: { kind: 'table', id: 3, schema: 'shop', name: 'events' },
      objectKey: `${files.replaceAll('\\', '/')}/${EVENTS_FILE}`,
      inspectSql: 'SELECT * FROM __ducklake_metadata_lake.ducklake_data_file WHERE data_file_id = 0;',
    });
    expect(missing[1]?.detail).toContain('@6 to @56');
    expect(missing[0]?.detail).toContain('shop.customers');
    expect(report.summary).toMatchObject({ errors: 2, warnings: 0 });
  });

  it('calls a lost file that only older snapshots need a warning', async () => {
    const { fixture, files } = await open();
    // The file of the dropped table shop.old_stuff (snapshot 44 only) is kept for time travel.
    rmSync(join(files, OLD_STUFF_FILE));

    const report = await checkFixture(fixture, { scope: lake });

    expect(find(report, 'storage.file-missing').map((item) => [item.id, item.severity])).toEqual([
      ['storage.file-missing:data:21', 'warning'],
    ]);
    expect(find(report, 'storage.file-missing')[0]?.detail).toContain('@44');
    expect(report.summary).toMatchObject({ errors: 0, warnings: 1 });
  });

  it('reports a file that is in no row of the catalog as a hint, with its size and age, and a file of another size as an error', async () => {
    const { fixture, files } = await open();
    const stray = join(files, 'shop/events/ducklake-stray.parquet');
    writeFileSync(stray, 'x'.repeat(2048));
    const old = new Date(NOW.getTime() - 2 * 86_400_000);
    utimesSync(stray, old, old);
    const fresh = join(files, 'shop/customers/ducklake-upload-in-progress.parquet');
    writeFileSync(fresh, 'y');
    utimesSync(fresh, new Date(NOW.getTime() - 5 * 60_000), new Date(NOW.getTime() - 5 * 60_000));
    writeFileSync(join(files, EVENTS_FILE), 'cut off');

    const report = await checkFixture(fixture, { scope: lake });

    const orphans = find(report, 'storage.file-orphaned');
    expect(orphans.map((item) => [unrooted(files, item.id), item.severity, item.scope])).toEqual([
      ['storage.file-orphaned:<files>/shop/customers/ducklake-upload-in-progress.parquet', 'info', lake],
      ['storage.file-orphaned:<files>/shop/events/ducklake-stray.parquet', 'info', lake],
    ]);
    expect(orphans[0]?.detail).toContain('1 B');
    expect(orphans[0]?.detail).toContain('5 minutes ago');
    expect(orphans[1]?.detail).toContain('2 KB');
    expect(orphans[1]?.detail).toContain('2 days ago');
    const resized = find(report, 'storage.file-size-mismatch');
    expect(resized.map((item) => [item.id, item.severity])).toEqual([
      ['storage.file-size-mismatch:data:0', 'error'],
    ]);
    expect(resized[0]?.scope).toEqual({ kind: 'table', id: 3, schema: 'shop', name: 'events' });
    expect(resized[0]?.detail).toContain('658');
    expect(resized[0]?.detail).toContain('7 bytes');
  });

  it('checks only the directory of the table in a table scope', async () => {
    const { fixture, files } = await open();
    rmSync(join(files, EVENTS_FILE));
    writeFileSync(join(files, 'shop/events/ducklake-stray.parquet'), 'x');
    writeFileSync(join(files, 'shop/customers/ducklake-stray.parquet'), 'x');

    const events = await checkFixture(fixture, { scope: { kind: 'table', tableId: 3 } });
    const customers = await checkFixture(fixture, { scope: { kind: 'table', tableId: 9 } });

    expect(ids(events, 'storage').map((id) => unrooted(files, id))).toEqual([
      'storage.file-missing:data:0',
      'storage.file-orphaned:<files>/shop/events/ducklake-stray.parquet',
    ]);
    expect(ids(customers, 'storage').map((id) => unrooted(files, id))).toEqual([
      'storage.file-orphaned:<files>/shop/customers/ducklake-stray.parquet',
    ]);
    expect(events.findings.every((item) => item.group !== 'catalog' || item.scope.kind === 'table')).toBe(
      true,
    );
  });

  it('sees a lake with a missing data directory once, not as a flood of missing files, and warns about a relative data path', async () => {
    const { fixture, files } = await open();
    rmSync(files, { recursive: true });
    const gone = await checkFixture(fixture, { scope: lake });

    await editCatalog(fixture, [
      `UPDATE meta.ducklake_metadata SET value = 'no-such-files/' WHERE key = 'data_path'`,
    ]);
    const relative = await checkFixture(fixture, { scope: lake });

    expect(ids(gone, 'connection')).toEqual(['connection.local-path-missing']);
    expect(find(gone, 'connection.local-path-missing')[0]).toMatchObject({
      severity: 'error',
      objectKey: `${files.replaceAll('\\', '/')}/`,
    });
    expect(gone.groups.find((group) => group.group === 'storage')).toMatchObject({ state: 'skipped' });
    expect(ids(gone, 'storage')).toEqual([]);
    expect(ids(relative, 'connection')).toEqual([
      'connection.local-path-missing',
      'connection.relative-data-path',
    ]);
    expect(find(relative, 'connection.relative-data-path')[0]?.severity).toBe('warning');
  });

  it('reports an empty directory as the loss of every file with one finding, names the first lost files and counts the rest', async () => {
    const { fixture, files } = await open();
    for (const entry of readdirSync(files)) rmSync(join(files, entry), { recursive: true });

    const report = await checkFixture(fixture, { scope: lake, limits: { findingsPerCheck: 3 } });

    expect(find(report, 'storage.nothing-found')).toHaveLength(1);
    expect(find(report, 'storage.nothing-found')[0]?.detail).toContain('21 files');
    expect(find(report, 'storage.file-missing')).toHaveLength(3);
    expect(report.groups.find((group) => group.group === 'storage')).toEqual({
      group: 'storage',
      state: 'done',
      omitted: 18,
    });
    expect(report.summary.omitted).toBe(18);
  });

  it('skips the comparison when the catalog lists more files than one run compares', async () => {
    const { fixture } = await open();

    const report = await checkFixture(fixture, { scope: lake, limits: { storageFiles: 10 } });

    expect(report.groups.find((group) => group.group === 'storage')).toMatchObject({
      group: 'storage',
      state: 'skipped',
      truncated: true,
    });
    expect(ids(report, 'storage')).toEqual([]);
  });

  it('compares the first keys in key order when the store holds more files than the limit, and counts the rest', async () => {
    const { fixture, files } = await open();
    for (const name of ['a', 'b', 'c', 'd', 'e'])
      writeFileSync(join(files, `shop/events/ducklake-z${name}.parquet`), name);
    // The file of shop.readings has the last key of the lake: it lies behind the cut.
    const readingsFile = 'shop/readings/ducklake-01a18cd6-3d3d-7bc0-a8cb-a585964b8400.parquet';
    rmSync(join(files, readingsFile));
    const uncut = await checkFixture(fixture, { scope: lake });
    expect(find(uncut, 'storage.file-missing').map((item) => item.id)).toEqual([
      'storage.file-missing:data:8',
    ]);

    const all = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? all(join(dir, entry.name)) : [join(dir, entry.name).replaceAll('\\', '/')],
      );
    const base = files.replaceAll('\\', '/');
    const keys = all(files).toSorted(); // 20 catalog files, 5 scheduled and 5 strays: the readings file is gone
    expect(keys).toHaveLength(30);
    const cutAfter = keys[24] ?? '';

    const cut = await checkFixture(fixture, { scope: lake, limits: { storageFiles: 25 } });

    // Of the 21 files of the catalog (the lost one included) these lie behind the 25th key of the store.
    const scheduled = [
      'customers/ducklake-01a18cd6-3dc9-72f6-ab52-067c9f858bf1-delete',
      'log/ducklake-01a18cd6-436a-7d07',
      'log/ducklake-01a18cd6-437a-7ec6',
      'log/ducklake-01a18cd6-438e-7203',
      'log/ducklake-01a18cd6-43a0-7e23',
    ];
    const known = [...keys, `${base}/${readingsFile}`]
      .filter((key) => !key.includes('-z') && !scheduled.some((name) => key.includes(name)))
      .filter((key) => key > cutAfter);
    expect(known.length).toBeGreaterThan(1);
    expect(cut.groups.find((group) => group.group === 'storage')).toEqual({
      group: 'storage',
      state: 'done',
      truncated: true,
      notChecked: known.length,
    });
    expect(find(cut, 'storage.file-missing')).toEqual([]);
    expect(find(cut, 'storage.file-orphaned')).toHaveLength(5);
  });
});
