import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { openPostgres } from '../../src/catalog/drivers/postgres';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { openCatalog } from '../../src/catalog/open';
import type { ConnectionProfile } from '../../src/connections/profile';
import { AantjeError } from '../../src/errors';
import { LATEST_SNAPSHOT, SPEC_VERSION } from '../support/expected';
import { fixturePath, wasmPath } from '../support/fixtures';
import type { PostgresFixture } from '../support/global-setup';
import { catalogSources } from '../support/sources';

// The SQLite driver stays the real one; only its close() is counted. The DuckDB driver stays the real one too;
// the options it is opened with are recorded. PostgreSQL is a network service, so its driver is replaced and
// each test decides what it does.
const sqlite = vi.hoisted(() => ({ closed: 0 }));

vi.mock('../../src/catalog/drivers/sqlite', async (importOriginal) => {
  const original = await importOriginal<{ openSqlite: typeof openSqlite }>();
  return {
    openSqlite: async (options: Parameters<typeof openSqlite>[0]) => {
      const driver = await original.openSqlite(options);
      return {
        ...driver,
        close: () => {
          sqlite.closed += 1;
          return driver.close();
        },
      };
    },
  };
});

vi.mock('../../src/catalog/drivers/duckdb', async (importOriginal) => {
  const original = await importOriginal<{ openDuckdb: typeof openDuckdb }>();
  return { openDuckdb: vi.fn(original.openDuckdb) };
});

vi.mock('../../src/catalog/drivers/postgres', () => ({ openPostgres: vi.fn() }));

const PASSWORD = 'hunter2-s3cret';

const sqliteProfile = (path: string): ConnectionProfile => ({
  id: 'lake',
  name: 'Lake',
  kind: 'sqlite',
  path,
});

const postgresProfile: ConnectionProfile = {
  id: 'pg',
  name: 'Warehouse',
  kind: 'postgres',
  host: 'db.example.org',
  port: 5433,
  database: 'lake',
  user: 'reader',
  metadataSchema: 'ducklake',
  ssl: true,
};

beforeEach(() => {
  sqlite.closed = 0;
  vi.mocked(openDuckdb).mockClear();
  vi.mocked(openPostgres).mockReset();
});

const duckdb = catalogSources.find((source) => source.name === 'duckdb');
const duckdbSkipReason = duckdb?.skipReason();

describe('openCatalog with a SQLite profile', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aantje-open-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** Writes a SQLite file: an empty database, or the fixture with another specification version. */
  async function writeDatabase(name: string, version?: string): Promise<string> {
    const wasm = readFileSync(wasmPath);
    const SQL = await initSqlJs({
      wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    const db = new SQL.Database(
      version === undefined ? undefined : readFileSync(fixturePath('ducklake.sqlite')),
    );
    if (version !== undefined) {
      db.run("UPDATE ducklake_metadata SET value = ? WHERE key = 'version'", [version]);
    }
    const path = join(dir, name);
    writeFileSync(path, db.export());
    db.close();
    return path;
  }

  it('opens a catalog file, hands out what its check read and leaves the connection open until the reader is closed', async () => {
    const { reader, info } = await openCatalog(sqliteProfile(fixturePath('ducklake.sqlite')), { wasmPath });

    expect(info).toEqual({ specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT });
    expect((await reader.schemas(LATEST_SNAPSHOT)).map(({ name }) => name)).toEqual(['main', 'sales']);
    expect(sqlite.closed).toBe(0);

    await reader.close();
    expect(sqlite.closed).toBe(1);

    if (duckdbSkipReason === undefined) {
      const profile: ConnectionProfile = {
        id: 'duck',
        name: 'Duck',
        kind: 'duckdb',
        path: fixturePath('ducklake.duckdb'),
      };
      const opened = await openCatalog(profile, { wasmPath, statementTimeoutMs: 10_000 });

      expect(openDuckdb).toHaveBeenCalledExactlyOnceWith({
        path: fixturePath('ducklake.duckdb'),
        statementTimeoutMs: 10_000,
      });
      expect(opened.info).toEqual({ specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT });
      expect((await opened.reader.entries(LATEST_SNAPSHOT)).map(({ name }) => name)).toEqual([
        'plain',
        'big_orders',
        'orders',
      ]);
      await opened.reader.close();
    }
  });

  it('reports each broken file with its own code and closes the connection it opened', async () => {
    const notes = join(dir, 'notes.sqlite');
    writeFileSync(notes, 'these are notes, not a database '.repeat(40));
    const rows: Array<[string, string, number]> = [
      ['FILE_NOT_FOUND', join(dir, 'missing.sqlite'), 0],
      ['CONNECTION_FAILED', notes, 0],
      ['NOT_A_DUCKLAKE', await writeDatabase('empty.sqlite'), 1],
      ['UNSUPPORTED_VERSION', await writeDatabase('future.sqlite', '2.0'), 1],
    ];
    for (const [code, path, closed] of rows) {
      sqlite.closed = 0;
      await expect(openCatalog(sqliteProfile(path), { wasmPath }), code).rejects.toMatchObject({ code });
      expect(sqlite.closed, code).toBe(closed);
    }
  });
});

describe('openCatalog with a PostgreSQL profile', () => {
  const options = { wasmPath, password: PASSWORD, statementTimeoutMs: 5000 };

  it('hands the profile, the password and the timeout to the PostgreSQL driver, with TLS off and no metadata schema when none is asked for', async () => {
    // Any working driver does; the SQLite one lets the whole path run on the fixture.
    vi.mocked(openPostgres).mockImplementation(() =>
      openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath }),
    );

    const { reader, info } = await openCatalog(postgresProfile, options);

    expect(openPostgres).toHaveBeenCalledExactlyOnceWith({
      host: 'db.example.org',
      port: 5433,
      database: 'lake',
      user: 'reader',
      password: PASSWORD,
      ssl: true,
      metadataSchema: 'ducklake',
      statementTimeoutMs: 5000,
    });
    expect(info).toMatchObject({ latestSnapshot: LATEST_SNAPSHOT });
    await reader.close();

    vi.mocked(openPostgres).mockClear();
    const plain = await openCatalog(
      { ...postgresProfile, ssl: false, metadataSchema: undefined },
      { wasmPath, password: PASSWORD },
    );

    expect(openPostgres).toHaveBeenCalledExactlyOnceWith({
      host: 'db.example.org',
      port: 5433,
      database: 'lake',
      user: 'reader',
      password: PASSWORD,
      ssl: false,
    });
    await plain.reader.close();
  });

  it('passes the error of the driver on, hides an unexpected one and its password, and closes the connection before it rejects', async () => {
    const known = new AantjeError('AUTH_FAILED', 'Authentication failed on db.example.org:5433.');
    vi.mocked(openPostgres).mockRejectedValue(known);
    await expect(openCatalog(postgresProfile, options)).rejects.toBe(known);

    const unexpected = new Error(`connect failed: user=reader password=${PASSWORD} host=db.example.org`);
    vi.mocked(openPostgres).mockRejectedValue(unexpected);
    const error: unknown = await openCatalog(postgresProfile, options).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AantjeError);
    expect(error).toMatchObject({ code: 'CONNECTION_FAILED', cause: unexpected });
    expect((error as AantjeError).message).not.toContain(PASSWORD);
    expect((error as AantjeError).userMessage).not.toContain(PASSWORD);

    // Not a DuckLake catalog: the connection is closed completely when the rejection arrives.
    let closed = false;
    const slow: Driver = {
      query: () =>
        Promise.reject(new AantjeError('QUERY_FAILED', 'relation "ducklake_metadata" does not exist')),
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        closed = true;
      },
    };
    vi.mocked(openPostgres).mockResolvedValue(slow);
    await expect(openCatalog(postgresProfile, options)).rejects.toMatchObject({ code: 'NOT_A_DUCKLAKE' });
    expect(closed).toBe(true);

    // A close that fails as well does not hide the original problem.
    const broken: Driver = {
      query: () => Promise.reject(new AantjeError('TIMEOUT', 'The catalog query timed out after 5 s.')),
      close: () => Promise.reject(new Error('socket hang up')),
    };
    vi.mocked(openPostgres).mockResolvedValue(broken);
    await expect(openCatalog(postgresProfile, options)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

const fixture = inject('postgres');

describe.skipIf(fixture === null)(
  `openCatalog with a PostgreSQL profile on the fixture server${fixture === null ? ' (skipped: set AANTJE_POSTGRES=1, needs Docker)' : ''}`,
  () => {
    function profileOf({ host, port, database, user }: PostgresFixture): ConnectionProfile {
      return { id: 'pg-fixture', name: 'Fixture', kind: 'postgres', host, port, database, user };
    }

    function server(): PostgresFixture {
      if (fixture === null) {
        throw new Error('The PostgreSQL fixture is not running; the tests are skipped in that case.');
      }
      return fixture;
    }

    // From here on the real driver answers, so the profile and the password travel the whole way.
    beforeEach(async () => {
      const real = await vi.importActual<{ openPostgres: typeof openPostgres }>(
        '../../src/catalog/drivers/postgres',
      );
      vi.mocked(openPostgres).mockImplementation(real.openPostgres);
    });

    it('connects with the password from the options and reads the catalog, and rejects a wrong password without repeating it', async () => {
      const postgres = server();
      const { reader, info } = await openCatalog(profileOf(postgres), {
        wasmPath,
        password: postgres.password,
      });

      expect(info).toEqual({ specVersion: SPEC_VERSION, latestSnapshot: LATEST_SNAPSHOT });
      expect((await reader.schemas(LATEST_SNAPSHOT)).map(({ name }) => name)).toEqual(['main', 'sales']);
      await reader.close();

      const wrong = 'not-the-password-0451';
      const error: unknown = await openCatalog(profileOf(postgres), { wasmPath, password: wrong }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AantjeError);
      expect((error as AantjeError).message).not.toContain(wrong);
      expect((error as AantjeError).userMessage).not.toContain(wrong);
    });
  },
);
