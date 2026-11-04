import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { DuckDBInstance } from '@duckdb/node-api';
import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import { createCatalogReader } from '../../src/catalog/reader';
import { maintenanceOf } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import { CatalogTree } from '../../src/tree/model';
import type { NodeRef } from '../../src/tree/refs';
import { wasmPath } from '../support/fixtures';
import { opened } from '../support/opened';
import { copyDataFixture, extensionDirectory } from './data-support';
import { lakeBackends } from './lake-backends';
import type { Backend, BackendLake } from './lake-backends';

const backends = await lakeBackends();

const LAKE_KINDS: readonly MaintenanceKind[] = [
  'checkpoint',
  'merge',
  'rewrite',
  'flush',
  'expire',
  'cleanup',
  'orphans',
  'option',
];
const TABLE_KINDS: readonly MaintenanceKind[] = ['merge', 'rewrite', 'flush', 'option'];

/** Removes the comment marks from the commented `CALL` statements of a script, also those that a line break in a name spreads over several lines. */
function uncommentCalls(text: string): string {
  const lines = text.split('\n');
  let inCall = false;
  return lines
    .map((line) => {
      if (/^-- CALL /.test(line)) {
        inCall = true;
      }
      const out = inCall ? line.replace(/^-- /, '') : line;
      if (inCall && line.endsWith(');')) {
        inCall = false;
      }
      return out;
    })
    .join('\n');
}

/** The calls of a destructive script: the dry run that is active, and the real call that is commented out under it (Clean Up Old Files has a third, with cleanup_all). */
function dryRunAndRealCall(text: string): { dryRun: string; real: string } {
  const calls = [...uncommentCalls(text).matchAll(/^CALL [\s\S]*?\);$/gm)].map((match) => match[0]);
  const [dryRun, real, ...others] = calls;
  expect(others.length).toBeLessThanOrEqual(1);
  expect(dryRun).toContain('dry_run => true');
  expect(real).not.toContain('dry_run');
  // Only the dry run is active.
  expect(text).toContain(`\n${dryRun}\n-- `);
  return { dryRun: dryRun ?? '', real: real ?? '' };
}

/** The helpers that write to a real lake of one backend and produce the maintenance scripts of its tree. */
function harness(backend: Backend) {
  const run = async (lake: BackendLake, sql: string): Promise<void> => void (await lake.connection.run(sql));
  const rows = async (lake: BackendLake, sql: string): Promise<unknown[][]> =>
    (await lake.connection.runAndReadAll(sql)).getRowsJson();
  const count = async (lake: BackendLake, sql: string): Promise<number> =>
    Number((await rows(lake, sql))[0]?.[0]);

  const activeFiles = (lake: BackendLake, table: string, kind: 'data' | 'delete' = 'data'): Promise<number> =>
    count(
      lake,
      `SELECT count(*) FROM __ducklake_metadata_lake.ducklake_${kind}_file f
           JOIN __ducklake_metadata_lake.ducklake_table t USING (table_id)
          WHERE t.table_name = '${table.replaceAll("'", "''")}' AND f.end_snapshot IS NULL AND t.end_snapshot IS NULL`,
    );
  const snapshots = (lake: BackendLake): Promise<number> =>
    count(lake, 'SELECT count(*) FROM lake.snapshots()');

  /** A lake with schema `s`, the tables `t` and `u` of three files each (a row of the first file of `t` deleted again) and the given extras. */
  async function lakeWith(...extra: string[]): Promise<BackendLake> {
    const lake = await backend.create();
    try {
      for (const sql of [
        'CREATE SCHEMA s',
        ...['t', 'u'].flatMap((table) => [
          `CREATE TABLE s.${table} (a INTEGER)`,
          `INSERT INTO s.${table} VALUES (1), (2)`,
          `INSERT INTO s.${table} VALUES (3)`,
          `INSERT INTO s.${table} VALUES (4)`,
        ]),
        'DELETE FROM s.t WHERE a = 2',
        ...extra,
      ]) {
        await run(lake, sql);
      }
      return lake;
    } catch (error) {
      await lake.remove();
      throw error;
    }
  }

  /** The scripts for the nodes of the lake as the explorer shows them, produced the way the commands produce them. */
  async function scriptsOf(lake: BackendLake) {
    const tree = new CatalogTree({
      profiles: () => [{ id: 'l', name: 'Lake', kind: 'sqlite', path: 'unused' }],
      open: () => opened(lake.reader()),
    });
    try {
      await tree.connect('l');
      const connection = tree.roots()[0]?.ref as NodeRef;
      const tableRefs = new Map<string, NodeRef>();
      for (const schema of await tree.children(tree.roots()[0] as never)) {
        const tables = (await tree.children(schema)).find((node) => node.label === 'Tables');
        for (const table of tables ? await tree.children(tables) : []) {
          tableRefs.set(`${schema.label}.${table.label}`, table.ref);
        }
      }
      return {
        lake: (kind: MaintenanceKind): string => maintenanceOf(tree, kind, connection) ?? '',
        table: (name: string, kind: MaintenanceKind): string => {
          const ref = tableRefs.get(name);
          if (!ref) {
            throw new Error(`No table ${name} among ${[...tableRefs.keys()].join(', ')}`);
          }
          return maintenanceOf(tree, kind, ref) ?? '';
        },
      };
    } finally {
      await tree.dispose();
    }
  }

  return { run, rows, activeFiles, snapshots, lakeWith, scriptsOf };
}

describe.each(backends)('maintenance scripts, run by a real DuckLake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
    const { run, rows, activeFiles, snapshots, lakeWith, scriptsOf } = harness(backend);

    it('merges, rewrites and flushes for the lake and for one table, and nothing else; Checkpoint merges the small files', async () => {
      const merged = await lakeWith();
      try {
        const scripts = await scriptsOf(merged);
        expect([await activeFiles(merged, 't'), await activeFiles(merged, 'u')]).toEqual([3, 3]);

        await run(merged, scripts.table('s.t', 'merge'));
        expect([await activeFiles(merged, 't'), await activeFiles(merged, 'u')]).toEqual([2, 3]);
        expect(await rows(merged, 'SELECT a FROM s.t ORDER BY a')).toEqual([[1], [3], [4]]);

        await run(merged, scripts.lake('merge'));
        expect([await activeFiles(merged, 't'), await activeFiles(merged, 'u')]).toEqual([2, 1]);
        expect(await rows(merged, 'SELECT a FROM s.u ORDER BY a')).toEqual([[1], [2], [3], [4]]);
      } finally {
        await merged.remove();
      }

      const checkpointed = await lakeWith();
      try {
        await run(checkpointed, (await scriptsOf(checkpointed)).lake('checkpoint'));
        expect([await activeFiles(checkpointed, 't'), await activeFiles(checkpointed, 'u')]).toEqual([2, 1]);
        expect(await rows(checkpointed, 'SELECT a FROM s.t ORDER BY a')).toEqual([[1], [3], [4]]);
      } finally {
        await checkpointed.remove();
      }

      const rewritten = await lakeWith(
        "CALL lake.set_option('rewrite_delete_threshold', '0.1')",
        'DELETE FROM s.u WHERE a = 1',
      );
      try {
        const scripts = await scriptsOf(rewritten);
        const deletes = async () => [
          await activeFiles(rewritten, 't', 'delete'),
          await activeFiles(rewritten, 'u', 'delete'),
        ];
        expect(await deletes()).toEqual([1, 1]);
        await run(rewritten, scripts.table('s.t', 'rewrite'));
        expect(await deletes()).toEqual([0, 1]);
        await run(rewritten, scripts.lake('rewrite'));
        expect(await activeFiles(rewritten, 'u', 'delete')).toBe(0);
        expect(await rows(rewritten, 'SELECT a FROM s.u ORDER BY a')).toEqual([[2], [3], [4]]);
      } finally {
        await rewritten.remove();
      }

      const inlined = await lakeWith(
        "CALL lake.set_option('data_inlining_row_limit', 10)",
        'CREATE TABLE s.i1 (a INTEGER)',
        'INSERT INTO s.i1 VALUES (1)',
        'CREATE TABLE s.i2 (a INTEGER)',
        'INSERT INTO s.i2 VALUES (1)',
      );
      try {
        const scripts = await scriptsOf(inlined);
        expect([await activeFiles(inlined, 'i1'), await activeFiles(inlined, 'i2')]).toEqual([0, 0]);
        await run(inlined, scripts.table('s.i1', 'flush'));
        expect([await activeFiles(inlined, 'i1'), await activeFiles(inlined, 'i2')]).toEqual([1, 0]);
        await run(inlined, scripts.lake('flush'));
        expect([await activeFiles(inlined, 'i1'), await activeFiles(inlined, 'i2')]).toEqual([1, 1]);
        expect(await rows(inlined, 'SELECT a FROM s.i2')).toEqual([[1]]);
      } finally {
        await inlined.remove();
      }
    });

    it('lets the dry runs of Expire, Clean Up and Delete Orphans only report, and the commented calls expire, delete and delete', async () => {
      const lake = await lakeWith();
      try {
        const scripts = await scriptsOf(lake);
        const expire = scripts.lake('expire').replaceAll('INTERVAL 30 DAY', 'INTERVAL 0 DAY');
        const before = await snapshots(lake);
        expect(before).toBeGreaterThan(5);

        // The script as it is only reports.
        expect((await rows(lake, expire)).length).toBe(before - 1);
        expect(await snapshots(lake)).toBe(before);

        // After a merge and an expiry the old files wait for deletion.
        await run(lake, scripts.lake('merge'));
        await run(lake, dryRunAndRealCall(expire).real);
        expect(await snapshots(lake)).toBe(1);

        await run(lake, "CALL lake.set_option('delete_older_than', '0 seconds')");
        const cleanup = scripts.lake('cleanup');
        const onDisk = (): string[] =>
          readdirSync(`${lake.dataDirectory}/s`, { recursive: true, encoding: 'utf8' })
            .filter((name) => name.endsWith('.parquet'))
            .map((name) => `${lake.dataDirectory}/s/${name.replaceAll('\\', '/')}`)
            .sort();
        const files = onDisk();

        const listed = (await rows(lake, cleanup)).map(([path]) => String(path).replaceAll('\\', '/')).sort();
        expect(listed.length).toBeGreaterThan(0);
        expect(listed.every((path) => files.includes(path))).toBe(true);
        expect(onDisk()).toEqual(files);

        await run(lake, dryRunAndRealCall(cleanup).real);
        expect(onDisk()).toEqual(files.filter((path) => !listed.includes(path)));
        // The files that the newest snapshot needs are still there.
        expect(await rows(lake, 'SELECT a FROM s.t ORDER BY a')).toEqual([[1], [3], [4]]);

        // A file that the catalog does not know is listed, and deleted by the commented call only.
        const directory = `${lake.dataDirectory}/s/t`;
        mkdirSync(directory, { recursive: true });
        const orphan = `${directory}/orphan.parquet`;
        writeFileSync(orphan, 'not in the catalog');
        const orphans = scripts.lake('orphans');
        expect((await rows(lake, orphans)).map(([path]) => String(path).replaceAll('\\', '/'))).toEqual([
          orphan.replaceAll('\\', '/'),
        ]);
        expect(existsSync(orphan)).toBe(true);
        await run(lake, dryRunAndRealCall(orphans).real);
        expect(existsSync(orphan)).toBe(false);
        expect(await rows(lake, 'SELECT a FROM s.u ORDER BY a')).toEqual([[1], [2], [3], [4]]);
      } finally {
        await lake.remove();
      }
    });

    describe('the destructive scripts as they are generated (a dry run, and a real call that spares what is younger than the age)', () => {
      const scheduled = async (lake: BackendLake): Promise<number> =>
        Number(
          (
            await rows(
              lake,
              'SELECT count(*) FROM __ducklake_metadata_lake.ducklake_files_scheduled_for_deletion',
            )
          )[0]?.[0],
        );
      const parquet = (lake: BackendLake): number =>
        readdirSync(`${lake.dataDirectory}/s`, { recursive: true, encoding: 'utf8' }).filter((name) =>
          name.endsWith('.parquet'),
        ).length;

      it('Clean Up Old Files changes nothing for files scheduled today, with the dry run and with the real call; cleanup_all deletes them', async () => {
        const lake = await lakeWith();
        try {
          const scripts = await scriptsOf(lake);
          await run(lake, scripts.lake('merge'));
          const waiting = await scheduled(lake);
          const files = parquet(lake);
          expect(waiting).toBeGreaterThan(0);

          // What the explorer shows as "scheduled for deletion" is the count before and after the script as it is.
          const cleanup = scripts.lake('cleanup');
          expect(await rows(lake, cleanup)).toEqual([]);
          await run(lake, dryRunAndRealCall(cleanup).real);
          expect([await scheduled(lake), parquet(lake)]).toEqual([waiting, files]);

          // A dry run with the age of now lists exactly what is scheduled, and still deletes nothing.
          expect(
            (
              await rows(
                lake,
                "CALL ducklake_cleanup_old_files('lake', older_than => now(), dry_run => true)",
              )
            ).length,
          ).toBe(waiting);
          expect([await scheduled(lake), parquet(lake)]).toEqual([waiting, files]);

          // cleanup_all ignores the age: the scheduled files are deleted and the rows of the list are gone.
          await run(lake, uncommentCalls(cleanup).match(/^CALL .*cleanup_all => true\);$/m)?.[0] ?? '');
          expect(await scheduled(lake)).toBe(0);
          expect(parquet(lake)).toBe(files - waiting);
          expect(await rows(lake, 'SELECT a FROM s.t ORDER BY a')).toEqual([[1], [3], [4]]);
        } finally {
          await lake.remove();
        }
      });

      it('Expire Snapshots as generated expires nothing of a young lake and so schedules no file', async () => {
        const lake = await lakeWith();
        try {
          const scripts = await scriptsOf(lake);
          await run(lake, scripts.lake('merge'));
          const before = [await snapshots(lake), await scheduled(lake)];
          await run(lake, dryRunAndRealCall(scripts.lake('expire')).real);
          expect([await snapshots(lake), await scheduled(lake)]).toEqual(before);
        } finally {
          await lake.remove();
        }
      });
    });
  });
});

// The options and the names of a table live in the catalog tables alone, the same for every backend: one backend runs them.
const [first] = backends;
const optionsBackend = first as Backend;

describe.skipIf(optionsBackend.skipReason !== undefined)(
  'the option and name scripts, run by a real DuckLake',
  () => {
    const { run, rows, activeFiles, scriptsOf } = harness(optionsBackend);

    it('keeps the names of a hostile schema and table inside string literals: the scripts act on that table only and every statement of them runs', async () => {
      const schema = `we'ird "s"`;
      const table = `x'; DROP TABLE victim; --\ny"z`;
      const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
      const lake = await optionsBackend.create();
      try {
        for (const sql of [
          'CREATE TABLE victim (a INTEGER)',
          `CREATE SCHEMA ${q(schema)}`,
          `CREATE TABLE ${q(schema)}.${q(table)} (a INTEGER)`,
          `INSERT INTO ${q(schema)}.${q(table)} VALUES (1)`,
          `INSERT INTO ${q(schema)}.${q(table)} VALUES (2)`,
          `INSERT INTO ${q(schema)}.${q(table)} VALUES (3)`,
        ]) {
          await run(lake, sql);
        }
        const scripts = await scriptsOf(lake);
        const key = `${schema}.${table}`;

        for (const kind of TABLE_KINDS) {
          const script = scripts.table(key, kind);
          // The raw name is nowhere in the script, in a comment or outside; the literal has its quotes doubled.
          expect(script, kind).not.toContain(table);
          expect(uncommentCalls(script), kind).toContain(`'${table.replaceAll("'", "''")}'`);
          await run(lake, uncommentCalls(script).replaceAll('<column>', 'a'));
        }
        expect(await activeFiles(lake, table)).toBe(1);
        expect(await rows(lake, `SELECT a FROM ${q(schema)}.${q(table)} ORDER BY a`)).toEqual([
          [1],
          [2],
          [3],
        ]);
        expect(await rows(lake, 'SELECT count(*) FROM victim')).toEqual([['0']]);
        // Every option of the table landed on that one table.
        expect(
          await rows(lake, "SELECT count(DISTINCT scope_entry) FROM lake.options() WHERE scope = 'TABLE'"),
        ).toEqual([['1']]);
      } finally {
        await lake.remove();
      }
    });
  },
);

describe('every script, against a copy of the data fixture', async () => {
  const { engineSkipReason } = await import('./data-support');
  const skipReason = await engineSkipReason();

  it.skipIf(skipReason !== undefined)(
    'runs on the fixture lake with its Parquet files, and changes nothing but the files that it merges',
    async () => {
      const fixture = await copyDataFixture('sqlite');
      const instance = await DuckDBInstance.create(':memory:', { extension_directory: extensionDirectory });
      const connection = await instance.connect();
      try {
        const reader = createCatalogReader(await openSqlite({ path: fixture.profile.path, wasmPath }));
        const tree = new CatalogTree({
          profiles: () => [{ ...fixture.profile, id: 'l' }],
          open: () => opened(reader),
        });
        await tree.connect('l');
        const root = tree.roots()[0] as never;
        const sales = (await tree.children(root)).find((node) => node.label === 'sales') as never;
        const tables = (await tree.children(sales)).find((node) => node.label === 'Tables') as never;
        const orders = (await tree.children(tables)).find((node) => node.label === 'orders');

        for (const sql of [
          'LOAD ducklake',
          'LOAD sqlite',
          `ATTACH 'ducklake:sqlite:${fixture.profile.path.replaceAll('\\', '/')}' AS lake`,
          'USE lake',
        ]) {
          await connection.run(sql);
        }
        const orderRows = async (): Promise<unknown[][]> =>
          (await connection.runAndReadAll('SELECT id FROM sales.orders ORDER BY id')).getRowsJson();
        expect(await orderRows()).toEqual([[1], [3]]);

        const connectionRef = tree.roots()[0]?.ref as NodeRef;
        for (const kind of LAKE_KINDS) {
          await connection.run(maintenanceOf(tree, kind, connectionRef) ?? '');
        }
        for (const kind of TABLE_KINDS) {
          await connection.run(maintenanceOf(tree, kind, orders?.ref as NodeRef) ?? '');
        }
        expect(await orderRows()).toEqual([[1], [3]]);
        await tree.dispose();
      } finally {
        connection.closeSync();
        instance.closeSync();
        await fixture.remove();
      }
    },
  );
});
