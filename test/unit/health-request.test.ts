import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogEntry } from '../../src/catalog/model';
import { previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { healthRequestForError, resolveRequest } from '../../src/health/request';
import { accessFor, copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { startFakeStore } from './health-support';
import type { FakeStore } from './health-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check request tests are skipped: ${skipReason}`);
}

const orders = { schema: 'sales', table: 'orders' };

describe('the check that an error message offers', () => {
  it('offers the check of the table that the error names, or of the lake when it names none', () => {
    const forbidden = "HTTP Error: HTTP GET error reading 's3://b/k' (HTTP 403 Forbidden)";
    const lost: Array<[string, string]> = [
      [
        'DuckDB on Windows',
        String.raw`IO Error: Cannot open file "C:\lakes\shop\ducklake-1.parquet": The system cannot find the file specified.`,
      ],
      [
        'DuckDB on Windows, folder gone',
        String.raw`IO Error: Cannot open file "C:\lakes\shop\ducklake-1.parquet": The system cannot find the path specified.`,
      ],
      [
        'DuckDB on Linux',
        'IO Error: Cannot open file "/lake/shop/ducklake-1.parquet": No such file or directory',
      ],
      [
        'the data engine',
        'Cannot read the data of "sales.orders": the catalog lists the data file /lake/a.parquet, but it does not exist on this machine (No such file or directory). Likely causes: x.',
      ],
      [
        'the SQL editor',
        'Cannot read a data file: the file /lake/a.parquet does not exist on this machine (The system cannot find the file specified).',
      ],
    ];
    const rows: Array<[string, string, string]> = [
      [
        'a 404 on the object store',
        'Cannot read a data file: the object store answered HTTP 404 for s3://b/k.parquet.',
        'missing-object',
      ],
      ['a 403', forbidden, 'access-denied'],
      ...lost.map(([name, message]): [string, string, string] => [name, message, 'missing-object']),
      ...['AccessDenied', 'SignatureDoesNotMatch', 'InvalidAccessKeyId'].map(
        (code): [string, string, string] => [code, `<Error><Code>${code}</Code></Error>`, 'access-denied'],
      ),
    ];
    for (const [name, message, reason] of rows) {
      expect(healthRequestForError({ message }), name).toEqual({
        scope: { kind: 'lake' },
        depth: 'quick',
        reason,
      });
      expect(
        healthRequestForError(new AantjeError('QUERY_FAILED', message, { table: orders })),
        name,
      ).toEqual({
        scope: { kind: 'table', table: orders },
        depth: 'quick',
        reason,
      });
    }

    const connection: Array<[AantjeError, string]> = [
      [new AantjeError('CONNECTION_FAILED', 'Cannot open the DuckLake to read table data: x'), 'connection'],
      [
        new AantjeError(
          'AUTH_FAILED',
          'Cannot open the DuckLake to read table data: password authentication failed',
        ),
        'connection',
      ],
      [
        new AantjeError(
          'QUERY_FAILED',
          'Cannot read the data of "a.b": IO Error: Could not resolve hostname error for HTTP GET to \'http://b\'.',
        ),
        'connection',
      ],
      [
        new AantjeError(
          'QUERY_FAILED',
          'Cannot read the data of "a.b": HTTP Error: HTTP GET error reading \'s3://b/k\' (HTTP 403 Forbidden).',
        ),
        'access-denied',
      ],
    ];
    for (const [error, reason] of connection) {
      expect(healthRequestForError(error), error.message).toMatchObject({ reason, depth: 'quick' });
    }
  });

  it('offers nothing for errors that a health check cannot explain', () => {
    const none: unknown[] = [
      { message: 'IO Error: Cannot open file "/lake/a.parquet": Permission denied' },
      {
        message:
          'Cannot open the DuckLake to read table data: IO Error: Cannot open database file "/x/cat.sqlite": No such file or directory',
      },
      { message: 'IO Error: Failed to create directory "/x": No such file or directory' },
      new AantjeError(
        'QUERY_FAILED',
        'Cannot read the data of "a.b": Binder Error: Referenced column "x" not found.',
      ),
      new AantjeError(
        'QUERY_FAILED',
        'Snapshot @4 does not exist in this catalog: it is newer than the latest snapshot or it expired.',
      ),
      new AantjeError('ABORTED', 'Reading "a.b" was cancelled.'),
      'oops',
    ];
    for (const error of none) {
      expect(healthRequestForError(error), JSON.stringify(error)).toBeUndefined();
    }
  });

  it('turns the table of the error into the request for its id at the snapshot the read used', () => {
    const entries: CatalogEntry[] = [
      { kind: 'view', id: 7, name: 'orders', schemaId: 1, schemaName: 'sales' },
      { kind: 'table', id: 5, name: 'orders', schemaId: 1, schemaName: 'sales' },
    ];
    const suggested = healthRequestForError(
      new AantjeError('QUERY_FAILED', 'the object store answered HTTP 404 for s3://b/k', { table: orders }),
    );

    expect(suggested && resolveRequest(suggested, entries, 13)).toEqual({
      scope: { kind: 'table', tableId: 5 },
      depth: 'quick',
      snapshot: 13,
    });
    // A table that no longer has that name falls back to the whole lake.
    expect(suggested && resolveRequest(suggested, [], 13)).toEqual({
      scope: { kind: 'lake' },
      depth: 'quick',
      snapshot: 13,
    });
  });
});

// The errors of the data engine carry the table, whatever the message says.
describe.skipIf(skipReason)('the errors of the data engine', () => {
  let fixture: DataFixture;
  let store: FakeStore;

  beforeAll(async () => {
    fixture = await copyDataFixture('sqlite', 's3://example-lake/ducklake/');
    store = await startFakeStore(join(fixture.directory, 'sqlite-files'), 'example-lake', 'ducklake');
  });
  afterAll(async () => {
    await store.close();
    await fixture.remove();
  });

  const read = (endpoint = store.endpoint): Promise<unknown> =>
    previewTable(accessFor(fixture, { s3: { endpoint, urlStyle: 'path' } }), orders).then(
      () => undefined,
      (error: unknown) => error,
    );

  it('name the table of a refused request and of a connection that fails', async () => {
    store.mode.value = 'signature';
    const refused = await read();
    store.mode.value = 'serve';
    expect(healthRequestForError(refused)).toEqual({
      scope: { kind: 'table', table: orders },
      depth: 'quick',
      reason: 'access-denied',
    });

    const unreachable = await read(store.endpoint.replace('http://', ''));
    expect(healthRequestForError(unreachable)).toEqual({
      scope: { kind: 'table', table: orders },
      depth: 'quick',
      reason: 'connection',
    });
  });

  it('name the table of a file that the store lost, and the check for it is the table scope', async () => {
    rmSync(
      join(
        fixture.directory,
        'sqlite-files/sales/orders/ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6.parquet',
      ),
    );
    store.mode.value = 'serve';
    const error = await read();

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).table).toEqual(orders);
    expect((error as AantjeError).userMessage).toContain('sales.orders');
    expect(healthRequestForError(error)).toEqual({
      scope: { kind: 'table', table: orders },
      depth: 'quick',
      reason: 'missing-object',
    });
  });
});
