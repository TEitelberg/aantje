import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { checkFixture, editCatalog, ids, lake } from './health-support';
import { copyHistoryFixture } from './history-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check foreign path tests are skipped: ${skipReason}`);
}

describe.skipIf(skipReason)('the health check on a catalog that names files outside the data path', () => {
  let fixture: DataFixture;
  let files: string;
  let probe: Server;
  let requests: string[];
  let url: string;

  beforeEach(async () => {
    fixture = await copyHistoryFixture('sqlite');
    files = join(fixture.directory, 'sqlite-files');
    requests = [];
    probe = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('content-length', '5');
      response.end(request.method === 'HEAD' ? undefined : 'hello');
    });
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await fixture.remove();
  });

  async function parquet(path: string, query: string): Promise<void> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run(`COPY (${query}) TO '${path.replaceAll("'", "''")}' (FORMAT parquet)`);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  const absolute = (id: number, path: string): string =>
    `UPDATE meta.ducklake_data_file SET path = '${path}', path_is_relative = 0 WHERE data_file_id = ${id}`;

  it('opens no file outside the data path in the deep check: a URL, a path with .., a path elsewhere', async () => {
    const elsewhere = join(fixture.directory, 'elsewhere');
    mkdirSync(elsewhere);
    // Garbage with a Parquet name: if the check opened it, it would report it as unreadable.
    writeFileSync(join(elsewhere, 'garbage.parquet'), 'x'.repeat(200));
    const toolong = `${files.replaceAll('\\', '/')}/../elsewhere/garbage.parquet`;
    await editCatalog(fixture, [
      absolute(0, `${url}/probe.parquet`),
      absolute(1, toolong),
      absolute(4, join(elsewhere, 'garbage.parquet').replaceAll('\\', '/')),
    ]);

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(requests).toEqual([]);
    expect(ids(report, 'deep')).toEqual([]);
    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done', notChecked: 3 });
    expect(report.groups[2]).toMatchObject({ group: 'storage', state: 'done', notChecked: 3 });
  });

  it('counts a valid Parquet file outside the data path as not checked and reads nothing of it', async () => {
    const elsewhere = join(fixture.directory, 'elsewhere');
    mkdirSync(elsewhere);
    // The catalog records 3 rows for file 0; this file holds 5. A read would report the mismatch.
    const path = join(elsewhere, 'added.parquet').replaceAll('\\', '/');
    await parquet(path, 'SELECT range AS id FROM range(5)');
    await editCatalog(fixture, [absolute(0, path)]);

    const report = await checkFixture(fixture, { scope: lake, depth: 'deep' });

    expect(ids(report, 'deep')).toEqual([]);
    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done', notChecked: 1 });
  });

  it('lists no directory outside the data path for a table whose path is a URL', async () => {
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_table SET path = '${url}/events/', path_is_relative = 0 WHERE table_id = 3`,
    ]);

    const report = await checkFixture(fixture, {
      scope: { kind: 'table', tableId: 3 },
      depth: 'deep',
    });

    expect(requests).toEqual([]);
    expect(report.groups[2]).toEqual({
      group: 'storage',
      state: 'skipped',
      reason: 'The directory of the table lies outside the data path, so it is not listed.',
    });
    expect(ids(report, 'deep')).toEqual([]);
    expect(report.groups[3]).toMatchObject({ group: 'deep', state: 'done' });
    expect(report.groups[3]?.notChecked).toBeGreaterThan(0);
  });
});
