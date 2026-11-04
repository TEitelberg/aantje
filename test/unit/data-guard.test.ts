import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupStatements } from '../../src/data/attach';
import { describeRelation, previewTable, readChanges } from '../../src/data/engine';
import { guardRelation } from '../../src/data/guard';
import { AantjeError } from '../../src/errors';
import { accessFor, copyDataFixture, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';
import { editCatalog, startFakeStore } from './health-support';
import type { FakeStore } from './health-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Data guard tests are skipped: ${skipReason}`);
}

const BUCKET = 'example-lake';
const orders = { schema: 'sales', table: 'orders' };
const credentials = { keyId: 'AKIAGUARDKEYID', secretKey: 'guard-secret' };

interface OtherServer {
  readonly origin: string;
  readonly requests: string[];
  close(): Promise<void>;
}

/** A server that is not the configured endpoint: it counts what it is asked, so that a test sees any request that leaves. */
async function startOtherServer(): Promise<OtherServer> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Puts the first data file of `sales.orders` at `path`, absolute. */
const moveOrdersFile = (path: string): string =>
  `UPDATE meta.ducklake_data_file SET path = '${path}', path_is_relative = 0 WHERE data_file_id = (SELECT min(data_file_id) FROM meta.ducklake_data_file WHERE table_id = (SELECT table_id FROM meta.ducklake_table WHERE table_name = 'orders'))`;

/** Writes to the lake of a fixture copy as its author would: through DuckLake, writable, each statement a snapshot. */
async function writeLake(fixture: DataFixture, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    await connection.run('LOAD ducklake');
    await connection.run('LOAD sqlite');
    await connection.run(`ATTACH 'ducklake:sqlite:${fixture.profile.path.replaceAll("'", "''")}' AS lake`);
    for (const sql of statements) {
      await connection.run(sql);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

async function refusal(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe.skipIf(skipReason)('a lake whose catalog names a file on another server', () => {
  let fixture: DataFixture;
  let store: FakeStore;
  let other: OtherServer;

  beforeEach(async () => {
    fixture = await copyDataFixture('sqlite', `s3://${BUCKET}/ducklake/`);
    store = await startFakeStore(join(fixture.directory, 'sqlite-files'), BUCKET, 'ducklake');
    other = await startOtherServer();
  });
  afterEach(async () => {
    await store.close();
    await other.close();
    await fixture.remove();
  });

  const access = () =>
    accessFor(fixture, {
      s3: { endpoint: store.endpoint, urlStyle: 'path' },
      s3Credentials: credentials,
    });

  it('sends the request when nothing guards the read: an address in the catalog is fetched (why the guard exists)', async () => {
    await editCatalog(fixture, [moveOrdersFile(`${other.origin}/evil.parquet`)]);
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of setupStatements(access())) {
        await connection.run(sql);
      }
      await connection.run('SELECT * FROM lake.sales.orders LIMIT 5').catch(() => undefined);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    expect(other.requests).toEqual(['GET /evil.parquet']);
  });

  it('refuses an http, hf://, gs:// or https address in a data file or a delete file, and sends no request anywhere', async () => {
    // A delete file of the table counts the same.
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_delete_file SET path = '${other.origin}/evil-delete.parquet', path_is_relative = 0 WHERE table_id = (SELECT table_id FROM meta.ducklake_table WHERE table_name = 'orders')`,
    ]);
    await refusal(previewTable(access(), orders));

    const addresses = [
      `${other.origin}/evil.parquet`,
      'hf://datasets/evil/data/x.parquet',
      'gs://evil-bucket/x.parquet',
      'https://169.254.169.254/latest/meta-data/x.parquet',
    ];
    for (const address of addresses) {
      await editCatalog(fixture, [moveOrdersFile(address)]);

      for (const run of [
        () => previewTable(access(), orders),
        () => describeRelation(access(), orders),
        () => readChanges(access(), orders, { from: 1, to: 6 }),
      ]) {
        const error = await refusal(run());
        expect(error.code, address).toBe('QUERY_FAILED');
        expect(error.userMessage, address).toContain('sales.orders');
      }
    }

    expect(other.requests).toEqual([]);
    expect(store.requests).toEqual([]);
  });

  it('refuses Show Changes when a file the range reads lies on another server, even if it is gone at the newest snapshot', async () => {
    // A data file that lives only for snapshots [2, 3) points at the other server: `table_changes` over @1 -> @3 reads
    // it, although the newest snapshot no longer lists it. The range guard must still catch it.
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_data_file SET path = '${other.origin}/mid.parquet', path_is_relative = 0, begin_snapshot = 2, end_snapshot = 3 WHERE data_file_id = (SELECT min(data_file_id) FROM meta.ducklake_data_file WHERE table_id = (SELECT table_id FROM meta.ducklake_table WHERE table_name = 'orders'))`,
    ]);

    const error = await refusal(readChanges(access(), orders, { from: 1, to: 3 }));

    expect(error.code).toBe('QUERY_FAILED');
    expect(error.userMessage).toContain('sales.orders');
    expect(other.requests).toEqual([]);
    expect(store.requests).toEqual([]);
  });

  // `table_changes` binds the table name at the end of the range, so a table that was renamed or dropped after `to`
  // still resolves there and its files are read. The guard must judge the relation at `to`, not at the newest snapshot,
  // where the name finds nothing and every check would be skipped.
  it('refuses Show Changes of a table that was renamed, and then dropped, after the end of the range', async () => {
    await editCatalog(fixture, [moveOrdersFile(`${other.origin}/evil.parquet`)]);

    // The fixture has the snapshots 0 to 13; the changes below are the snapshots 14 and 15.
    for (const statement of [
      'ALTER TABLE lake.sales.orders RENAME TO orders_later',
      'DROP TABLE lake.sales.orders_later',
    ]) {
      await writeLake(fixture, [statement]);

      const error = await refusal(readChanges(access(), orders, { from: 1, to: 13 }));

      expect(error.code, statement).toBe('QUERY_FAILED');
      expect(error.userMessage, statement).toContain('sales.orders');
    }
    expect(other.requests).toEqual([]);
    expect(store.requests).toEqual([]);
  });

  it('refuses a trusted view over a table whose file lies on another server, also through a nested view or a macro, and sends no request', async () => {
    await editCatalog(fixture, [moveOrdersFile(`${other.origin}/evil.parquet`)]);
    // `sales.big_orders` is the view of the fixture over `sales.orders`; the others nest it or reach the table via a macro.
    await writeLake(fixture, [
      'CREATE VIEW lake.sales.nested AS SELECT count(*) AS n FROM lake.sales.big_orders',
      'CREATE MACRO lake.sales.all_orders() AS TABLE SELECT * FROM lake.sales.orders',
      'CREATE VIEW lake.sales.via_macro AS SELECT * FROM lake.sales.all_orders()',
    ]);
    other.requests.length = 0;

    for (const view of ['big_orders', 'nested', 'via_macro']) {
      for (const run of [
        () => previewTable(access(), { schema: 'sales', table: view }),
        () => describeRelation(access(), { schema: 'sales', table: view }),
      ]) {
        const error = await refusal(run());
        expect(error.code, view).toBe('QUERY_FAILED');
        expect(error.userMessage, view).toContain(`sales.${view}`);
        expect(error.userMessage, view).toContain('sales.orders');
      }
    }

    expect(other.requests).toEqual([]);
    expect(store.requests).toEqual([]);
  });

  it('lets through what the settings allow: a file in another bucket of the configured store goes to that endpoint with the keys, and the table reads as before', async () => {
    expect((await previewTable(access(), orders)).rows).toHaveLength(2);

    await editCatalog(fixture, [moveOrdersFile('s3://other-bucket/evil.parquet')]);
    store.requests.length = 0;
    const error = await refusal(previewTable(access(), orders));

    expect(error.userMessage).toContain('s3://other-bucket/evil.parquet');
    expect(store.requests.map((line) => line.split('?')[0])).toEqual(['GET /other-bucket/evil.parquet']);
    expect(other.requests).toEqual([]);
  });
});

describe.skipIf(skipReason)('a lake whose data path is an http address', () => {
  let fixture: DataFixture;
  let store: FakeStore;
  let other: OtherServer;

  beforeEach(async () => {
    fixture = await copyDataFixture('sqlite');
    store = await startFakeStore(join(fixture.directory, 'sqlite-files'), BUCKET, 'ducklake');
    other = await startOtherServer();
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_metadata SET value = '${store.endpoint}/${BUCKET}/ducklake/' WHERE key = 'data_path'`,
    ]);
  });
  afterEach(async () => {
    await store.close();
    await other.close();
    await fixture.remove();
  });

  it('reads the files below its own address, and only those', async () => {
    expect((await previewTable(accessFor(fixture), orders)).rows).toHaveLength(2);

    await editCatalog(fixture, [moveOrdersFile(`${other.origin}/evil.parquet`)]);
    const error = await refusal(previewTable(accessFor(fixture), orders));

    expect(error.code).toBe('QUERY_FAILED');
    expect(other.requests).toEqual([]);
  });
});

// A path with two leading separators names a host without a scheme: the operating system opens it over the network
// (SMB, WebDAV) and a hostile catalog sends the request from this machine. 10.255.255.1 does not answer, so a
// request that was sent hangs until the time limit.
describe.skipIf(skipReason)('a lake whose catalog names a file on a network share', () => {
  let fixture: DataFixture;

  beforeEach(async () => {
    fixture = await copyDataFixture('sqlite');
  });
  afterEach(async () => {
    await fixture.remove();
  });

  const HOST = '10.255.255.1';
  const nbsp = String.fromCharCode(160);
  const B = String.fromCharCode(92);

  /** Whether the guard lets the table through, asked on an engine that is set up like the preview and reads nothing. */
  async function guardOutcome(): Promise<'passes' | AantjeError> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of setupStatements(accessFor(fixture))) {
        await connection.run(sql);
      }
      return await guardRelation(connection, orders, undefined).then(
        () => 'passes' as const,
        (cause: unknown) => cause as AantjeError,
      );
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  it('refuses every spelling of a network path before any request is sent', async () => {
    const addresses = [
      `//${HOST}/share/f.parquet`,
      String.raw`\\${HOST}\share\f.parquet`,
      `/${B}${HOST}/share/f.parquet`,
      `${B}${B}?${B}UNC${B}${HOST}${B}share${B}f.parquet`,
      `${B}${B}?${B}unc${B}${HOST}${B}share${B}f.parquet`,
      `${B}${B}.${B}UNC${B}${HOST}${B}share${B}f.parquet`,
      String.raw`\\${HOST}@80\DavWWWRoot\f.parquet`,
      String.raw` ${nbsp}\\${HOST}\share\f.parquet`,
    ];
    // 10.255.255.1 never answers: a request to it would hang until the network gives up (seconds). Each refusal is
    // timed on its own, so that a busy machine, which slows the 24 engine starts down together, does not count.
    let slowest = 0;
    for (const address of addresses) {
      await editCatalog(fixture, [moveOrdersFile(address.replaceAll("'", "''"))]);

      for (const run of [
        () => previewTable(accessFor(fixture), orders),
        () => describeRelation(accessFor(fixture), orders),
        () => readChanges(accessFor(fixture), orders, { from: 1, to: 6 }),
      ]) {
        const started = performance.now();
        const error = await refusal(run());
        slowest = Math.max(slowest, performance.now() - started);
        expect(error.code, address).toBe('QUERY_FAILED');
        expect(error.userMessage, address).toContain(HOST);
      }
    }

    expect(slowest).toBeLessThan(10_000);
  }, 60_000);

  // `file:` with a real authority resolves to a UNC host (SMB/NTLM), so it follows the same rule as `\\host`; only an
  // empty or `localhost` authority is this machine. The data path of this fixture is a local directory.
  it('refuses a file URL with a host and lets a local one through', async () => {
    const rows: Array<[string, 'refused' | 'passed']> = [
      [`file://${HOST}/share/f.parquet`, 'refused'],
      [`FILE://${HOST}/share/f.parquet`, 'refused'],
      [`file:////${HOST}/share/f.parquet`, 'refused'],
      [`file:/${B}${HOST}/share/f.parquet`, 'refused'],
      ['file:///data/lake/f.parquet', 'passed'],
      ['file://localhost/data/lake/f.parquet', 'passed'],
    ];
    for (const [address, expected] of rows) {
      await editCatalog(fixture, [moveOrdersFile(address.replaceAll("'", "''"))]);

      const outcome = await guardOutcome();

      if (expected === 'passed') {
        expect(outcome, address).toBe('passes');
      } else {
        expect(outcome, address).toBeInstanceOf(AantjeError);
      }
    }
  });

  it('follows the data path of the catalog when that is a share: files on its host pass, files on another host are refused', async () => {
    // The files of the fixture are relative, so they resolve below the share and lie on the host of the data path.
    const share = String.raw`\\${HOST}\share\lake`;
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_metadata SET value = '${share}' WHERE key = 'data_path'`,
    ]);
    expect(await guardOutcome()).toBe('passes');

    // The host is compared without case and with either kind of slash.
    await editCatalog(fixture, [
      `UPDATE meta.ducklake_metadata SET value = '//${HOST.toUpperCase()}/other/' WHERE key = 'data_path'`,
    ]);
    expect(await guardOutcome()).toBe('passes');

    await editCatalog(fixture, [moveOrdersFile(String.raw`\\10.255.255.2\share\f.parquet`)]);
    const error = await guardOutcome();
    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).userMessage).toContain('"//10.255.255.2"');
  });

  it('refuses a share when the data path of the catalog is a local directory', async () => {
    await editCatalog(fixture, [moveOrdersFile(String.raw`\\${HOST}\share\f.parquet`)]);

    const error = await guardOutcome();

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).userMessage).toContain('"//10.255.255.1"');
  });
});
