import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import type { PostgresProfile } from '../../src/connections/profile';
import { createCatalogReader } from '../../src/catalog/reader';
import { withLakeSession } from '../../src/data/engine';
import type { DataAccess } from '../../src/data/types';
import { runHealthCheck } from '../../src/health/run';
import type { HealthReport } from '../../src/health/model';
import { engineSkipReason, extensionDirectory } from './data-support';
import { ids, lake, NOW, problems } from './health-support';

// A DuckLake whose metadata is in the throw-away PostgreSQL container (only with AANTJE_POSTGRES=1); its Parquet files
// are written to a temporary directory.
const fixture = inject('postgres');
const skipReason = fixture
  ? await engineSkipReason()
  : 'set AANTJE_POSTGRES=1 to run it (needs Docker and the DuckDB postgres extension)';
if (skipReason) {
  console.info(`The health tests with PostgreSQL metadata are skipped: ${skipReason}.`);
}

describe.skipIf(skipReason)('the health check on a lake with PostgreSQL metadata', () => {
  const metadataSchema = `aantje_health_${randomBytes(4).toString('hex')}`;
  let directory: string;
  let profile: PostgresProfile;

  const access = (extra: Partial<DataAccess> = {}): DataAccess => ({
    profile,
    password: fixture?.password,
    s3: {},
    extensionDirectory,
    ...extra,
  });

  async function check(
    extra: Partial<DataAccess> = {},
    depth: 'quick' | 'deep' = 'deep',
  ): Promise<HealthReport> {
    if (!fixture) throw new Error('unreachable');
    const reader = createCatalogReader(await openPostgres({ ...fixture, metadataSchema }));
    try {
      return await runHealthCheck(
        { reader, access: access(extra), now: () => NOW },
        { scope: lake, depth, snapshot: 3 },
      );
    } finally {
      await reader.close();
    }
  }

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
    directory = await mkdtemp(join(tmpdir(), 'aantje-pghealth-'));
    const client = new Client(fixture);
    await client.connect();
    await client.query(`CREATE SCHEMA ${metadataSchema}`);
    await client.end();

    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of ['LOAD ducklake', 'LOAD postgres']) await connection.run(sql);
      await connection.run(
        `CREATE SECRET writer (TYPE postgres, HOST '${fixture.host}', PORT ${fixture.port}, DATABASE '${fixture.database}', USER '${fixture.user}', PASSWORD '${fixture.password}')`,
      );
      await connection.run(
        `ATTACH 'ducklake:postgres:' AS lake (META_SECRET writer, METADATA_SCHEMA '${metadataSchema}', DATA_PATH '${directory.replaceAll('\\', '/')}/', DATA_INLINING_ROW_LIMIT 0)`,
      );
      await connection.run('CREATE SCHEMA lake.sales');
      await connection.run('CREATE TABLE lake.sales.orders (id INTEGER, amount DECIMAL(10,2))');
      await connection.run('INSERT INTO lake.sales.orders VALUES (1, 1.50), (2, 2.50), (3, 3.00)');
      await connection.run('DELETE FROM lake.sales.orders WHERE id = 2');
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

  it('finds a healthy lake healthy, with the footers of its files read', async () => {
    const report = await check();

    expect(problems(report)).toEqual([]);
    expect(ids(report)).toEqual([]);
    expect(report.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('runs the SQL it offers on the metadata catalog of PostgreSQL', async () => {
    const [name = ''] = await readdir(join(directory, 'sales', 'orders'));
    await rm(join(directory, 'sales', 'orders', name));
    const report = await check({}, 'quick');

    const missing = report.findings.filter((item) => item.check === 'storage.file-missing');
    expect(missing).toHaveLength(1);
    expect(missing[0]?.scope).toEqual({ kind: 'table', id: 2, schema: 'sales', name: 'orders' });
    const rows = await withLakeSession(access(), undefined, (session) =>
      session.rows((missing[0]?.inspectSql ?? '').replace(/;$/, '')),
    );
    expect(rows).toHaveLength(1);
  });

  it('reports a wrong password of the data engine as a failed attach, without showing it', async () => {
    const wrong = 'wrong-Passw0rd-health';

    const report = await check({ password: wrong }, 'quick');

    expect(ids(report, 'connection')).toEqual(['connection.attach-failed']);
    expect(report.findings.find((item) => item.group === 'connection')?.cause).toContain(
      'rejected the login',
    );
    expect(JSON.stringify(report)).not.toContain(wrong);
    expect(JSON.stringify(report)).not.toContain(fixture?.password ?? 'no password');
  });
});
