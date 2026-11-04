import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { PostgresProfile } from '../../src/connections/profile';
import { previewTable } from '../../src/data/engine';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { engineSkipReason, extensionDirectory } from './data-support';

// The metadata of this DuckLake lives in the throw-away Postgres container of test/support/global-setup.ts (only
// with AANTJE_POSTGRES=1); its Parquet files are written to a temporary directory on this machine.
const fixture = inject('postgres');
const skipReason = fixture
  ? await engineSkipReason()
  : 'set AANTJE_POSTGRES=1 to run it (needs Docker and the DuckDB postgres extension)';
if (skipReason) {
  console.info(`The data tests with PostgreSQL metadata are skipped: ${skipReason}.`);
}

const orders = { schema: 'sales', table: 'orders' };

describe.skipIf(skipReason)('previewTable with PostgreSQL metadata', () => {
  const metadataSchema = `aantje_data_${randomBytes(4).toString('hex')}`;
  let directory: string;
  let profile: PostgresProfile;
  let beforeDelete: number;
  let afterDelete: number;

  const access = (extra: Partial<DataAccess> = {}): DataAccess => ({
    profile,
    password: fixture?.password,
    s3: {},
    extensionDirectory,
    ...extra,
  });

  beforeAll(async () => {
    if (!fixture) throw new Error('unreachable');
    profile = {
      id: 'pg',
      name: 'pg',
      kind: 'postgres',
      host: fixture.host,
      port: fixture.port,
      database: fixture.database,
      user: fixture.user,
      metadataSchema,
    };
    directory = await mkdtemp(join(tmpdir(), 'aantje-pgdata-'));

    const client = new Client(fixture);
    await client.connect();
    await client.query(`CREATE SCHEMA ${metadataSchema}`);
    await client.end();

    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of ['LOAD ducklake', 'LOAD postgres']) {
        await connection.run(sql);
      }
      await connection.run(
        `CREATE SECRET writer (TYPE postgres, HOST '${fixture.host}', PORT ${fixture.port}, DATABASE '${fixture.database}', USER '${fixture.user}', PASSWORD '${fixture.password}')`,
      );
      await connection.run(
        `ATTACH 'ducklake:postgres:' AS lake (META_SECRET writer, METADATA_SCHEMA '${metadataSchema}', DATA_PATH '${directory.replaceAll('\\', '/')}/', DATA_INLINING_ROW_LIMIT 0)`,
      );
      await connection.run('CREATE SCHEMA lake.sales');
      await connection.run(
        'CREATE TABLE lake.sales.orders (id INTEGER, customer STRUCT(name VARCHAR), amount DECIMAL(10,2))',
      );
      await connection.run(
        "INSERT INTO lake.sales.orders VALUES (1, {'name': 'a'}, 1.50), (2, {'name': 'b'}, 2.50), (3, NULL, 3.00)",
      );
      beforeDelete = await latestSnapshot(connection);
      await connection.run('DELETE FROM lake.sales.orders WHERE id = 2');
      afterDelete = await latestSnapshot(connection);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });

  afterAll(async () => {
    if (!fixture) return;
    const client = new Client(fixture);
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${metadataSchema} CASCADE`);
    await client.end();
    await rm(directory, { recursive: true, force: true });
  });

  it('shows the table at the latest snapshot with the password coming from a secret, and time travels to the snapshot before the delete', async () => {
    const data = await previewTable(access(), orders);

    expect(data.columns).toEqual([
      { name: 'id', type: 'INTEGER', kind: 'number' },
      { name: 'customer', type: 'STRUCT("name" VARCHAR)', kind: 'nested' },
      { name: 'amount', type: 'DECIMAL(10,2)', kind: 'number' },
    ]);
    expect(data.rows).toEqual([
      [1, '{"name":"a"}', '1.50'],
      [3, null, '3.00'],
    ]);
    expect(
      (await previewTable(access({ snapshot: beforeDelete }), orders)).rows.map((row) => row[0]),
    ).toEqual([1, 2, 3]);
    expect((await previewTable(access({ snapshot: afterDelete }), orders)).rows.map((row) => row[0])).toEqual(
      [1, 3],
    );
  });

  it('reports a wrong password as AUTH_FAILED without showing it', async () => {
    const wrong = 'wrong-Passw0rd-xyz';
    const error = await previewTable(access({ password: wrong }), orders).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).code).toBe('AUTH_FAILED');
    expect((error as AantjeError).userMessage).not.toContain(wrong);
    expect(((error as AantjeError).cause as Error).message).not.toContain(wrong);
  });
});

async function latestSnapshot(connection: Awaited<ReturnType<DuckDBInstance['connect']>>): Promise<number> {
  const reader = await connection.runAndReadAll(
    'SELECT max(snapshot_id)::INTEGER FROM __ducklake_metadata_lake.ducklake_snapshot',
  );
  return Number(reader.getRows()[0]?.[0]);
}
