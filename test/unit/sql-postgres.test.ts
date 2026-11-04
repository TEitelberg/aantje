import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import { createCatalogReader } from '../../src/catalog/reader';
import type { PostgresProfile } from '../../src/connections/profile';
import type { DataAccess } from '../../src/data/types';
import { AantjeError } from '../../src/errors';
import { openSqlSession } from '../../src/sql/session';
import type { SqlSession } from '../../src/sql/session';
import { engineSkipReason, extensionDirectory } from './data-support';
import { events, only, query } from './sql-support';

// The catalog lives in the throw-away Postgres container of test/support/global-setup.ts (only with
// AANTJE_POSTGRES=1); its Parquet files are written to a temporary directory on this machine.
const fixture = inject('postgres');
const skipReason = fixture
  ? await engineSkipReason()
  : 'set AANTJE_POSTGRES=1 to run it (needs Docker and the DuckDB postgres extension)';
if (skipReason) {
  console.info(`The SQL session tests with PostgreSQL metadata are skipped: ${skipReason}.`);
}

const READ_ONLY_PASSWORD = `ro-${randomBytes(6).toString('hex')}`;

describe.skipIf(skipReason)('the SQL session with PostgreSQL metadata', () => {
  const metadataSchema = `aantje_sql_${randomBytes(4).toString('hex')}`;
  const readOnlyRole = `aantje_ro_${randomBytes(4).toString('hex')}`;
  let directory: string;
  let profile: PostgresProfile;
  const opened: SqlSession[] = [];

  const access = (extra: Partial<DataAccess> = {}): DataAccess => ({
    profile,
    password: fixture?.password,
    s3: {},
    extensionDirectory,
    ...extra,
  });
  async function open(mode: 'read-write' | 'read-only' = 'read-write', extra: Partial<DataAccess> = {}) {
    const session = await openSqlSession({ access: access(extra), mode });
    opened.push(session);
    return session;
  }
  async function admin<T>(use: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client(fixture ?? undefined);
    await client.connect();
    try {
      return await use(client);
    } finally {
      await client.end();
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
    directory = await mkdtemp(join(tmpdir(), 'aantje-sqlpg-'));
    await admin((client) => client.query(`CREATE SCHEMA ${metadataSchema}`));

    // The catalog must exist before a session opens it: a session never creates one.
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
        `ATTACH 'ducklake:postgres:' AS lake (META_SECRET writer, METADATA_SCHEMA '${metadataSchema}', DATA_PATH '${directory.split(String.fromCharCode(92)).join('/')}/', DATA_INLINING_ROW_LIMIT 0)`,
      );
      await connection.run('CREATE TABLE lake.shared (id INTEGER, name VARCHAR)');
      await connection.run("INSERT INTO lake.shared VALUES (1, 'a'), (2, 'b')");
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    await admin(async (client) => {
      await client.query(`CREATE ROLE ${readOnlyRole} LOGIN PASSWORD '${READ_ONLY_PASSWORD}'`);
      await client.query(`GRANT USAGE ON SCHEMA ${metadataSchema} TO ${readOnlyRole}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${metadataSchema} TO ${readOnlyRole}`);
    });
  });

  afterEach(async () => {
    for (const session of opened.splice(0)) {
      await session.close();
    }
  });

  afterAll(async () => {
    if (!fixture) return;
    await admin(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${metadataSchema} CASCADE`);
      await client.query(`DROP OWNED BY ${readOnlyRole}`);
      await client.query(`DROP ROLE IF EXISTS ${readOnlyRole}`);
    });
    await rm(directory, { recursive: true, force: true });
  });

  it('writes to the catalog and the data files, and the Explorer reads the new snapshots and rows', async () => {
    const session = await open();

    const log = await events(
      session,
      [
        'CREATE TABLE written (id INTEGER, name VARCHAR)',
        "INSERT INTO written SELECT range::INTEGER, 'row ' || range FROM range(20)",
        'DELETE FROM written WHERE id >= 8',
        'SELECT count(*)::INTEGER AS n FROM written',
      ].join(';\n'),
    );

    expect(only(log, 'message').map(({ text }) => text)).toEqual([
      'Commands completed successfully.',
      '20 rows affected.',
      '12 rows affected.',
    ]);
    expect(only(log, 'resultSet')[0]?.rows).toEqual([[8]]);
    await session.close();

    const reader = createCatalogReader(await openPostgres({ ...fixture!, metadataSchema }));
    try {
      const { latestSnapshot } = await reader.info();
      const main = (await reader.schemas(latestSnapshot)).find(({ name }) => name === 'main');
      const tables = await reader.tables(main?.id ?? -1, latestSnapshot);
      expect(tables.map(({ name }) => name)).toContain('written');
      // 20 rows went to a Parquet file and the 12 deleted ones to a delete file (more than ten rows each).
      expect(tables.find(({ name }) => name === 'written')?.stats).toMatchObject({ rows: 8, files: 1 });
    } finally {
      await reader.close();
    }
  });

  it('does not turn a PostgreSQL schema that is no DuckLake into one', async () => {
    const plain = `aantje_plain_${randomBytes(4).toString('hex')}`;
    await admin(async (client) => {
      await client.query(`CREATE SCHEMA ${plain}`);
      await client.query(`CREATE TABLE ${plain}.customers (id INTEGER)`);
    });
    const tablesOf = (): Promise<string[]> =>
      admin(async (client) =>
        (
          await client.query<{ table_name: string }>(
            'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1',
            [plain],
          )
        ).rows.map(({ table_name }) => table_name),
      );
    try {
      for (const mode of ['read-write', 'read-only'] as const) {
        const error = await openSqlSession({
          access: access({ profile: { ...profile, metadataSchema: plain } }),
          mode,
        }).then(
          () => undefined,
          (e: unknown) => e,
        );

        expect(error, mode).toBeInstanceOf(AantjeError);
        expect((error as AantjeError).userMessage, mode).toMatch(
          /^Cannot open the SQL session: The catalog is empty or does not exist/,
        );
      }

      expect(await tablesOf()).toEqual(['customers']);
    } finally {
      await admin((client) => client.query(`DROP SCHEMA ${plain} CASCADE`));
    }
  });

  it('keeps the password out of every event and error, and rejects a wrong one as AUTH_FAILED', async () => {
    const wrong = 'wrong-Passw0rd-xyz';

    const error = await openSqlSession({ access: access({ password: wrong }), mode: 'read-write' }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(AantjeError);
    expect((error as AantjeError).code).toBe('AUTH_FAILED');
    expect((error as AantjeError).userMessage).toBe(
      'Cannot open the SQL session: The PostgreSQL server rejected the user name or the password of this connection.',
    );
    expect(JSON.stringify([(error as AantjeError).userMessage, (error as AantjeError).cause])).not.toContain(
      wrong,
    );
  });

  it('scrubs the password from the message of a statement that quotes it', async () => {
    // The message of an unknown table quotes its name: a name that equals the password stands for any leak.
    const session = await open('read-write', { password: fixture?.password });
    const list = await events(session, `SELECT * FROM "${fixture?.password}"`);

    const [error] = only(list, 'error');
    expect(error?.message).not.toContain(fixture?.password ?? '');
    expect(error?.message).toContain('***');
    expect(JSON.stringify(only(list, 'error'))).not.toContain(fixture?.password ?? '');
  });

  it('explains that a user who may only read cannot write, without the SQL and the values of the long message', async () => {
    const session = await open('read-write', {
      password: READ_ONLY_PASSWORD,
      profile: { ...profile, user: readOnlyRole },
    });
    expect((await query(session, 'SELECT count(*)::INTEGER FROM shared')).rows).toEqual([[2]]);

    const list = await events(session, "INSERT INTO shared (id, name) VALUES (3, 'secret-row-value')");

    const [error] = only(list, 'error');
    expect(error?.message).toBe(
      'The database user may not write to the catalog (permission denied for table ducklake_snapshot). Grant the user write access to the metadata schema or use a read-only session.',
    );
    expect(JSON.stringify(only(list, 'error'))).not.toMatch(
      new RegExp(`secret-row-value|${READ_ONLY_PASSWORD}|INSERT|extra_float_digits`),
    );
    expect(session.inTransaction).toBe('none');
    // The Explorer's own user sees that nothing was written.
    expect((await query(await open(), 'SELECT count(*)::INTEGER FROM shared')).rows).toEqual([[2]]);
  });

  it('refuses writes in a read-only session', async () => {
    const session = await open('read-only');

    const [error] = only(await events(session, "INSERT INTO shared (id, name) VALUES (4, 'no')"), 'error');

    expect(error?.message).toBe(
      'This is a read-only session: the statement would change the lake. Run "Toggle Read-only Session" to switch this editor to a read-write session.',
    );
  });

  it('resolves a conflict of two writers at commit with advice to run the statement again, and stays usable', async () => {
    const first = await open();
    const second = await open();
    await events(first, 'BEGIN');
    await events(second, 'BEGIN');
    await events(first, 'ALTER TABLE shared ADD COLUMN extra1 INTEGER');
    await events(second, 'ALTER TABLE shared ADD COLUMN extra2 INTEGER');

    expect(only(await events(first, 'COMMIT'), 'error')).toEqual([]);
    const [conflict] = only(await events(second, 'COMMIT'), 'error');

    expect(conflict?.message).toBe(
      'Another writer changed the same table or schema first, so this change was not committed. Run the statement again.',
    );
    expect(second.inTransaction).toBe('none');
    expect(only(await events(second, 'ALTER TABLE shared ADD COLUMN extra2 INTEGER'), 'error')).toEqual([]);
    expect(
      (
        await query(
          second,
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'shared' ORDER BY ordinal_position",
        )
      ).rows,
    ).toEqual([['id'], ['name'], ['extra1'], ['extra2']]);
  });

  it('sees what another session committed, as the Explorer does after a refresh', async () => {
    const first = await open();
    const second = await open();

    const written = await events(first, "INSERT INTO shared (id, name) VALUES (10, 'seen')");

    expect(only(written, 'error')).toEqual([]);

    expect((await query(second, 'SELECT name FROM shared WHERE id = 10')).rows).toEqual([['seen']]);
  });
});
