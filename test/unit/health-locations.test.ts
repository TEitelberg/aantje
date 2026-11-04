import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withLakeSession } from '../../src/data/engine';
import { comparable } from '../../src/health/storage-checks';
import {
  fileLocation,
  isBelowDataPath,
  isNetworkPath,
  joinPath,
  tableDirectory,
} from '../../src/catalog/locations';
import { accessFor, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { editCatalog, readerOf } from './health-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`File location tests are skipped: ${skipReason}`);
}

describe('joining the stored paths', () => {
  it('puts one slash between the parts, hangs relative paths below their parent and lets absolute ones stand', () => {
    expect(joinPath('s3://bucket/lake', 'shop/')).toBe('s3://bucket/lake/shop/');
    expect(joinPath('s3://bucket/lake/', 'shop/')).toBe('s3://bucket/lake/shop/');
    expect(joinPath('', 'shop/')).toBe('shop/');

    const schema = { path: 'shop/', relative: true };
    const table = { path: 'events/', relative: true };
    const file = { path: 'a.parquet', relative: true };

    expect(fileLocation('/data/', schema, table, file)).toBe('/data/shop/events/a.parquet');
    expect(tableDirectory('/data', schema, table)).toBe('/data/shop/events/');
    expect(
      tableDirectory('/data', { path: 'shop', relative: true }, { path: 'events', relative: true }),
    ).toBe('/data/shop/events/');
    expect(tableDirectory('/data', schema, { path: 's3://other/events', relative: false })).toBe(
      's3://other/events/',
    );
    expect(fileLocation('/data/', schema, table, { path: '/elsewhere/b.parquet', relative: false })).toBe(
      '/elsewhere/b.parquet',
    );
    expect(fileLocation('/data/', schema, { path: 's3://other/t/', relative: false }, file)).toBe(
      's3://other/t/a.parquet',
    );
    expect(fileLocation('/data/', { path: 'gs://bucket/s/', relative: false }, table, file)).toBe(
      'gs://bucket/s/events/a.parquet',
    );
  });
});

describe('the files below the data path', () => {
  it('accepts paths below the data path and refuses everything else', () => {
    const B = String.fromCharCode(92);
    const cases: Array<[string, string | null, boolean]> = [
      ['/data/lake/shop/a.parquet', '/data/lake', true],
      ['/data/lake/shop/a.parquet', '/data/lake/', true],
      ['s3://bucket/lake/a.parquet', 's3://bucket/lake/', true],
      [`D:${B}lake${B}a.parquet`, 'D:/lake/', true],
      ['/data/lake/a..b.parquet', '/data/lake/', true],
      ['/etc/passwd', '/data/lake/', false],
      ['/data/lake-other/a.parquet', '/data/lake', false],
      ['http://127.0.0.1:9/a.parquet', '/data/lake/', false],
      ['s3://other/lake/a.parquet', 's3://bucket/lake/', false],
      ['/data/lake/../outside.parquet', '/data/lake/', false],
      [`/data/lake/a${B}..${B}b.parquet`, '/data/lake/', false],
      ['/data/lake/a.parquet', null, false],
      ['/data/lake/a.parquet', '', false],
      [`/data/lake/a${String.fromCharCode(0)}.parquet`, '/data/lake', false],
      [`/data/lake/a${String.fromCharCode(10)}.parquet`, '/data/lake', false],
      // a network data path holds only paths of that very share, a local one never holds a share
      [`${B}${B}h${B}s${B}lake${B}a.parquet`, `${B}${B}h${B}s${B}lake`, true],
      [`${B}${B}h2${B}s${B}lake${B}a.parquet`, `${B}${B}h${B}s${B}lake`, false],
      [`${B}${B}h${B}s${B}lake${B}a.parquet`, '/data/lake', false],
      [' //h/s/lake/a.parquet', '//h/s/lake', false],
    ];
    for (const [path, dataPath, expected] of cases) {
      expect(isBelowDataPath(path, dataPath), `${path} below ${dataPath}`).toBe(expected);
    }
  });
});

/** The files that DuckLake itself lists for every table of the lake: the oracle for the places the reader computes. */
describe.skipIf(skipReason)('the places of the files against ducklake_list_files', () => {
  const fixtures: DataFixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.remove()));
  });

  async function compare(fixture: DataFixture): Promise<{ checked: number; tables: string[] }> {
    const reader = await readerOf(fixture);
    try {
      const latest = (await reader.info()).latestSnapshot;
      const tables = (await reader.entries(latest)).filter((entry) => entry.kind === 'table');
      const { dataPath } = await reader.properties();
      const all = await reader.fileLocations({}, dataPath, 1000);
      let checked = 0;
      await withLakeSession(accessFor(fixture), undefined, async (session) => {
        for (const table of tables) {
          const rows = await session.rows(
            `SELECT data_file, delete_file FROM ducklake_list_files('lake', '${table.name}', schema => '${table.schemaName}')`,
          );
          const oracle = rows
            .flatMap(([data, deleted]) => [data, deleted])
            .filter((path): path is string => typeof path === 'string')
            .map((path) => comparable(path, false))
            .sort();
          const mine = all.files
            .filter((file) => file.tableId === table.id && file.endSnapshot === null)
            .map((file) => comparable(file.location ?? '', false))
            .sort();
          expect(mine, `${table.schemaName}.${table.name}`).toEqual(oracle);
          // Another read of just this table gives the same directory and files.
          const own = await reader.fileLocations({ tableId: table.id }, dataPath, 1000);
          expect(own.files.map((file) => file.id).sort()).toEqual(
            all.files
              .filter((file) => file.tableId === table.id)
              .map((file) => file.id)
              .sort(),
          );
          expect(own.directory).not.toBeNull();
          checked += oracle.length;
        }
      });
      return { checked, tables: tables.map((table) => `${table.schemaName}.${table.name}`) };
    } finally {
      await reader.close();
    }
  }

  it('is the same for every table of the history fixture: partitioned, renamed, with a delete file, compacted', async () => {
    const fixture = await copyHistoryFixture('sqlite');
    fixtures.push(fixture);

    const result = await compare(fixture);

    expect(result.tables).toEqual([
      'main.evolved',
      'shop.audit',
      'shop.customers',
      'shop.events',
      'shop.log',
      'shop.notes',
      'shop.readings',
    ]);
    // 9 events, 5 customers (four data files and the delete file), 2 evolved, 1 audit, 2 log, 1 readings; notes is inlined.
    expect(result.checked).toBe(20);
  });

  it('is the same for a catalog with DuckDB metadata', async () => {
    const fixture = await copyHistoryFixture('duckdb');
    fixtures.push(fixture);
    // The reader of the test opens SQLite catalogs; the DuckDB one is read through the contract tests. The oracle for it:
    const { openDuckdb } = await import('../../src/catalog/drivers/duckdb');
    const { createCatalogReader } = await import('../../src/catalog/reader');
    const reader = createCatalogReader(await openDuckdb({ path: fixture.profile.path }));
    try {
      const all = await reader.fileLocations({}, (await reader.properties()).dataPath, 1000);
      const rows = await withLakeSession(accessFor(fixture), undefined, (session) =>
        session.rows(`SELECT data_file FROM ducklake_list_files('lake', 'events', schema => 'shop')`),
      );
      const mine = all.files
        .filter((file) => file.tableId === 3 && file.endSnapshot === null)
        .map((file) => comparable(file.location ?? '', false))
        .sort();
      expect(mine).toEqual(rows.map(([path]) => comparable(String(path), false)).sort());
      expect(mine).toHaveLength(9);
    } finally {
      await reader.close();
    }
  });

  it('is the same with absolute paths at every level and a data path without a trailing slash', async () => {
    const fixture = await copyHistoryFixture('sqlite');
    fixtures.push(fixture);
    const files = join(fixture.directory, 'sqlite-files').replaceAll('\\', '/');
    await editCatalog(fixture, [
      // the data path loses its slash
      `UPDATE meta.ducklake_metadata SET value = '${files}' WHERE key = 'data_path'`,
      // schema shop: absolute; table log: absolute below it; a file of customers: absolute
      `UPDATE meta.ducklake_schema SET path = '${files}/shop/', path_is_relative = 0 WHERE schema_name = 'shop'`,
      `UPDATE meta.ducklake_table SET path = '${files}/shop/log/', path_is_relative = 0 WHERE table_name = 'log'`,
      `UPDATE meta.ducklake_data_file SET path = '${files}/shop/customers/' || path, path_is_relative = 0 WHERE table_id = 9`,
    ]);

    const result = await compare(fixture);

    expect(result.checked).toBe(20);
  });
});

describe('a path that names a network host', () => {
  const B = String.fromCharCode(92);
  const host = '10.255.255.1';

  it('is recognised in every spelling and not claimed for local or scheme paths', () => {
    const network = [
      `${B}${B}${host}${B}share${B}f.parquet`,
      `//${host}/share/f.parquet`,
      `/${B}${host}/share`,
      `${B}/${host}${B}share`,
      `${B}${B}?${B}UNC${B}${host}${B}share`,
      `${B}${B}?${B}unc${B}${host}${B}share`,
      `${B}${B}.${B}pipe${B}x`,
      `${B}${B}${host}@80${B}DavWWWRoot${B}f`,
      `${B}${B}${host}@SSL${B}f`,
      ` ${B}${B}${host}${B}share`,
      `${String.fromCharCode(9)}//${host}/share`,
      `${String.fromCharCode(160)}//${host}/share`,
      `${String.fromCharCode(0)}${B}${B}${host}${B}share`,
    ];
    const local = [
      '/data/lake/a.parquet',
      'C:/data/lake',
      `C:${B}data${B}lake`,
      'relative/dir',
      's3://bucket/lake',
      'https://host/lake',
      `${B}single${B}root`,
      '/single/root//double/inside',
      '',
    ];
    for (const path of network) {
      expect(isNetworkPath(path), JSON.stringify(path)).toBe(true);
    }
    for (const path of local) {
      expect(isNetworkPath(path), JSON.stringify(path)).toBe(false);
    }
  });
});
