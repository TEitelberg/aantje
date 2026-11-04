import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupStatements } from '../../src/data/attach';
import { previewTable } from '../../src/data/engine';
import { instanceOptions, MEMORY_LIMIT, removeTemporaryFiles } from '../../src/data/instance';
import { AantjeError } from '../../src/errors';
import { openSqlSession } from '../../src/sql/session';
import { query } from './sql-support';
import { accessFor, copyDataFixture, createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { DataFixture } from './data-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Engine hardening tests are skipped: ${skipReason}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function settings(
  fixture: DataFixture,
  names: readonly string[],
  extra: (connection: Awaited<ReturnType<DuckDBInstance['connect']>>) => Promise<void> = () =>
    Promise.resolve(),
): Promise<Record<string, unknown>> {
  const access = accessFor(fixture);
  const options = instanceOptions(access);
  const instance = await DuckDBInstance.create(':memory:', options);
  const connection = await instance.connect();
  try {
    for (const sql of setupStatements(access)) {
      await connection.run(sql);
    }
    await extra(connection);
    const rows = (
      await connection.runAndReadAll(
        `SELECT name, value FROM duckdb_settings() WHERE name IN (${names.map((name) => `'${name}'`).join(', ')})`,
      )
    ).getRowsJson();
    return {
      ...Object.fromEntries(rows.map(([name, value]): [string, unknown] => [name as string, value])),
      temp: options.temp_directory,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
    removeTemporaryFiles(options);
  }
}

describe.skipIf(skipReason)('the one-shot engine after the setup', () => {
  it('installs and loads nothing on its own, writes no persistent secret, has a private temporary directory and a memory limit, and cannot change them', async () => {
    const fixture = await copyDataFixture('duckdb');
    try {
      const read = await settings(fixture, [
        'autoinstall_known_extensions',
        'autoload_known_extensions',
        'allow_persistent_secrets',
        'lock_configuration',
        'temp_directory',
        'memory_limit',
      ]);

      expect(read).toEqual({
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
        allow_persistent_secrets: 'false',
        lock_configuration: 'true',
        temp_directory: read.temp,
        memory_limit: '2.0 GiB',
        temp: read.temp,
      });
      expect(MEMORY_LIMIT).toBe('2GiB');
      expect(String(read.temp)).toMatch(/aantje-duckdb-[0-9a-f-]{36}$/);
      expect(String(read.temp).startsWith(tmpdir())).toBe(true);

      await settings(fixture, ['memory_limit'], async (connection) => {
        for (const sql of [
          'SET autoload_known_extensions = true',
          'SET autoinstall_known_extensions = true',
          "SET memory_limit = '64GB'",
          "SET temp_directory = '.tmp'",
          'SET allow_persistent_secrets = true',
        ]) {
          await expect(connection.run(sql), sql).rejects.toThrow(/has been locked/);
        }
      });
    } finally {
      await fixture.remove();
    }
  });

  it('gives every engine its own temporary directory, created up front and private to its owner, and lets a test add options but never weaken the fixed ones', () => {
    const access = { profile: { id: 'x', name: 'x', kind: 'duckdb', path: 'x' }, s3: {} } as const;
    const first = instanceOptions(access);
    const second = instanceOptions(access);
    const weakened = instanceOptions(access, {
      s3_endpoint: 'localhost:1',
      allow_persistent_secrets: 'true',
      memory_limit: '99GiB',
      temp_directory: '/tmp/elsewhere',
    });
    try {
      expect(first.temp_directory).not.toBe(second.temp_directory);
      expect(statSync(first.temp_directory).isDirectory()).toBe(true);
      // DuckDB creates the directory with the mode of the umask (0755) and fills it with spill files of the query data.
      if (process.platform !== 'win32') {
        expect(statSync(first.temp_directory).mode & 0o777).toBe(0o700);
      }
      expect(weakened).toMatchObject({
        s3_endpoint: 'localhost:1',
        allow_persistent_secrets: 'false',
        memory_limit: MEMORY_LIMIT,
      });
      expect(weakened.temp_directory).toMatch(/aantje-duckdb-/);
    } finally {
      removeTemporaryFiles(first);
      removeTemporaryFiles(second);
      removeTemporaryFiles(weakened);
    }
  });

  it('removes the temporary directory when the engine is closed, in a read and in the SQL session, also one that DuckDB filled', async () => {
    const lake = await createLake(['CREATE TABLE t (a INTEGER)', 'INSERT INTO t VALUES (1)']);
    const directories: string[] = [];
    const create = DuckDBInstance.create.bind(DuckDBInstance);
    vi.spyOn(DuckDBInstance, 'create').mockImplementation((path, options) => {
      directories.push(String(options?.temp_directory));
      return create(path, options);
    });
    try {
      await previewTable(
        { profile: lake.profile, s3: {}, extensionDirectory },
        { schema: 'main', table: 't' },
      );

      expect(directories).toHaveLength(1);
      expect(existsSync(directories[0] as string)).toBe(false);

      const leftover = await mkdtemp(join(tmpdir(), 'aantje-duckdb-test-'));
      removeTemporaryFiles({ temp_directory: leftover });
      expect(existsSync(leftover)).toBe(false);

      const session = await openSqlSession({
        access: { profile: lake.profile, s3: {}, extensionDirectory },
        mode: 'read-only',
      });
      try {
        const rows = (
          await query(
            session,
            "SELECT name, value FROM duckdb_settings() WHERE name IN ('temp_directory', 'memory_limit') ORDER BY name",
          )
        ).rows;

        expect(rows).toEqual([
          ['memory_limit', '2.0 GiB'],
          ['temp_directory', directories[1]],
        ]);
      } finally {
        await session.close();
      }
      expect(directories).toHaveLength(2);
      expect(existsSync(directories[1] as string)).toBe(false);
    } finally {
      await lake.remove();
    }
  });

  it('keeps the scrubbed error when the close fails after a failed read, logs the failure, and reports a failed close after a good read without the secret', async () => {
    const secretKey = 'close-secret-4711';
    const lake = await createLake(['CREATE TABLE t (a INTEGER)']);
    // The close really happens, then fails with a message that holds a secret, as a raw engine error could.
    const close = Object.getOwnPropertyDescriptor(DuckDBConnection.prototype, 'closeSync')
      ?.value as DuckDBConnection['closeSync'];
    vi.spyOn(DuckDBConnection.prototype, 'closeSync').mockImplementation(function (this: DuckDBConnection) {
      close.call(this);
      throw new Error(`raw close failure with ${secretKey}`);
    });
    const read = (table: string, log?: { warn: (message: string) => void }): Promise<unknown> =>
      previewTable(
        {
          profile: lake.profile,
          s3: {},
          s3Credentials: { keyId: 'AKIACLOSEKEY', secretKey },
          extensionDirectory,
          ...(log === undefined ? {} : { log }),
        },
        { schema: 'main', table },
      ).then(
        () => undefined,
        (cause: unknown) => cause,
      );
    try {
      const warnings: string[] = [];
      const failed = await read('no_such_table', { warn: (message) => void warnings.push(message) });

      expect(failed).toBeInstanceOf(AantjeError);
      expect((failed as AantjeError).userMessage).toContain('no_such_table');
      expect((failed as AantjeError).userMessage).not.toContain('raw close failure');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('raw close failure');

      const good = await read('t');

      expect(good).toBeInstanceOf(AantjeError);
      expect(JSON.stringify((good as AantjeError).userMessage)).not.toContain(secretKey);
    } finally {
      vi.restoreAllMocks();
      await lake.remove();
    }
  });

  it('refuses a view that needs an extension the setup did not load, although DuckDB could load it by itself', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aantje-sqlite-'));
    const file = join(directory, 'other.db').replaceAll('\\', '/');
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD sqlite');
      await connection.run(`ATTACH '${file}' AS other (TYPE sqlite)`);
      await connection.run('CREATE TABLE other.pets (name VARCHAR)');
      await connection.run("INSERT INTO other.pets VALUES ('aantje')");
      await connection.run('DETACH other');
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
    const lake = await createLake([`CREATE VIEW pets AS SELECT * FROM sqlite_scan('${file}', 'pets')`]);
    try {
      // The control: an engine that may autoload runs the same SQL.
      const loose = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const control = await loose.connect();
      try {
        const rows = (
          await control.runAndReadAll(`SELECT * FROM sqlite_scan('${file}', 'pets')`)
        ).getRowsJson();
        expect(rows).toEqual([['aantje']]);
      } finally {
        control.closeSync();
        loose.closeSync();
      }

      await expect(
        previewTable(
          { profile: lake.profile, s3: {}, extensionDirectory, viewsTrusted: true },
          { schema: 'main', table: 'pets' },
        ),
      ).rejects.toMatchObject({
        code: 'QUERY_FAILED',
        userMessage: expect.stringMatching(/sqlite_scan/) as unknown,
      });
    } finally {
      await lake.remove();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('still loads httpfs by itself while the lake is attached: a lake on S3 with nothing configured', async () => {
    const fixture = await copyDataFixture('duckdb', 's3://aantje-test/');
    try {
      const access = accessFor(fixture);
      const options = instanceOptions(access);
      const instance = await DuckDBInstance.create(':memory:', options);
      const connection = await instance.connect();
      try {
        for (const sql of setupStatements(access)) {
          await connection.run(sql);
        }
        const loaded = (
          await connection.runAndReadAll(
            "SELECT loaded FROM duckdb_extensions() WHERE extension_name = 'httpfs'",
          )
        ).getRowsJson()[0]?.[0];
        expect(loaded).toBe(true);
      } finally {
        connection.closeSync();
        instance.closeSync();
        removeTemporaryFiles(options);
      }
    } finally {
      await fixture.remove();
    }
  }, 30_000);
});

describe.skipIf(skipReason)(
  'the PostgreSQL secret of the setup, parsed by the real postgres extension',
  () => {
    const postgres = {
      id: 'pg',
      name: 'pg',
      kind: 'postgres',
      host: 'db.example.com',
      port: 5432,
      database: 'lake',
      user: 'reader',
    } as const;

    async function secretText(ssl: boolean | undefined): Promise<string> {
      const instance = await DuckDBInstance.create(':memory:', {
        extension_directory: extensionDirectory,
        allow_persistent_secrets: 'false',
      });
      const connection = await instance.connect();
      try {
        await connection.run('LOAD postgres');
        const statement = setupStatements({
          profile: { ...postgres, ...(ssl === undefined ? {} : { ssl }) },
          s3: {},
          password: 'pw',
        }).find((sql) => sql.startsWith('CREATE OR REPLACE SECRET aantje_pg'));
        await connection.run(statement as string);
        const rows = (
          await connection.runAndReadAll(
            "SELECT secret_string FROM duckdb_secrets() WHERE name = 'aantje_pg'",
          )
        ).getRowsJson();
        return rows[0]?.[0] as string;
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
    }

    it('disables TLS when it is off or unset and verifies the full chain against the system certificates when it is on', async () => {
      expect(await secretText(false)).toContain('sslmode=disable');
      expect(await secretText(undefined)).toContain('sslmode=disable');

      const text = await secretText(true);
      expect(text).toContain('sslmode=verify-full');
      expect(text).toContain('sslrootcert=system');
    });
  },
);
