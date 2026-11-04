import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import type { FileProfile } from '../../src/connections/profile';
import { runHealthCheck } from '../../src/health/run';
import { accessFor, engineSkipReason, extensionDirectory } from './data-support';
import { createLake } from './health-lake-support';
import { NOW } from './health-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`Health check lake tests are skipped: ${skipReason}`);
}

// A lake that DuckDB itself writes and maintains: after every kind of maintenance the health check must find neither an
// error nor a warning, with the deep check and for every table. This is what keeps the consistency checks from crying wolf.
describe.skipIf(skipReason)('a lake that DuckLake writes and maintains', () => {
  const { stage, check, tableIds, expectHealthy, dispose } = createLake('aantje-healthlake-');

  beforeAll(async () => {
    await stage([
      'CREATE SCHEMA shop',
      'CREATE TABLE shop.events (id INT, kind VARCHAR, ts TIMESTAMP)',
      'ALTER TABLE shop.events SET PARTITIONED BY (kind)',
      "INSERT INTO shop.events VALUES (1, 'a', '2025-01-01'), (2, 'b', '2025-01-02')",
      "INSERT INTO shop.events VALUES (3, 'a', '2025-01-03')",
      "INSERT INTO shop.events VALUES (4, 'b', '2025-01-04')",
      'CREATE TABLE shop.plain (x INT, y VARCHAR)',
      "INSERT INTO shop.plain SELECT range, 'a' FROM range(40)",
      "INSERT INTO shop.plain SELECT range, 'b' FROM range(40)",
      'CREATE TABLE shop.small (x INT)',
      "CALL lake.set_option('data_inlining_row_limit', 10, table_name => 'small', schema => 'shop')",
      'INSERT INTO shop.small VALUES (1), (2), (3)',
      'CREATE TABLE shop.doomed (x INT)',
      'INSERT INTO shop.doomed SELECT range FROM range(10)',
      'DELETE FROM shop.doomed WHERE x < 5',
    ]);
  });
  afterAll(dispose);

  it('is healthy after writing: inserts, partitioning, inlined rows, a delete file', async () => {
    await expectHealthy();
  });

  it('is healthy after updates and deletes, a new column, a rename and a dropped table', async () => {
    await stage([
      "UPDATE shop.plain SET y = 'z' WHERE x < 5",
      'DELETE FROM shop.plain WHERE x BETWEEN 10 AND 15',
      'DELETE FROM shop.events WHERE id = 2',
      'ALTER TABLE shop.plain ADD COLUMN extra INT',
      "INSERT INTO shop.plain VALUES (100, 'n', 1)",
      'ALTER TABLE shop.events RENAME TO happenings',
      'DROP TABLE shop.doomed',
    ]);

    await expectHealthy();
  });

  it('is healthy after merging adjacent files', async () => {
    await stage(["CALL ducklake_merge_adjacent_files('lake')"]);

    await expectHealthy();
  });

  it('is healthy after rewriting the data files with many deletes', async () => {
    await stage([
      'DELETE FROM shop.plain WHERE x > 60',
      "CALL ducklake_rewrite_data_files('lake', delete_threshold => 0.01)",
    ]);

    await expectHealthy();
  });

  it('is healthy after flushing the inlined data', async () => {
    await stage(["CALL ducklake_flush_inlined_data('lake')"]);

    await expectHealthy();
  });

  it('is healthy after expiring the snapshots, cleaning up and deleting orphans, and says what it did to the numbering', async () => {
    await stage([
      "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
      "CALL ducklake_cleanup_old_files('lake', cleanup_all => true)",
      "CALL ducklake_delete_orphaned_files('lake', cleanup_all => true)",
    ]);

    await expectHealthy();
    const report = await check();
    expect(report.findings.map((item) => item.id)).not.toContain('catalog.cleanup-pending');
    // Every table on its own is healthy as well.
    const tables = await tableIds();
    expect([...tables.keys()].sort()).toEqual(['happenings', 'plain', 'small']);
    for (const id of tables.values()) {
      const own = await check(id);
      expect(own.findings.filter((item) => item.severity !== 'info')).toEqual([]);
      expect(own.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
    }
  });
});

// DuckDB leaves the delete file of a data file open when it later deletes the whole data file: that is not a defect.
describe.skipIf(skipReason)('a lake whose rows DuckDB deleted in part and then all', () => {
  const { stage, expectHealthy, dispose } = createLake('aantje-healthdel-');
  afterAll(dispose);

  it('is healthy after a partial delete, a delete of everything, expiry and cleanup, and after dropping a table with a delete file', async () => {
    await stage([
      'CREATE TABLE t (a INT)',
      'INSERT INTO t SELECT range FROM range(10)',
      'DELETE FROM t WHERE a < 3',
      'CREATE TABLE u (a INT)',
      'INSERT INTO u SELECT range FROM range(10)',
      'DELETE FROM u WHERE a < 3',
    ]);
    await expectHealthy();

    await stage(['DELETE FROM t', 'DROP TABLE u']);
    await expectHealthy();

    await stage([
      "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
      "CALL ducklake_cleanup_old_files('lake', cleanup_all => true)",
    ]);
    await expectHealthy();
  });
});

// The rows of inlined data keep their ids when they are flushed: the file holds each id once per version of the row.
describe.skipIf(skipReason)('a lake whose inlined rows of several snapshots were flushed to one file', () => {
  const { stage, expectHealthy, dispose } = createLake('aantje-healthflush-');
  afterAll(dispose);

  it('is healthy: the ids in the flushed file are not a claim on the ids of the files next to it', async () => {
    await stage([
      'CREATE TABLE t (a INT)',
      "CALL lake.set_option('data_inlining_row_limit', 100)",
      'INSERT INTO t SELECT range FROM range(10)',
      'DELETE FROM t WHERE a < 3',
      'UPDATE t SET a = a + 100 WHERE a > 7',
      "CALL lake.set_option('data_inlining_row_limit', 0)",
      'INSERT INTO t SELECT range FROM range(10)',
      "CALL lake.set_option('data_inlining_row_limit', 100)",
      'INSERT INTO t SELECT range FROM range(4)',
      "CALL ducklake_flush_inlined_data('lake')",
    ]);

    await expectHealthy();
  });
});

describe.skipIf(skipReason)('a lake whose deletes are deletion vectors (Puffin files)', () => {
  const { stage, expectHealthy, dispose } = createLake('aantje-healthpuffin-');
  afterAll(dispose);

  it('is healthy, and the deep check leaves the Puffin file unopened and says so', async () => {
    await stage([
      "CALL lake.set_option('write_deletion_vectors', true)",
      'CREATE TABLE t (a INT)',
      'INSERT INTO t SELECT range FROM range(10)',
      'DELETE FROM t WHERE a < 3',
    ]);

    const report = await expectHealthy();

    expect(report.groups[3]).toEqual({ group: 'deep', state: 'done', notChecked: 1 });
  });
});

describe.skipIf(skipReason)('a lake whose table was dropped and created again under the same name', () => {
  const { stage, check, tableIds, dispose } = createLake('aantje-healthagain-');
  afterAll(dispose);

  it('does not call the files of the dropped table orphans of the new one, for the lake or for the table', async () => {
    await stage([
      'CREATE TABLE u (a INT)',
      'INSERT INTO u VALUES (1)',
      'DROP TABLE u',
      'CREATE TABLE u (a INT)',
      'INSERT INTO u VALUES (2)',
    ]);
    const newId = (await tableIds()).get('u') ?? -1;

    const own = await check(newId);
    const all = await check();

    expect(own.findings).toEqual([]);
    expect(all.findings.filter((item) => item.group === 'storage')).toEqual([]);
    expect(own.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);
  });
});

// Names with characters that mean something in a glob pattern or in a SQL literal.
describe.skipIf(skipReason)('a lake whose directory and partition values have unusual characters', () => {
  const directory = mkdtempSync(join(tmpdir(), "aantje-health-we[ir]d 'dir'-"));
  const profile: FileProfile = {
    id: 'odd',
    name: 'odd',
    kind: 'duckdb',
    path: join(directory, 'odd.ducklake'),
  };
  const files = `${directory.replaceAll('\\', '/')}/data [1]/`;

  async function run(statements: readonly string[]): Promise<void> {
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      await connection.run('LOAD ducklake');
      await connection.run(
        `ATTACH 'ducklake:${profile.path.replaceAll('\\', '/').replaceAll("'", "''")}' AS lake (DATA_PATH '${files.replaceAll("'", "''")}', DATA_INLINING_ROW_LIMIT 0)`,
      );
      await connection.run('USE lake');
      for (const sql of statements) await connection.run(sql);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  }

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('finds its files, and a lost one, although the data path has brackets, a space and a quote', async () => {
    await run([
      `CREATE SCHEMA "sch ema'1"`,
      `CREATE TABLE "sch ema'1"."t [1]" (k VARCHAR, v INT)`,
      `ALTER TABLE "sch ema'1"."t [1]" SET PARTITIONED BY (k)`,
      `INSERT INTO "sch ema'1"."t [1]" VALUES ('a b/c', 1), ('x*y', 2), ('[z]', 3), ('%20', 4), ('', 5), (NULL, 6)`,
    ]);
    const reader = createCatalogReader(await openDuckdb({ path: profile.path }));
    const access = accessFor({ profile, directory, remove: () => Promise.resolve() });
    const check = () =>
      runHealthCheck(
        { reader, access, now: () => NOW },
        { scope: { kind: 'lake' }, depth: 'deep', snapshot: 3 },
      );
    try {
      const healthy = await check();
      expect(healthy.findings.map((item) => item.id)).toEqual(['catalog.small-files:table:2']);
      expect(healthy.groups.map((group) => group.state)).toEqual(['done', 'done', 'done', 'done']);

      const places = await reader.fileLocations({}, (await reader.properties()).dataPath, 100);
      expect(places.files).toHaveLength(6);
      const odd = places.files.find((file) => file.location?.includes('k=x%2Ay')) ?? places.files[0];
      rmSync(odd?.location ?? '');

      const broken = await check();
      expect(broken.findings.map((item) => item.id)).toEqual([
        'catalog.small-files:table:2',
        `storage.file-missing:data:${odd?.id}`,
      ]);
      expect(broken.findings[1]?.objectKey).toBe(odd?.location);
      expect(broken.findings[1]?.objectKey).toContain('we[ir]d');
    } finally {
      await reader.close();
    }
  });
});
