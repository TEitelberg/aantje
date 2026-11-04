import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { previewQuery, setupStatements } from '../../src/data/attach';
import { checkRelation, describeRelation, previewTable, readChanges } from '../../src/data/engine';
import { guardRelation } from '../../src/data/guard';
import { AantjeError } from '../../src/errors';
import { createLake, engineSkipReason, extensionDirectory } from './data-support';
import type { Lake } from './data-support';
import { lakeBackends } from './lake-backends';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`View guard tests are skipped: ${skipReason}`);
}

/** Every data file below the lake's directory. */
async function dataFiles(lake: Lake): Promise<string[]> {
  const entries = await readdir(join(dirname(lake.profile.path), 'lake.ducklake.files'), {
    recursive: true,
    withFileTypes: true,
  });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
}

/**
 * A lake whose dropped table left three Parquet files that are scheduled for deletion (the snapshots that referenced
 * them expired), plus one live table, and then `view` over `source`.
 */
async function lakeWithPendingDeletes(source: string, extra: readonly string[] = []): Promise<Lake> {
  return createLake([
    'CREATE TABLE gone (a INTEGER)',
    'INSERT INTO gone VALUES (1)',
    'INSERT INTO gone VALUES (2)',
    'INSERT INTO gone VALUES (3)',
    'CREATE TABLE live (b INTEGER)',
    'INSERT INTO live VALUES (10)',
    'DROP TABLE gone',
    "CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)",
    `CREATE VIEW evil AS ${source}`,
    ...extra,
  ]);
}

// The view-trust gate has its own tests; these reads are of a trusted connection, so the read-only check is reached.
const access = (lake: Lake) => ({ profile: lake.profile, s3: {}, extensionDirectory, viewsTrusted: true });

async function refusal(promise: Promise<unknown>): Promise<AantjeError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(AantjeError);
  return error as AantjeError;
}

describe.skipIf(skipReason)('a view that calls a DuckLake maintenance function', () => {
  const maintenance = [
    "SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)",
    "SELECT * FROM ducklake_delete_orphaned_files('lake', cleanup_all => true)",
    "SELECT * FROM ducklake_expire_snapshots('lake', older_than => now())",
    "SELECT * FROM ducklake_merge_adjacent_files('lake')",
    "SELECT * FROM ducklake_flush_inlined_data('lake')",
    "SELECT * FROM ducklake_rewrite_data_files('lake')",
    "SELECT * FROM checkpoint('lake')",
    "SELECT * FROM force_checkpoint('lake')",
    "SELECT * FROM (SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)) AS inner_query",
    "WITH c AS (SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)) SELECT * FROM c",
    "SELECT 1 AS one WHERE EXISTS (SELECT 1 FROM DUCKLAKE_CLEANUP_OLD_FILES('lake', cleanup_all => true))",
    "SELECT * FROM query('SELECT * FROM ducklake_cleanup_old_files(''lake'', cleanup_all => true)')",
    // The same functions reached through the catalog (they carry no `ducklake_` prefix there).
    'SELECT * FROM lake.merge_adjacent_files()',
    'SELECT * FROM lake.main.merge_adjacent_files()',
    "SELECT * FROM lake.set_option('parquet_compression', 'zstd')",
    "SELECT * FROM lake.set_commit_message('a', 'b')",
    'SELECT * FROM LAKE.MAIN.Merge_Adjacent_Files()',
  ];

  it('deletes the files that are scheduled for deletion although the lake is attached read-only and locked (why the guard exists)', async () => {
    const lake = await lakeWithPendingDeletes(maintenance[0] as string);
    const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
    const connection = await instance.connect();
    try {
      for (const sql of setupStatements(access(lake))) {
        await connection.run(sql);
      }
      const before = (await dataFiles(lake)).length;
      await connection.run(previewQuery({ schema: 'main', table: 'evil' })).catch(() => undefined);
      expect((await dataFiles(lake)).length).toBeLessThan(before);
    } finally {
      connection.closeSync();
      instance.closeSync();
      await lake.remove();
    }
  });

  it('refuses every one of them in the preview and in the column lookup, and removes nothing', async () => {
    const lake = await lakeWithPendingDeletes(
      'SELECT 1 AS one',
      maintenance.map((source, index) => `CREATE VIEW maintenance_${index} AS ${source}`),
    );
    try {
      const before = await dataFiles(lake);

      for (const [index, source] of maintenance.entries()) {
        const relation = { schema: 'main', table: `maintenance_${index}` };
        for (const run of [
          () => previewTable(access(lake), relation),
          () => describeRelation(access(lake), relation),
        ]) {
          const error = await refusal(run());
          expect(error.code, source).toBe('QUERY_FAILED');
          expect(error.userMessage, source).toContain(`main.maintenance_${index}`);
        }
        expect(await dataFiles(lake), source).toEqual(before);
      }
    } finally {
      await lake.remove();
    }
    // 17 views, each opened twice with the real engine: slow when the whole suite runs in parallel.
  }, 120_000);
});

describe.skipIf(skipReason)('what the view guard follows and what it leaves alone', () => {
  const cleanup = "ducklake_cleanup_old_files('lake', cleanup_all => true)";

  it('refuses a view of a view and a view through a macro, naming what it follows, and leaves other relations alone', async () => {
    const lake = await lakeWithPendingDeletes(`SELECT * FROM ${cleanup}`, [
      'CREATE VIEW outer_view AS SELECT * FROM (SELECT * FROM evil)',
      `CREATE MACRO tidy() AS TABLE SELECT * FROM ${cleanup}`,
      `CREATE MACRO tidy_count() AS (SELECT count(*) FROM ${cleanup})`,
      'CREATE VIEW via_table_macro AS SELECT * FROM tidy()',
      'CREATE VIEW via_scalar_macro AS SELECT tidy_count() AS n',
      'CREATE VIEW harmless AS SELECT b FROM live',
    ]);
    try {
      const before = await dataFiles(lake);
      const nested = await refusal(previewTable(access(lake), { schema: 'main', table: 'outer_view' }));
      expect(nested.userMessage).toContain('main.outer_view');
      expect(nested.userMessage).toContain('ducklake_cleanup_old_files');
      expect(nested.userMessage).toContain('"evil"');

      for (const [view, macro] of [
        ['via_table_macro', 'tidy'],
        ['via_scalar_macro', 'tidy_count'],
      ] as const) {
        const error = await refusal(previewTable(access(lake), { schema: 'main', table: view }));
        expect(error.userMessage, view).toContain(`"${macro}"`);
      }
      expect(await dataFiles(lake)).toEqual(before);

      // Only the view that is read is judged: a table and a harmless view are not blocked by another view.
      expect((await previewTable(access(lake), { schema: 'main', table: 'live' })).rows).toEqual([[10]]);
      expect((await previewTable(access(lake), { schema: 'main', table: 'harmless' })).rows).toEqual([[10]]);
    } finally {
      await lake.remove();
    }
  });

  it('previews views that read: over a table, with read-only DuckLake functions, through the catalog name and a macro of the lake', async () => {
    const lake = await createLake([
      'CREATE TABLE t (a INTEGER)',
      'INSERT INTO t VALUES (1), (2)',
      'CREATE MACRO doubled(x) AS x * 2',
      'CREATE VIEW over_table AS SELECT doubled(a) AS d FROM t WHERE a IN (SELECT a FROM t)',
      "CREATE VIEW over_snapshots AS SELECT count(*) AS n FROM ducklake_snapshots('lake')",
      'CREATE VIEW via_snapshots AS SELECT count(*) AS n FROM lake.snapshots()',
      "CREATE VIEW via_changes AS SELECT count(*) AS n FROM lake.main.table_changes('t', 1, 2)",
      'CREATE VIEW via_macro AS SELECT lake.main.doubled(a) AS d FROM t',
    ]);
    try {
      const read = async (table: string) =>
        (await previewTable(access(lake), { schema: 'main', table })).rows;
      expect(await read('over_table')).toEqual([[2], [4]]);
      expect(Number((await read('over_snapshots'))[0]?.[0])).toBeGreaterThan(0);
      expect(Number((await read('via_snapshots'))[0]?.[0])).toBeGreaterThan(0);
      // count(*) is a BIGINT, which the grid carries as text.
      expect(await read('via_changes')).toEqual([['2']]);
      expect(await read('via_macro')).toEqual([[2], [4]]);
    } finally {
      await lake.remove();
    }
  });

  it('checks the view as it is at the snapshot that is read', async () => {
    const lake = await createLake([
      'CREATE TABLE t (a INTEGER)',
      'INSERT INTO t VALUES (1)',
      'CREATE VIEW v AS SELECT a FROM t',
      'CREATE OR REPLACE VIEW v AS SELECT * FROM ' + cleanup,
    ]);
    try {
      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      let snapshots: unknown[][];
      try {
        await connection.run('LOAD ducklake');
        await connection.run(
          `ATTACH 'ducklake:${lake.profile.path.replaceAll("'", "''")}' AS lake (READ_ONLY)`,
        );
        snapshots = (
          await connection.runAndReadAll('SELECT snapshot_id FROM lake.snapshots() ORDER BY 1')
        ).getRowsJson();
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      const safe = Number(snapshots.at(-2)?.[0]);

      expect(
        (await previewTable({ ...access(lake), snapshot: safe }, { schema: 'main', table: 'v' })).rows,
      ).toEqual([[1]]);
      await refusal(previewTable(access(lake), { schema: 'main', table: 'v' }));
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason)('what the view guard reads from the catalog', () => {
  it('parses only the views and macros that the view read reaches, not every view of a lake with 2,000 of them', async () => {
    // `start` reads `middle`, which reads `base`, which reads the table `t`; the closure of the view is three views.
    const lake = await createLake([
      'CREATE TABLE t (a INTEGER)',
      'INSERT INTO t VALUES (1)',
      'CREATE MACRO doubled(x) AS x * 2',
      'CREATE VIEW base AS SELECT doubled(a) AS d FROM t',
      'CREATE VIEW middle AS SELECT d FROM base',
      'CREATE VIEW start AS SELECT * FROM middle',
    ]);
    try {
      // 2,000 more views, written into the metadata directly (DuckLake would need one snapshot per view).
      const meta = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const editor = await meta.connect();
      try {
        await editor.run(`ATTACH '${lake.profile.path.replaceAll("'", "''")}' AS meta`);
        await editor.run(
          "INSERT INTO meta.ducklake_view SELECT 10000 + i, uuid(), 1, NULL, 0, 'noise_' || i, 'duckdb', 'SELECT ' || i || ' AS n FROM t', '' FROM range(2000) r(i)",
        );
      } finally {
        editor.closeSync();
        meta.closeSync();
      }

      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      try {
        for (const sql of setupStatements(access(lake))) {
          await connection.run(sql);
        }
        let parsed = 0;
        let listed = 0;
        const counting = {
          async runAndReadAll(sql: string) {
            const reader = await connection.runAndReadAll(sql);
            if (sql.includes('json_serialize_sql')) parsed += reader.getRowsJson().length;
            if (sql.includes('duckdb_functions()')) listed++;
            return reader;
          },
        };

        await guardRelation(counting, { schema: 'main', table: 'start' }, undefined, { trusted: true });

        // start, middle, base and the macro doubled; none of the 2,000 others.
        expect(parsed).toBe(4);
        // The functions of the engine are listed once per process, not once per view read (an earlier test may have).
        const listedBefore = listed;
        expect(listedBefore).toBeLessThanOrEqual(1);
        await guardRelation(counting, { schema: 'main', table: 'start' }, undefined, { trusted: true });
        expect([parsed, listed]).toEqual([8, listedBefore]);
        expect(
          (await connection.runAndReadAll('SELECT count(*) FROM lake.main.noise_7')).getRowsJson(),
        ).toEqual([['1']]);
      } finally {
        connection.closeSync();
        instance.closeSync();
      }
      expect((await previewTable(access(lake), { schema: 'main', table: 'start' })).rows).toEqual([[2]]);
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason)('a view is refused until the connection is trusted, from what is read', () => {
  // The untrusted access carries no `viewsTrusted`: the guard must refuse a view before binding its SQL.
  const untrusted = (lake: Lake) => ({ profile: lake.profile, s3: {}, extensionDirectory });

  it('refuses every read that binds a view with VIEW_UNTRUSTED, and resolves it once trusted', async () => {
    const lake = await createLake([
      'CREATE TABLE base (a INTEGER)',
      'INSERT INTO base VALUES (42)',
      'CREATE VIEW ok AS SELECT a FROM base',
    ]);
    try {
      const ok = { schema: 'main', table: 'ok' };
      // Every read that binds a view is gated the same way, so the grid, the column lookup, the notebook kernel and Show
      // Changes are all covered; a view's SQL (which may read files or the network) never runs before the user agrees.
      for (const run of [
        () => previewTable(untrusted(lake), ok),
        () => describeRelation(untrusted(lake), ok),
        () => checkRelation(untrusted(lake), ok),
        () => readChanges(untrusted(lake), ok, { from: 1, to: 3 }),
      ]) {
        const error = await refusal(run());
        expect(error.code).toBe('VIEW_UNTRUSTED');
      }

      expect((await previewTable(access(lake), ok)).rows).toEqual([[42]]);
    } finally {
      await lake.remove();
    }
  });

  it('decides from the snapshot read: a name that is a table now but a view at an older snapshot is gated there', async () => {
    const lake = await createLake([
      'CREATE VIEW orders AS SELECT 7 AS a', // @1: orders is a view
      'DROP VIEW orders', // @2
      'CREATE TABLE orders (a INTEGER)', // @3: orders is a table
      'INSERT INTO orders VALUES (3)', // @4
    ]);
    try {
      const orders = { schema: 'main', table: 'orders' };
      // At the latest snapshot orders is a table: no trust needed, it reads.
      expect((await previewTable(untrusted(lake), orders)).rows).toEqual([[3]]);
      // At @1 the same name is a view: the guard gates it from what is read, not from the newest kind.
      expect((await refusal(previewTable({ ...untrusted(lake), snapshot: 1 }, orders))).code).toBe(
        'VIEW_UNTRUSTED',
      );
      expect((await previewTable({ ...access(lake), snapshot: 1 }, orders)).rows).toEqual([[7]]);
    } finally {
      await lake.remove();
    }
  });
});

const backends = await lakeBackends();

describe.each(backends)('the view guard on a lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
    it('refuses a view that cleans up files, leaves them in place, and previews a view that reads', async () => {
      const lake = await backend.create();
      try {
        const run = async (sql: string): Promise<void> => void (await lake.connection.run(sql));
        await run('CREATE TABLE gone (a INTEGER)');
        await run('INSERT INTO gone VALUES (1)');
        await run('INSERT INTO gone VALUES (2)');
        await run('DROP TABLE gone');
        await run("CALL ducklake_expire_snapshots('lake', older_than => now() + INTERVAL 1 DAY)");
        await run('CREATE TABLE live (b INTEGER)');
        await run('INSERT INTO live VALUES (10)');
        await run(
          "CREATE VIEW evil AS SELECT * FROM ducklake_cleanup_old_files('lake', cleanup_all => true)",
        );
        await run('CREATE VIEW fine AS SELECT b FROM live');
        const before = (await readdir(lake.dataDirectory, { recursive: true })).length;
        const access = {
          profile: lake.profile,
          ...(lake.password === undefined ? {} : { password: lake.password }),
          s3: {},
          extensionDirectory,
          viewsTrusted: true,
        };

        const error = await refusal(previewTable(access, { schema: 'main', table: 'evil' }));

        expect(error.userMessage).toMatch(
          /^The view "main\.evil" is not run: its SQL calls "ducklake_cleanup_old_files"/,
        );
        expect((await readdir(lake.dataDirectory, { recursive: true })).length).toBe(before);
        expect((await previewTable(access, { schema: 'main', table: 'fine' })).rows).toEqual([[10]]);
      } finally {
        await lake.remove();
      }
    });
  });
});
