import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { Client } from 'pg';
import { inject } from 'vitest';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import type { ConnectionProfile } from '../../src/connections/profile';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { wasmPath } from '../support/fixtures';
import { engineSkipReason, extensionDirectory } from './data-support';

/** A fresh, empty DuckLake that a test writes to with the real DuckDB and reads back with the catalog reader. */
export interface BackendLake {
  /** The writer: the lake is attached as `lake` and in use, the way the SQL editor of aantje attaches it. */
  readonly connection: DuckDBConnection;
  /** The directory that DuckLake writes the data files to. */
  readonly dataDirectory: string;
  /** The connection that opens this lake (and its password), for code that attaches the lake itself. */
  readonly profile: ConnectionProfile;
  readonly password?: string;
  /** A catalog reader on the metadata as it is now. */
  reader(): Promise<CatalogReader>;
  remove(): Promise<void>;
}

export interface Backend {
  readonly name: 'sqlite' | 'postgres';
  /** Why the backend cannot run here, or undefined. */
  readonly skipReason: string | undefined;
  create(): Promise<BackendLake>;
}

const postgres = inject('postgres');

/** The metadata backends that aantje reads for a DuckLake written by DuckDB: SQLite, and PostgreSQL with `AANTJE_POSTGRES=1`. */
export async function lakeBackends(): Promise<Backend[]> {
  const engine = await engineSkipReason();
  if (engine) {
    console.info(`The lake tests on SQLite are skipped: ${engine}.`);
  }
  if (!postgres) {
    console.info(
      'The lake tests on PostgreSQL are skipped: set AANTJE_POSTGRES=1 to run them (needs Docker).',
    );
  }
  return [
    { name: 'sqlite', skipReason: engine, create: createSqliteLake },
    {
      name: 'postgres',
      skipReason: engine ?? (postgres ? undefined : 'set AANTJE_POSTGRES=1 to run it (needs Docker)'),
      create: createPostgresLake,
    },
  ];
}

/** A DuckDB that has run `setup` and then uses the lake that the setup attached as `lake`. */
async function writer(setup: readonly string[]) {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  for (const sql of ['LOAD ducklake', 'LOAD sqlite', 'LOAD postgres', ...setup, 'USE lake']) {
    await connection.run(sql);
  }
  return { instance, connection };
}

async function createSqliteLake(): Promise<BackendLake> {
  const directory = await mkdtemp(join(tmpdir(), 'aantje-macros-'));
  const posix = directory.replaceAll('\\', '/');
  const path = `${posix}/lake.sqlite`;
  const { instance, connection } = await writer([
    `ATTACH 'ducklake:sqlite:${path}' AS lake (DATA_PATH '${posix}/data/', DATA_INLINING_ROW_LIMIT 0)`,
  ]);
  return {
    connection,
    dataDirectory: `${posix}/data`,
    profile: { id: 'sqlite', name: 'sqlite', kind: 'sqlite', path },
    reader: async () => createCatalogReader(await openSqlite({ path, wasmPath })),
    async remove() {
      connection.closeSync();
      instance.closeSync();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function createPostgresLake(): Promise<BackendLake> {
  if (!postgres) {
    throw new Error('The Postgres fixture is not running; check skipReason first.');
  }
  const metadataSchema = `aantje_macros_${randomBytes(4).toString('hex')}`;
  const directory = await mkdtemp(join(tmpdir(), 'aantje-macros-'));
  const posix = directory.replaceAll('\\', '/');
  const admin = new Client(postgres);
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${metadataSchema}`);
  const { instance, connection } = await writer([
    `CREATE SECRET pg (TYPE postgres, HOST '${postgres.host}', PORT ${postgres.port}, DATABASE '${postgres.database}', USER '${postgres.user}', PASSWORD '${postgres.password}')`,
    `ATTACH 'ducklake:postgres:' AS lake (META_SECRET pg, METADATA_SCHEMA '${metadataSchema}', DATA_PATH '${posix}/data/', DATA_INLINING_ROW_LIMIT 0)`,
  ]);
  return {
    connection,
    dataDirectory: `${posix}/data`,
    profile: {
      id: 'postgres',
      name: 'postgres',
      kind: 'postgres',
      host: postgres.host,
      port: postgres.port,
      database: postgres.database,
      user: postgres.user,
      metadataSchema,
    },
    password: postgres.password,
    reader: async () => createCatalogReader(await openPostgres({ ...postgres, metadataSchema })),
    async remove() {
      connection.closeSync();
      instance.closeSync();
      await admin.query(`DROP SCHEMA ${metadataSchema} CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
