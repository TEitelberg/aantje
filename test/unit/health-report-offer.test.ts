import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { previewTable } from '../../src/data/engine';
import { AantjeError } from '../../src/errors';
import { offerFor, scopeForOffer } from '../../src/health-report/offer';
import type { HealthOffer } from '../../src/health-report/offer';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';
import { accessFor, copyDataFixture, engineSkipReason } from './data-support';
import type { DataFixture } from './data-support';
import { startFakeStore } from './health-support';
import type { FakeStore } from './health-support';

const skipReason = await engineSkipReason();

const orders = { schema: 'sales', table: 'orders' };
const tableOffer = (table: { schema: string; table: string }): HealthOffer => ({
  label: 'Check Table Health',
  connectionId: 'c1',
  suggestion: { scope: { kind: 'table', table }, depth: 'quick', reason: 'missing-object' },
});

describe('the button next to the message of an error', () => {
  it('is Check Health for a failure of the connection, that names no table', () => {
    expect(
      offerFor(
        new AantjeError('CONNECTION_FAILED', 'Cannot open the DuckLake to read table data: x', {
          connectionId: 'c1',
        }),
      ),
    ).toEqual({
      label: 'Check Health',
      connectionId: 'c1',
      suggestion: { scope: { kind: 'lake' }, depth: 'quick', reason: 'connection' },
    });
  });

  it('is Check Table Health for a read that names its table', () => {
    expect(
      offerFor(
        new AantjeError(
          'QUERY_FAILED',
          'Cannot read the data of "sales.orders": the object store answered HTTP 404 for s3://b/k.',
          {
            connectionId: 'c1',
            table: orders,
          },
        ),
      ),
    ).toEqual({
      label: 'Check Table Health',
      connectionId: 'c1',
      suggestion: { scope: { kind: 'table', table: orders }, depth: 'quick', reason: 'missing-object' },
    });
  });

  it.each([
    [
      'an error that is none of its business',
      new AantjeError('QUERY_FAILED', 'Cannot read the data of "a.b": Binder Error: x.', {
        connectionId: 'c1',
        table: { schema: 'a', table: 'b' },
      }),
    ],
    [
      'a failure that does not say which connection it came from',
      new AantjeError('CONNECTION_FAILED', 'Cannot open the DuckLake to read table data: x'),
    ],
    ['an error that is no AantjeError', new Error('HTTP 404 Not Found')],
    ['something that is no error', 'HTTP 404'],
  ])('is not offered for %s', (_name, error) => {
    expect(offerFor(error)).toBeUndefined();
  });
});

describe('the scope that the offered check runs on', () => {
  const sqlite = async () => createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));

  it('is the lake for a check of the lake', async () => {
    const reader = await sqlite();
    try {
      expect(
        await scopeForOffer(
          {
            label: 'Check Health',
            connectionId: 'c1',
            suggestion: { scope: { kind: 'lake' }, depth: 'quick', reason: 'connection' },
          },
          reader,
          56,
          56,
        ),
      ).toEqual({ kind: 'lake' });
    } finally {
      await reader.close();
    }
  });

  it('is the table with the id it has in the catalog, named as the error named it', async () => {
    const reader = await sqlite();
    try {
      expect(await scopeForOffer(tableOffer({ schema: 'shop', table: 'events' }), reader, 56, 56)).toEqual({
        kind: 'table',
        id: 3,
        schema: 'shop',
        name: 'events',
      });
    } finally {
      await reader.close();
    }
  });

  it('looks in the newest snapshot when the table does not exist at the snapshot the tree shows', async () => {
    const reader = await sqlite();
    try {
      // `shop.events` exists at snapshot 56; at snapshot 1 the catalog has no tables.
      expect(
        await scopeForOffer(tableOffer({ schema: 'shop', table: 'events' }), reader, 1, 56),
      ).toMatchObject({
        kind: 'table',
        id: 3,
      });
    } finally {
      await reader.close();
    }
  });

  it('prefers the table that has the name at the snapshot of the read over one that has it now', async () => {
    // The read used snapshot 5, where table 1 was called "orders"; table 2 has that name now.
    const entries = (snapshot: number) =>
      Promise.resolve([
        {
          kind: 'table' as const,
          id: snapshot === 5 ? 1 : 2,
          name: 'orders',
          schemaId: 0,
          schemaName: 'sales',
        },
      ]);

    expect(await scopeForOffer(tableOffer(orders), { entries }, 5, 9)).toMatchObject({
      kind: 'table',
      id: 1,
    });
  });

  it('falls back to the lake for a table that exists in neither snapshot', async () => {
    const reader = await sqlite();
    try {
      expect(await scopeForOffer(tableOffer({ schema: 'shop', table: 'dropped' }), reader, 56, 56)).toEqual({
        kind: 'lake',
      });
    } finally {
      await reader.close();
    }
  });
});

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

  const read = (): Promise<unknown> =>
    previewTable(accessFor(fixture, { s3: { endpoint: store.endpoint, urlStyle: 'path' } }), orders).then(
      () => undefined,
      (error: unknown) => error,
    );

  it('carry the connection, so that a file the store lost offers the check of its table', async () => {
    store.mode.value = 'serve';
    rmSync(
      join(
        fixture.directory,
        'sqlite-files/sales/orders/ducklake-01a18c33-cfcb-7cc1-bfe9-dfce5e8d67c6.parquet',
      ),
    );

    const error = await read();

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).connectionId).toBe(fixture.profile.id);
    expect(offerFor(error)).toMatchObject({
      label: 'Check Table Health',
      connectionId: fixture.profile.id,
      suggestion: { scope: { kind: 'table', table: orders }, reason: 'missing-object' },
    });
  });

  it('offer the check of the table for a request that the store refuses', async () => {
    store.mode.value = 'signature';
    const error = await read();
    store.mode.value = 'serve';

    expect(offerFor(error)).toMatchObject({
      label: 'Check Table Health',
      connectionId: fixture.profile.id,
      suggestion: { reason: 'access-denied' },
    });
  });
});
