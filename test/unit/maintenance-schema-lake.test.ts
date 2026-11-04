import { describe, expect, it } from 'vitest';
import { maintenanceScript } from '../../src/maintenance';
import type { MaintenanceKind } from '../../src/maintenance';
import { CatalogTree } from '../../src/tree/model';
import type { NodeRef } from '../../src/tree/refs';
import { opened } from '../support/opened';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const backends = await lakeBackends();

// The schemas `s` (tables t and u) and `o` (tables v and w) are built alike: three files per table, a row of the first
// file of t and v deleted again. A script of `s` must change `s` and leave `o` as it was.
const SCHEMAS = [
  { name: 's', tables: ['t', 'u'] },
  { name: 'o', tables: ['v', 'w'] },
] as const;

/** `-- CALL ...` lines of an option template as statements; the `<column>` of skip_stats_columns is a placeholder. */
const uncommented = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.startsWith('-- CALL '))
    .map((line) => line.slice(3))
    .join('\n');

describe.each(backends)(
  'maintenance scripts of a schema, run by a real DuckLake with $name metadata',
  (backend) => {
    describe.skipIf(backend.skipReason !== undefined)('a lake with two schemas', () => {
      const run = async (lake: BackendLake, sql: string): Promise<void> =>
        void (await lake.connection.run(sql));
      const rows = async (lake: BackendLake, sql: string): Promise<unknown[][]> =>
        (await lake.connection.runAndReadAll(sql)).getRowsJson();
      const files = async (
        lake: BackendLake,
        table: string,
        kind: 'data' | 'delete' = 'data',
      ): Promise<number> =>
        Number(
          (
            await rows(
              lake,
              `SELECT count(*) FROM __ducklake_metadata_lake.ducklake_${kind}_file f
               JOIN __ducklake_metadata_lake.ducklake_table t USING (table_id)
              WHERE t.table_name = '${table}' AND f.end_snapshot IS NULL AND t.end_snapshot IS NULL`,
            )
          )[0]?.[0],
        );
      const filesOf = async (
        lake: BackendLake,
        kind: 'data' | 'delete' = 'data',
      ): Promise<Record<string, number>> =>
        Object.fromEntries(
          await Promise.all(
            SCHEMAS.flatMap(({ tables }) => tables).map(async (table): Promise<[string, number]> => [
              table,
              await files(lake, table, kind),
            ]),
          ),
        );

      async function lakeWith(...extra: string[]): Promise<BackendLake> {
        const lake = await backend.create();
        try {
          for (const { name, tables } of SCHEMAS) {
            await run(lake, `CREATE SCHEMA ${name}`);
            for (const table of tables) {
              await run(lake, `CREATE TABLE ${name}.${table} (a INTEGER)`);
              await run(lake, `INSERT INTO ${name}.${table} VALUES (1), (2)`);
              await run(lake, `INSERT INTO ${name}.${table} VALUES (3)`);
              await run(lake, `INSERT INTO ${name}.${table} VALUES (4)`);
            }
          }
          await run(lake, 'DELETE FROM s.t WHERE a = 2');
          await run(lake, 'DELETE FROM o.v WHERE a = 2');
          for (const sql of extra) await run(lake, sql);
          return lake;
        } catch (error) {
          await lake.remove();
          throw error;
        }
      }

      /** The script of a Maintenance entry for the schema node `s`, made the way the command makes it. */
      async function scriptOf(lake: BackendLake, kind: MaintenanceKind): Promise<string> {
        const tree = new CatalogTree({
          profiles: () => [{ id: 'l', name: 'Lake', kind: 'sqlite', path: 'unused' }],
          open: () => opened(lake.reader()),
        });
        try {
          await tree.connect('l');
          const root = tree.roots()[0];
          const node = (await tree.children(root as never)).find((child) => child.label === 's');
          return (await maintenanceScript(tree, kind, node?.ref as NodeRef)) ?? '';
        } finally {
          await tree.dispose();
        }
      }

      it('merges the tables of the schema and leaves the other schema alone', async () => {
        const lake = await lakeWith();
        try {
          expect(await filesOf(lake)).toEqual({ t: 3, u: 3, v: 3, w: 3 });

          await run(lake, await scriptOf(lake, 'merge'));

          // The file of t that has a delete file stays apart, as it does for the script of one table.
          expect(await filesOf(lake)).toEqual({ t: 2, u: 1, v: 3, w: 3 });
          expect(await rows(lake, 'SELECT a FROM s.u ORDER BY a')).toEqual([[1], [2], [3], [4]]);
        } finally {
          await lake.remove();
        }
      });

      it('rewrites the data files of the tables of the schema and leaves the other schema alone', async () => {
        const lake = await lakeWith(
          "CALL lake.set_option('rewrite_delete_threshold', '0.1')",
          'DELETE FROM s.u WHERE a = 1',
          'DELETE FROM o.w WHERE a = 1',
        );
        try {
          expect(await filesOf(lake, 'delete')).toEqual({ t: 1, u: 1, v: 1, w: 1 });

          await run(lake, await scriptOf(lake, 'rewrite'));

          expect(await filesOf(lake, 'delete')).toEqual({ t: 0, u: 0, v: 1, w: 1 });
          expect(await rows(lake, 'SELECT a FROM s.u ORDER BY a')).toEqual([[2], [3], [4]]);
        } finally {
          await lake.remove();
        }
      });

      it('flushes the inlined rows of the schema and leaves the other schema inlined', async () => {
        const lake = await lakeWith(
          "CALL lake.set_option('data_inlining_row_limit', 10)",
          'CREATE TABLE s.i (a INTEGER)',
          'INSERT INTO s.i VALUES (1)',
          'CREATE TABLE o.j (a INTEGER)',
          'INSERT INTO o.j VALUES (1)',
        );
        try {
          expect([await files(lake, 'i'), await files(lake, 'j')]).toEqual([0, 0]);

          await run(lake, await scriptOf(lake, 'flush'));

          expect([await files(lake, 'i'), await files(lake, 'j')]).toEqual([1, 0]);
          expect(await rows(lake, 'SELECT a FROM s.i')).toEqual([[1]]);
        } finally {
          await lake.remove();
        }
      });

      it('sets nothing as it stands, and every option of the schema scope for the schema alone once uncommented', async () => {
        const lake = await lakeWith();
        const options = async (): Promise<string[][]> =>
          (await rows(
            lake,
            "SELECT option_name, scope, coalesce(scope_entry, '') FROM lake.options() WHERE option_name NOT IN ('created_by', 'data_path', 'encrypted', 'version') ORDER BY 1, 2",
          )) as string[][];
        try {
          const script = await scriptOf(lake, 'option');
          await run(lake, script);
          expect(await options()).toEqual([]);

          await run(lake, uncommented(script));

          const set = await options();
          expect(set.length).toBeGreaterThanOrEqual(10);
          expect(set.every(([, scope, entry]) => scope === 'SCHEMA' && entry === 's')).toBe(true);
          const names = set.map(([name]) => name);
          expect(names).toContain('auto_compact');
          expect(names).toContain('target_file_size');
          for (const global of [
            'expire_older_than',
            'delete_older_than',
            'require_commit_message',
            'skip_stats_columns',
          ]) {
            expect(names).not.toContain(global);
          }
        } finally {
          await lake.remove();
        }
      });
    });
  },
);
