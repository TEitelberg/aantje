import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import type { Driver } from '../../src/catalog/drivers/driver';
import { AantjeError } from '../../src/errors';
import { fixturePath, wasmPath } from '../support/fixtures';
import { LATEST_SNAPSHOT, SPEC_VERSION } from '../support/expected';

const VERSION_SQL = "SELECT value FROM ducklake_metadata WHERE key = 'version'";

describe('sqlite driver on the DuckLake fixture', () => {
  let driver: Driver;
  beforeAll(async () => {
    driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
  });
  afterAll(() => driver.close());

  it('reads the catalog with exact values: integers as numbers, NULL kept, column names lower-cased, BLOBs as base64, rows in order', async () => {
    expect(await driver.query(VERSION_SQL)).toEqual([{ value: SPEC_VERSION }]);
    expect(
      await driver.query('SELECT snapshot_id, schema_version FROM ducklake_snapshot WHERE snapshot_id = ?', [
        LATEST_SNAPSHOT,
      ]),
    ).toEqual([{ snapshot_id: LATEST_SNAPSHOT, schema_version: 10 }]);
    expect(
      await driver.query(
        'SELECT snapshot_id FROM ducklake_snapshot WHERE snapshot_id <= ? ORDER BY snapshot_id',
        [2],
      ),
    ).toEqual([{ snapshot_id: 0 }, { snapshot_id: 1 }, { snapshot_id: 2 }]);
    expect(await driver.query('SELECT 1 WHERE 0')).toEqual([]);
    expect(
      await driver.query('SELECT end_snapshot AS "EndSnapshot" FROM ducklake_schema WHERE schema_name = ?', [
        'sales',
      ]),
    ).toEqual([{ endsnapshot: null }]);
    expect(await driver.query("SELECT x'0102ff' AS bytes, zeroblob(0) AS none")).toEqual([
      { bytes: 'AQL/', none: '' },
    ]);
  });

  it('binds booleans as 0 and 1, NULL as null and strings with quotes as plain text', async () => {
    const text = `it's "quoted"; --`;
    expect(await driver.query('SELECT ? AS t, ? AS f, ? AS n, ? AS s', [true, false, null, text])).toEqual([
      { t: 1, f: 0, n: null, s: text },
    ]);
  });

  it('refuses to modify the catalog', async () => {
    await expect(driver.query("DELETE FROM ducklake_metadata WHERE key = 'version'")).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      cause: { message: expect.stringContaining('readonly') as unknown },
    });
    expect(await driver.query("SELECT count(*) AS n FROM ducklake_metadata WHERE key = 'version'")).toEqual([
      { n: 1 },
    ]);
  });

  it('rejects with ABORTED when the signal is already aborted and runs the query when it is not', async () => {
    await expect(driver.query('SELECT 1', [], { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'ABORTED',
    });
    const controller = new AbortController();
    expect(await driver.query('SELECT 1 AS one', [], { signal: controller.signal })).toEqual([{ one: 1 }]);
  });

  it('reports a malformed statement as QUERY_FAILED with the engine message as the cause, also when sql.js throws a plain string', async () => {
    await expect(driver.query('SELEC nothing')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('SELEC') as unknown,
      cause: { message: 'near "SELEC": syntax error' },
    });
    await expect(driver.query('')).rejects.toMatchObject({
      code: 'QUERY_FAILED',
      userMessage: expect.stringContaining('Nothing to prepare') as unknown,
      cause: 'Nothing to prepare',
    });
  });
});

describe('sqlite driver numbers', () => {
  it('refuses an integer that a double cannot hold exactly, like the other drivers, and passes the largest exact one', async () => {
    const driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
    try {
      await expect(driver.query('SELECT 9007199254740991 AS edge, 1.5 AS half')).resolves.toEqual([
        { edge: Number.MAX_SAFE_INTEGER, half: 1.5 },
      ]);
      await expect(driver.query('SELECT 9007199254740993 AS big')).rejects.toMatchObject({
        code: 'QUERY_FAILED',
      });
    } finally {
      await driver.close();
    }
  });
});

describe('sqlite driver on unusable files', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aantje-sqlite-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('frees the database on close, so a closed driver reports a closed connection, also to the reader', async () => {
    const closed = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
    await closed.close();
    await closed.close();
    await expect(closed.query('SELECT 1')).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    // The reader must not take the closed connection for a missing table or a database that is no DuckLake.
    const reader = createCatalogReader(closed);
    await expect(reader.info()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
    await expect(reader.partitioning(1, LATEST_SNAPSHOT, [])).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
    });
  });

  it('reports a missing file as FILE_NOT_FOUND and a file that is no SQLite database as CONNECTION_FAILED, naming the path', async () => {
    const missing = join(dir, 'missing.sqlite');
    await expect(openSqlite({ path: missing, wasmPath })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      userMessage: expect.stringContaining(missing) as unknown,
      cause: { code: 'ENOENT' },
    });

    const text = join(dir, 'text.sqlite');
    writeFileSync(text, 'this is plain text, definitely not a database file '.repeat(20));
    await expect(openSqlite({ path: text, wasmPath })).rejects.toMatchObject({
      code: 'CONNECTION_FAILED',
      userMessage: expect.stringContaining(text) as unknown,
      cause: { message: 'file is not a database' },
    });
  });

  it('rejects a wrong wasmPath with the file system error, not with an AantjeError', async () => {
    const error: unknown = await openSqlite({
      path: fixturePath('ducklake.sqlite'),
      wasmPath: join(dir, 'missing.wasm'),
    }).catch((reason: unknown) => reason);
    expect(error).not.toBeInstanceOf(AantjeError);
    expect(error).toMatchObject({ code: 'ENOENT' });
  });

  it('leaves the catalog file and its directory untouched, even after the guard is switched off in memory', async () => {
    const sub = mkdtempSync(join(dir, 'untouched-'));
    const path = join(sub, 'catalog.sqlite');
    copyFileSync(fixturePath('ducklake.sqlite'), path);
    const snapshot = (): { hash: string; files: string[] } => ({
      hash: createHash('sha256').update(readFileSync(path)).digest('hex'),
      files: readdirSync(sub).sort(),
    });
    const before = snapshot();

    const opened = await openSqlite({ path, wasmPath });
    for (const sql of [
      "INSERT INTO ducklake_metadata (key, value) VALUES ('x', 'y')",
      "UPDATE ducklake_metadata SET value = 'x'",
      'CREATE TABLE evil (a INTEGER)',
      'DROP TABLE ducklake_metadata',
      'VACUUM',
    ]) {
      await expect(opened.query(sql)).rejects.toMatchObject({ code: 'QUERY_FAILED' });
    }
    await opened.query('PRAGMA query_only = OFF');
    await opened.query('DELETE FROM ducklake_metadata');
    await opened.close();

    expect(snapshot()).toEqual(before);
    expect(before.files).toEqual(['catalog.sqlite']);
  });

  describe('catalogs in WAL mode', () => {
    let writer: DatabaseSync;
    let path: string;
    beforeAll(() => {
      path = join(dir, 'wal-mode.sqlite');
      copyFileSync(fixturePath('ducklake.sqlite'), path);
      writer = new DatabaseSync(path);
      writer.exec('PRAGMA journal_mode = WAL');
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    });
    afterAll(() => writer.close());

    const versions = async (): Promise<unknown> => {
      const opened = await openSqlite({ path, wasmPath });
      try {
        return await opened.query(VERSION_SQL);
      } finally {
        await opened.close();
      }
    };

    it('opens while the writer is connected and the log is empty, and is not blocked by an exclusive lock: it returns the committed state', async () => {
      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(await versions()).toEqual([{ value: SPEC_VERSION }]);

      writer.exec('BEGIN EXCLUSIVE');
      try {
        writer.exec("UPDATE ducklake_metadata SET value = 'uncommitted' WHERE key = 'version'");
        expect(await versions()).toEqual([{ value: SPEC_VERSION }]);
      } finally {
        writer.exec('ROLLBACK');
      }
    });

    it('is refused once a commit sits in the write-ahead log, instead of showing stale data', async () => {
      writer.exec("INSERT INTO ducklake_metadata (key, value) VALUES ('wal-marker', '1')");
      expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
      await expect(openSqlite({ path, wasmPath })).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
        userMessage: expect.stringContaining('write-ahead log') as unknown,
      });

      // The same for a stray log file next to a catalog that is not in WAL mode; an empty log is fine.
      const stray = join(dir, 'wal.sqlite');
      copyFileSync(fixturePath('ducklake.sqlite'), stray);
      writeFileSync(`${stray}-wal`, Buffer.alloc(32, 1));
      await expect(openSqlite({ path: stray, wasmPath })).rejects.toMatchObject({
        code: 'CONNECTION_FAILED',
      });
      writeFileSync(`${stray}-wal`, Buffer.alloc(0));
      const opened = await openSqlite({ path: stray, wasmPath });
      try {
        expect(await opened.query(VERSION_SQL)).toEqual([{ value: SPEC_VERSION }]);
      } finally {
        await opened.close();
      }
    });
  });
});
