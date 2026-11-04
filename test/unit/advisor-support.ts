import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { extensionDirectory } from './data-support';
import type { AdvisorData, AdvisorTable } from '../../src/advisor/model';
import type { DataAccess } from '../../src/data/types';
import type { BackendLake } from './lake-backends';

export const accessOf = (lake: BackendLake, extra: Partial<DataAccess> = {}): DataAccess => ({
  profile: lake.profile,
  ...(lake.password === undefined ? {} : { password: lake.password }),
  s3: {},
  extensionDirectory,
  ...extra,
});

export const rows = async (lake: BackendLake, sql: string): Promise<unknown[][]> =>
  (await lake.connection.runAndReadAll(sql)).getRowsJson();

const run = async (lake: BackendLake, sql: string): Promise<void> => void (await lake.connection.run(sql));

/**
 * Runs statements on the metadata of the lake as `meta` through a second engine. The metadata of a lake that another
 * connection has attached cannot be written through that connection (SQLite: database is locked).
 */
export async function editMetadata(lake: BackendLake, statements: readonly string[]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
  const connection = await instance.connect();
  try {
    const { profile } = lake;
    // The times are written as text in the time zone of the session; the lake writes them in UTC.
    await connection.run("SET TimeZone = 'UTC'");
    if (profile.kind === 'postgres') {
      await connection.run('LOAD postgres');
      await connection.run(
        `ATTACH 'host=${profile.host} port=${profile.port} dbname=${profile.database} user=${profile.user} password=${lake.password ?? ''}' AS meta (TYPE postgres, SCHEMA '${profile.metadataSchema ?? 'public'}')`,
      );
    } else if (profile.kind !== 'quack') {
      await connection.run('LOAD sqlite');
      await connection.run(`ATTACH '${profile.path}' AS meta (TYPE sqlite)`);
    }
    for (const statement of statements) {
      await connection.run(statement);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** The files that the lake builds as orphans, with the size of each. */
export const ORPHANS = [
  { name: 'old-orphan.parquet', bytes: 1234, ageDays: 10 },
  { name: 'sub/older-orphan.parquet', bytes: 4321, ageDays: 20 },
] as const;

/** The bytes of the old orphans. */
export const ORPHAN_BYTES = ORPHANS.reduce<number>((sum, { bytes }) => sum + bytes, 0);

/** A leftover that is too young for the age that DuckLake applies; no dry run lists it. */
export const YOUNG_ORPHAN = { name: 'young-orphan.parquet', bytes: 777 } as const;

/**
 * A lake in which every kind of maintenance has something to do, with numbers that do not change:
 *
 * - `gone` (dropped) and `merged` (3 inserts, then merged): their 4 files wait for the cleanup after the first expiry,
 *   the 3 of `merged` since 10 days, the one of `gone` since now;
 * - the snapshots up to the creation of `many` are 40 days old;
 * - `many`: 6 inserts of 10 rows, 6 small files;
 * - `mostly_deleted` (96 of 100 rows deleted), `half_deleted` (60 of 100), `barely_deleted` (10 of 100);
 * - `inlined` (10,500 rows kept in the catalog) and `inlined_few` (5 rows);
 * - two old orphans and one young one in the data directory.
 */
export async function buildAdvisorLake(lake: BackendLake): Promise<void> {
  const sql = (text: string): Promise<void> => run(lake, text);
  await sql('CREATE TABLE gone(id INTEGER)');
  await sql('INSERT INTO gone SELECT range FROM range(10)');
  await sql('DROP TABLE gone');
  await sql('CREATE TABLE merged(id INTEGER)');
  for (let part = 0; part < 3; part++) {
    await sql(`INSERT INTO merged SELECT range + ${part * 10} FROM range(10)`);
  }
  await sql("CALL ducklake_merge_adjacent_files('lake', 'merged')");
  await sql("CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)");
  await editMetadata(lake, [
    "UPDATE meta.ducklake_files_scheduled_for_deletion SET schedule_start = now() - INTERVAL 10 DAY WHERE path LIKE '%merged%'",
  ]);

  await sql('CREATE TABLE many(id INTEGER)');
  for (let part = 0; part < 6; part++) {
    await sql(`INSERT INTO many SELECT range + ${part * 10} FROM range(10)`);
  }
  await editMetadata(lake, [
    'UPDATE meta.ducklake_snapshot SET snapshot_time = now() - INTERVAL 40 DAY + to_minutes(CAST(snapshot_id AS INTEGER)) WHERE snapshot_id <= (SELECT max(snapshot_id) FROM meta.ducklake_snapshot)',
  ]);

  for (const [name, deleted] of [
    ['mostly_deleted', 96],
    ['half_deleted', 60],
    ['barely_deleted', 10],
  ] as const) {
    await sql(`CREATE TABLE ${name}(id INTEGER)`);
    await sql(`INSERT INTO ${name} SELECT range FROM range(100)`);
    await sql(`DELETE FROM ${name} WHERE id < ${deleted}`);
  }
  await sql('CREATE TABLE inlined(id INTEGER)');
  await sql("CALL lake.set_option('data_inlining_row_limit', 20000, table_name => 'inlined')");
  await sql('INSERT INTO inlined SELECT range FROM range(10500)');
  await sql('CREATE TABLE inlined_few(id INTEGER)');
  await sql("CALL lake.set_option('data_inlining_row_limit', 20000, table_name => 'inlined_few')");
  await sql('INSERT INTO inlined_few SELECT range FROM range(5)');

  for (const { name, bytes, ageDays } of ORPHANS) {
    const path = join(lake.dataDirectory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'x'.repeat(bytes));
    const old = new Date(Date.now() - ageDays * 86_400_000);
    utimesSync(path, old, old);
  }
  writeFileSync(join(lake.dataDirectory, YOUNG_ORPHAN.name), 'y'.repeat(YOUNG_ORPHAN.bytes));
}

/** Every file below a directory with a hash of its content. */
export function directoryFingerprint(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else {
        result[file] = `${statSync(file).size}:${createHash('md5').update(readFileSync(file)).digest('hex')}`;
      }
    }
  };
  walk(directory);
  return result;
}

/** A hash of every row of every catalog table: equal before and after means that nothing was committed. */
export async function catalogFingerprint(lake: BackendLake): Promise<Record<string, string>> {
  const tables = (
    await rows(
      lake,
      "SELECT table_name FROM duckdb_tables() WHERE database_name = '__ducklake_metadata_lake' AND table_name LIKE 'ducklake_%' ORDER BY table_name",
    )
  ).map((row) => String(row[0]));
  const result: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await rows(
      lake,
      `SELECT count(*), md5(string_agg(CAST(t AS VARCHAR), '|' ORDER BY CAST(t AS VARCHAR))) FROM __ducklake_metadata_lake.${table} t`,
    );
    result[table] = `${String(row?.[0])}:${String(row?.[1])}`;
  }
  return result;
}

/** The tables of the sample: a table with a very large number of small files, a small one, and the rest. */
export const table = (id: number, name: string, schema = 'shop'): AdvisorTable => ({
  id,
  schemaId: 1,
  schema,
  name,
});

/**
 * Advisor data that does not depend on a lake, with every kind of advice and the sizes a real lake has: 40 files and
 * 3 GiB for the cleanup, 120 snapshots of which 100 expire, a table of 2,000 files of which 1,900 are small, one with
 * files that are 98 % deleted and one with files that are 60 % deleted, and 2 million inlined rows.
 */
export function sampleAdvisor(changes: Partial<AdvisorData> = {}): AdvisorData {
  return {
    connection: 'Lake',
    scope: { kind: 'lake' },
    snapshot: 130,
    readAt: '2026-10-31T12:00:00.000Z',
    policy: {
      expire: { text: '30 days', source: 'default' },
      delete: null,
      rewrite: { share: 0.95, source: 'default' },
      target: { bytes: 512_000_000, source: 'default' },
      unreadable: [],
    },
    scheduled: {
      count: 45,
      oldestScheduledAt: '2026-10-20T08:00:00.000Z',
      split: {
        age: { text: '7 days', source: 'option' },
        ready: 40,
        waiting: 5,
        nextReadyAt: '2026-11-04T08:00:00.000Z',
      },
    },
    expirable: {
      age: { text: '30 days', source: 'default' },
      ready: 100,
      waiting: 19,
      nextReadyAt: '2026-11-04T08:00:00.000Z',
    },
    expiry: {
      state: 'measured',
      value: {
        snapshots: 120,
        expiring: 100,
        oldest: '2026-08-01T00:00:00.000Z',
        newest: '2026-09-20T00:00:00.000Z',
      },
    },
    cleanup: { state: 'measured', value: { files: 40, bytes: 3 * 1024 ** 3, sized: 40 } },
    orphans: { state: 'measured', value: { files: 2, bytes: 5555, sized: 2 } },
    merge: [
      {
        table: table(1, 'events'),
        files: 2000,
        smallFiles: 1900,
        smallBytes: 63 * 512_000_000,
        estimatedAfter: 163,
      },
      { table: table(2, 'notes'), files: 6, smallFiles: 6, smallBytes: 3600, estimatedAfter: 1 },
    ],
    rewrite: [
      {
        table: table(3, 'orders'),
        files: 4,
        atThreshold: 3,
        records: 4_000_000,
        deleted: 3_920_000,
        sizeBytes: 2 * 1024 ** 3,
      },
      {
        table: table(4, 'carts'),
        files: 1,
        atThreshold: 0,
        records: 100,
        deleted: 60,
        sizeBytes: 613,
      },
    ],
    flush: [{ table: table(5, 'clicks'), rows: 2_000_000 }],
    ...changes,
  };
}
