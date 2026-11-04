import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogReader, MacroInfo } from '../../src/catalog/model';
import { scriptOf } from '../../src/script-templates';
import { CatalogTree } from '../../src/tree/model';
import type { TreeNode } from '../../src/tree/refs';
import { opened } from '../support/opened';
import { createWithDrop } from '../support/scripts';
import { lakeBackends } from './lake-backends';
import type { BackendLake } from './lake-backends';

const createOf = (tree: Parameters<typeof scriptOf>[1], ref: Parameters<typeof scriptOf>[2]) =>
  scriptOf('create', tree, ref);
const alterOf = (tree: Parameters<typeof scriptOf>[1], ref: Parameters<typeof scriptOf>[2]) =>
  scriptOf('alter', tree, ref);
// The drop scripts of a table, a view and a macro are made without waiting.
const dropOf = (tree: Parameters<typeof scriptOf>[1], ref: Parameters<typeof scriptOf>[2]) =>
  scriptOf('drop', tree, ref) as string | undefined;

/** The macros of a schema as the explorer should name them: kind, name and the number of overloads. */
const names = (macros: readonly MacroInfo[]): string[] =>
  macros.map(({ kind, name, implementations }) => `${kind} ${name}/${implementations.length}`);

/** What a macro is, without the ids that a lake of its own would number differently. */
const definition = ({ name, kind, implementations }: MacroInfo) => ({ name, kind, implementations });

/** Every kind of default that DuckLake stores, with its type: the rows of `ducklake_macro_parameters`. */
const DEFAULTS_MACRO = `CREATE MACRO s.defaults(
  i := 1, d := 1.5, dd := 1.190::DECIMAL(9,3), f := 1.5e0, b := TRUE, ts := TIMESTAMP '2020-01-01 10:00:00',
  tz := TIMESTAMPTZ '2020-01-01 10:00:00+00', t := TIME '10:00:00', dt := DATE '2020-01-01',
  iv := INTERVAL 1 DAY, txt := 'it''s', big := 3000000000, neg := -5, neg_d := -1.5, huge := 12345678901234567890123,
  small := 1::SMALLINT, u := 1::UBIGINT, blob := BLOB 'abc', nul := NULL, st := {'a': 1}, nan := 'nan'::DOUBLE
) AS i`;

/** A macro whose names try to end their identifiers: the statement must keep them inside the quotes. */
const HOSTILE_MACRO = `CREATE MACRO s."we""ird name; DROP SCHEMA s; --"("a b", "c""d" := 1) AS "a b" + "c""d"`;

const TYPED_MACRO = `CREATE MACRO s.typed(
  a INTEGER, b INTEGER[], c STRUCT(x INTEGER, y VARCHAR), d DECIMAL(9,3), e TIMESTAMP WITH TIME ZONE,
  g UBIGINT, h MAP(VARCHAR, INTEGER), m TINYINT, n SMALLINT, k INTEGER := 5
) AS a`;

/** Macros with no parameter at all, alone and next to an overload that has some, in both orders. */
const PARAMETERLESS = [
  'CREATE MACRO s.zero() AS 42',
  'CREATE MACRO s.mixed(x) AS x, () AS 0',
  'CREATE MACRO s.mixed2() AS 0, (x, y) AS x + y',
];

/** The history of the lake, one statement per snapshot. */
const STEPS: readonly (readonly [sql: string, main: string[], s: string[]])[] = [
  ['CREATE SCHEMA s', [], []],
  ['CREATE MACRO m1(x) AS x + 1', ['scalar m1/1'], []],
  ['CREATE MACRO s.f(x) AS x + 1, (x, y) AS x + y', ['scalar m1/1'], ['scalar f/2']],
  [
    'CREATE MACRO s.t(n := 10) AS TABLE SELECT 42 AS answer FROM range(n)',
    ['scalar m1/1'],
    ['scalar f/2', 'table t/1'],
  ],
  [
    'CREATE MACRO s.tm(n) AS TABLE (SELECT n AS v), (n, m) AS TABLE (SELECT n + m AS v)',
    ['scalar m1/1'],
    ['scalar f/2', 'table t/1', 'table tm/2'],
  ],
  [
    'CREATE MACRO s.same(a) AS a',
    ['scalar m1/1'],
    ['scalar f/2', 'scalar same/1', 'table t/1', 'table tm/2'],
  ],
  [
    'CREATE MACRO s.same(a) AS TABLE SELECT a AS v',
    ['scalar m1/1'],
    ['scalar f/2', 'scalar same/1', 'table same/1', 'table t/1', 'table tm/2'],
  ],
  [
    'CREATE MACRO s.gone(x) AS x',
    ['scalar m1/1'],
    ['scalar f/2', 'scalar gone/1', 'scalar same/1', 'table same/1', 'table t/1', 'table tm/2'],
  ],
  [
    'DROP MACRO s.gone',
    ['scalar m1/1'],
    ['scalar f/2', 'scalar same/1', 'table same/1', 'table t/1', 'table tm/2'],
  ],
  [
    // DuckLake writes a replaced macro as a new one, and the replacement has one overload only.
    'CREATE OR REPLACE MACRO s.f(x) AS x + 100',
    ['scalar m1/1'],
    ['scalar f/1', 'scalar same/1', 'table same/1', 'table t/1', 'table tm/2'],
  ],
];

const backends = await lakeBackends();

for (const backend of backends) {
  describe.skipIf(backend.skipReason !== undefined)(
    `macros in a DuckLake with ${backend.name} metadata`,
    () => {
      let lake: BackendLake;
      let snapshots: number[];
      /** The snapshot after the last statement of the setup, which also created the macros with the many defaults and types. */
      let latest: number;

      const run = async (target: BackendLake, sql: string): Promise<void> =>
        void (await target.connection.run(sql));
      const rows = async (target: BackendLake, sql: string): Promise<unknown[][]> =>
        (await target.connection.runAndReadAll(sql)).getRowsJson();

      const treeOf = (source: BackendLake): CatalogTree =>
        new CatalogTree({
          profiles: () => [{ id: 'l', name: 'Lake', kind: 'sqlite', path: 'unused' }],
          open: () => opened(source.reader()),
        });

      async function nodeAt(tree: CatalogTree, ...labels: string[]): Promise<TreeNode> {
        let node = tree.roots()[0];
        for (const label of labels) {
          const child = node && (await tree.children(node)).find((candidate) => candidate.label === label);
          if (!child) {
            throw new Error(`No node "${label}" under "${node?.label}"`);
          }
          node = child;
        }
        if (!node) {
          throw new Error('The tree has no connection');
        }
        return node;
      }

      async function schemaId(reader: CatalogReader, snapshot: number, name: string): Promise<number> {
        const found = (await reader.schemas(snapshot)).find((schema) => schema.name === name);
        if (!found) {
          throw new Error(`No schema ${name} at @${snapshot}`);
        }
        return found.id;
      }

      /** A second empty lake that receives the statements that the scripts wrote for the first one. */
      async function copyOf(script: (tree: CatalogTree) => Promise<string[]>): Promise<BackendLake> {
        const tree = treeOf(lake);
        const target = await backend.create();
        try {
          await tree.connect('l');
          await run(target, 'CREATE SCHEMA s');
          for (const statement of await script(tree)) {
            await run(target, statement);
          }
          return target;
        } catch (error) {
          await target.remove();
          throw error;
        } finally {
          await tree.dispose();
        }
      }

      beforeAll(async () => {
        lake = await backend.create();
        snapshots = [];
        for (const [sql] of STEPS) {
          await run(lake, sql);
          snapshots.push(Number((await rows(lake, 'SELECT max(snapshot_id) FROM lake.snapshots()'))[0]?.[0]));
        }
        await run(lake, DEFAULTS_MACRO);
        await run(lake, TYPED_MACRO);
        for (const sql of PARAMETERLESS) {
          await run(lake, sql);
        }
        await run(lake, HOSTILE_MACRO);
        latest = Number((await rows(lake, 'SELECT max(snapshot_id) FROM lake.snapshots()'))[0]?.[0]);
      });
      afterAll(async () => {
        await lake.remove();
      });

      it('shows the macros of every snapshot, with overloads, defaults and types as DuckDB stored them, in the reader and in the tree', async () => {
        const reader = await lake.reader();
        try {
          for (const [index, [sql, main, s]] of STEPS.entries()) {
            const snapshot = snapshots[index] ?? -1;
            expect(
              [
                names(await reader.macros(await schemaId(reader, snapshot, 'main'), snapshot)),
                names(
                  index === 0 ? [] : await reader.macros(await schemaId(reader, snapshot, 's'), snapshot),
                ),
              ],
              `after ${sql}`,
            ).toEqual([main, index === 0 ? [] : s]);
          }

          // The overloads in the order DuckDB stored them, each with its parameters and its body.
          const last = snapshots[STEPS.length - 1] ?? -1;
          const macros = await reader.macros(await schemaId(reader, last, 's'), last);
          const byName = (kind: string, name: string) =>
            macros.find((m) => m.kind === kind && m.name === name);
          expect(byName('scalar', 'f')?.implementations).toEqual([
            {
              dialect: 'duckdb',
              parameters: [{ name: 'x', type: null, defaultValue: null }],
              sql: '(x + 100)',
            },
          ]);
          expect(byName('table', 'tm')?.implementations).toEqual([
            {
              dialect: 'duckdb',
              parameters: [{ name: 'n', type: null, defaultValue: null }],
              sql: 'SELECT n AS v',
            },
            {
              dialect: 'duckdb',
              parameters: [
                { name: 'n', type: null, defaultValue: null },
                { name: 'm', type: null, defaultValue: null },
              ],
              sql: 'SELECT (n + m) AS v',
            },
          ]);
          expect(byName('table', 't')?.implementations).toEqual([
            {
              dialect: 'duckdb',
              parameters: [{ name: 'n', type: null, defaultValue: '10' }],
              sql: 'SELECT 42 AS answer FROM "range"(n)',
            },
          ]);
        } finally {
          await reader.close();
        }

        // Defaults as SQL expressions that give back their value and type; declared types as DuckDB names them.
        const reader2 = await lake.reader();
        try {
          const macros = await reader2.macros(await schemaId(reader2, latest, 's'), latest);
          const parameters = (name: string) =>
            Object.fromEntries(
              (macros.find((macro) => macro.name === name)?.implementations[0]?.parameters ?? []).map(
                ({ name: parameter, type, defaultValue }) => [parameter, [type, defaultValue]],
              ),
            );
          const { iv, st, ...defaults } = parameters('defaults');
          expect(defaults).toEqual({
            i: [null, '1'],
            d: [null, '1.5'],
            dd: [null, "CAST('1.190' AS DECIMAL(9,3))"],
            f: [null, "CAST('1.5' AS DOUBLE)"],
            b: [null, 'true'],
            ts: [null, "CAST('2020-01-01 10:00:00' AS TIMESTAMP)"],
            tz: [null, "CAST('2020-01-01 10:00:00+00' AS TIMESTAMP WITH TIME ZONE)"],
            t: [null, "CAST('10:00:00' AS TIME)"],
            dt: [null, "CAST('2020-01-01' AS DATE)"],
            txt: [null, "'it''s'"],
            big: [null, "CAST('3000000000' AS BIGINT)"],
            neg: [null, '-5'],
            neg_d: [null, '-1.5'],
            huge: [null, "CAST('12345678901234567890123' AS HUGEINT)"],
            small: [null, "CAST('1' AS SMALLINT)"],
            u: [null, "CAST('1' AS UBIGINT)"],
            blob: [null, "CAST('abc' AS BLOB)"],
            nul: [null, 'NULL'],
            nan: [null, "CAST('nan' AS DOUBLE)"],
          });
          // What is no constant is stored as SQL text, which stays as it is.
          expect(st?.[1]).toBe('"system".main.struct_pack(a := 1)');
          expect(iv?.[1]).toMatch(/^"system"\.main\./);
          expect(parameters('typed')).toEqual({
            a: ['int32', null],
            b: ['INTEGER[]', null],
            c: ['STRUCT(x INTEGER, y VARCHAR)', null],
            d: ['decimal(9,3)', null],
            e: ['timestamptz', null],
            g: ['uint64', null],
            h: ['MAP(VARCHAR, INTEGER)', null],
            m: ['int8', null],
            n: ['int16', null],
            k: ['int32', '5'],
          });
          // Macros without parameters, alone or as an overload, keep the order they were written in.
          const parameterCounts = (name: string) =>
            macros.find((macro) => macro.name === name)?.implementations.map((i) => i.parameters.length);
          expect([parameterCounts('zero'), parameterCounts('mixed'), parameterCounts('mixed2')]).toEqual([
            [0],
            [1, 0],
            [0, 2],
          ]);
        } finally {
          await reader2.close();
        }

        const tree = treeOf(lake);
        try {
          await tree.connect('l');
          const labelsBelow = async (...path: string[]) =>
            (await tree.children(await nodeAt(tree, ...path))).map((node) => node.label);
          // Every schema has a Macros folder, also an empty one, and it lists every macro, overloads once per kind.
          expect(await labelsBelow('main', 'Macros')).toEqual(['m1']);
          expect(await labelsBelow('s', 'Macros')).toEqual([
            'defaults',
            'f',
            'mixed',
            'mixed2',
            'same',
            'same',
            't',
            'tm',
            'typed',
            'we"ird name; DROP SCHEMA s; --',
            'zero',
          ]);
          tree.selectSnapshot('l', snapshots[0] ?? -1);
          const [hint] = await tree.children(await nodeAt(tree, 's', 'Macros'));
          expect(hint?.hasChildren).toBe(false);
          // At the snapshot of the overload the tree shows the macro as it was then, before the replacement.
          tree.selectSnapshot('l', snapshots[2] ?? -1);
          const [overloaded] = await tree.children(await nodeAt(tree, 's', 'Macros'));
          expect(overloaded?.label).toBe('f');
          expect(overloaded?.tooltip).toContain('x + 1)');
          expect(overloaded?.tooltip).toContain('(x + y)');
        } finally {
          await tree.dispose();
        }
      });

      /** The macros of schema `s` in a lake as the reader sees them, sorted by kind and name. */
      const macrosOf = async (target: BackendLake): Promise<MacroInfo[]> => {
        const reader = await target.reader();
        try {
          const newest = Number(
            (await rows(target, 'SELECT max(snapshot_id) FROM lake.snapshots()'))[0]?.[0],
          );
          return (await reader.macros(await schemaId(reader, newest, 's'), newest)).toSorted(
            (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
          );
        } finally {
          await reader.close();
        }
      };

      it('writes a CREATE statement for every macro that DuckDB runs and that stores the same macro again', async () => {
        const target = await copyOf(async (tree) => {
          const macros = await tree.children(await nodeAt(tree, 's', 'Macros'));
          return Promise.all(macros.map(async (node) => (await createOf(tree, node.ref)) ?? ''));
        });
        try {
          const original = await macrosOf(lake);
          const copy = await macrosOf(target);
          expect(names(copy)).toEqual(names(original));
          expect(copy.map(definition)).toEqual(original.map(definition));

          // The copy works like the original, with all overloads.
          expect(await rows(target, 'SELECT s.f(1)')).toEqual([[101]]);
          expect(await rows(target, 'SELECT s.same(7)')).toEqual([[7]]);
          expect(await rows(target, 'SELECT * FROM s.same(7)')).toEqual([[7]]);
          expect(await rows(target, 'SELECT * FROM s.tm(3), s.tm(3, 4) ORDER BY 1, 2')).toEqual([[3, 7]]);
          expect(await rows(target, 'SELECT * FROM s.t(2)')).toEqual([[42], [42]]);
          const call = (a: string, k = ''): string =>
            `SELECT s.typed(${a}, [1], {'x': 1, 'y': 'a'}, 1.5, now(), 1::UBIGINT, MAP {'a': 1}, 1::TINYINT, 2::SMALLINT${k})`;
          expect(await rows(target, call('1'))).toEqual([[1]]);
          expect(await rows(target, call('1', ', 6'))).toEqual([[1]]);
          await expect(target.connection.run(call("'x'"))).rejects.toThrow(/Binder Error/);
        } finally {
          await target.remove();
        }

        // One text per shape: overloaded table macro, a default, no parameter, an overload without one.
        const tree = treeOf(lake);
        try {
          await tree.connect('l');
          const folder = await tree.children(await nodeAt(tree, 's', 'Macros'));
          const text = async (name: string, kind: 'scalar' | 'table') => {
            const node = folder.find(
              (n) => n.ref.kind === 'macro' && n.ref.macro.name === name && n.ref.macro.kind === kind,
            );
            return node && createOf(tree, node.ref);
          };
          expect(await text('tm', 'table')).toBe(
            createWithDrop(
              'DROP MACRO TABLE "s"."tm";',
              'CREATE OR REPLACE MACRO "s"."tm"("n") AS TABLE (SELECT n AS v), ("n", "m") AS TABLE (SELECT (n + m) AS v);',
            ),
          );
          expect(await text('t', 'table')).toBe(
            createWithDrop(
              'DROP MACRO TABLE "s"."t";',
              'CREATE OR REPLACE MACRO "s"."t"("n" := 10) AS TABLE SELECT 42 AS answer FROM "range"(n);',
            ),
          );
          expect(await text('zero', 'scalar')).toBe(
            createWithDrop('DROP MACRO "s"."zero";', 'CREATE OR REPLACE MACRO "s"."zero"() AS 42;'),
          );
          expect(await text('mixed2', 'scalar')).toBe(
            createWithDrop(
              'DROP MACRO "s"."mixed2";',
              'CREATE OR REPLACE MACRO "s"."mixed2"() AS 0, ("x", "y") AS (x + y);',
            ),
          );
        } finally {
          await tree.dispose();
        }
      });

      it('replaces the macro with all its overloads when the ALTER script is edited and run, and drops the overload the script leaves out', async () => {
        const tree = treeOf(lake);
        let script: string | undefined;
        try {
          await tree.connect('l');
          // Script of the macro as it was before the replacement: two overloads.
          tree.selectSnapshot('l', snapshots[2] ?? -1);
          const node = await nodeAt(tree, 's', 'Macros', 'f');
          script = await alterOf(tree, node.ref);
        } finally {
          await tree.dispose();
        }
        expect(script).toContain(
          '\nCREATE OR REPLACE MACRO "s"."f"("x") AS (x + 1), ("x", "y") AS (x + y);\n',
        );
        expect(script).toContain(`@${snapshots[2]}`);
        const target = await backend.create();
        try {
          await run(target, 'CREATE SCHEMA s');
          await run(target, script ?? '');
          expect(await rows(target, 'SELECT s.f(1), s.f(1, 2)')).toEqual([[2, 3]]);

          await run(target, (script ?? '').replace('AS (x + 1)', 'AS (x + 1000)'));
          expect(await rows(target, 'SELECT s.f(1), s.f(1, 2)')).toEqual([[1001, 3]]);

          // CREATE OR REPLACE with one overload leaves one: the script of a macro has to hold them all.
          await run(target, 'CREATE OR REPLACE MACRO "s"."f"("x") AS (x + 1000)');
          await expect(target.connection.run('SELECT s.f(1, 2)')).rejects.toThrow(
            /does not support the supplied arguments/,
          );
        } finally {
          await target.remove();
        }
      });

      it('drops the macro with all its overloads, the table macro with TABLE, leaves the other kind alone, and writes nothing by itself', async () => {
        const target = await copyOf(async (tree) => {
          const macros = await tree.children(await nodeAt(tree, 's', 'Macros'));
          return Promise.all(macros.map(async (node) => (await createOf(tree, node.ref)) ?? ''));
        });
        const tree = treeOf(lake);
        try {
          await tree.connect('l');
          const macros = await tree.children(await nodeAt(tree, 's', 'Macros'));
          const dropOfMacro = (kind: string, name: string): string => {
            const node = macros.find(
              (n) => n.ref.kind === 'macro' && n.ref.macro.kind === kind && n.ref.macro.name === name,
            );
            const script = node && dropOf(tree, node.ref);
            if (script === undefined) {
              throw new Error(`No ${kind} macro ${name}`);
            }
            return script;
          };

          expect(dropOfMacro('table', 'tm')).toContain('\nDROP MACRO TABLE "s"."tm";');
          expect(dropOfMacro('scalar', 'same')).toContain('\nDROP MACRO "s"."same";');
          expect(dropOfMacro('table', 'same')).toContain('\nDROP MACRO TABLE "s"."same";');

          const left = async (): Promise<string[]> =>
            names(await macrosOf(target)).filter((name) => /tm|same|f\//.test(name));
          await run(target, dropOfMacro('table', 'tm'));
          await run(target, dropOfMacro('scalar', 'f'));
          await run(target, dropOfMacro('scalar', 'same'));
          // The scalar macro is gone, the table macro of the same name is not: only DROP MACRO TABLE reaches that one.
          expect(await left()).toEqual(['table same/1']);
          expect(await rows(target, 'SELECT * FROM s.same(7)')).toEqual([[7]]);
          await expect(target.connection.run('SELECT s.f(1)')).rejects.toThrow();
          await expect(target.connection.run('SELECT * FROM s.tm(3)')).rejects.toThrow();

          await run(target, dropOfMacro('table', 'same'));
          expect(await left()).toEqual([]);
          await expect(target.connection.run('SELECT * FROM s.same(7)')).rejects.toThrow();

          // Producing the scripts of the source lake wrote nothing to it.
          const before = (await macrosOf(lake)).map(definition);
          for (const node of macros) {
            await createOf(tree, node.ref);
            await alterOf(tree, node.ref);
            dropOf(tree, node.ref);
          }
          expect((await macrosOf(lake)).map(definition)).toEqual(before);
        } finally {
          await tree.dispose();
          await target.remove();
        }
      });

      describe('Script as CREATE on the Macros folder', () => {
        // A schema name that tries to end its identifier and to start a statement of its own, on two lines.
        const HOSTILE_SCHEMA = 'we"ird; DROP SCHEMA victim; --\nname';
        const quoted = `"${HOSTILE_SCHEMA.replaceAll('"', '""')}"`;

        /** The lines of the commented statements after the marker, without their comment marks (a statement ends with `;`). */
        const uncommentedAfter = (text: string, marker: string): string[] => {
          const statements: string[] = [];
          let open: string[] | undefined;
          for (const line of text.split('\n')) {
            if (line === marker) {
              open = [];
            } else if (open) {
              open.push(line.replace(/^-- /, ''));
              if (line.endsWith(';')) {
                statements.push(open.join('\n'));
                open = undefined;
              }
            }
          }
          return statements;
        };

        it('is a template whose two examples run as they are, whose calls and drops run once uncommented, and which keeps a hostile schema name inside its quotes', async () => {
          const target = await backend.create();
          const tree = treeOf(target);
          try {
            await run(target, 'CREATE SCHEMA victim');
            await run(target, `CREATE SCHEMA ${quoted}`);
            await tree.connect('l');
            const folder = await nodeAt(tree, HOSTILE_SCHEMA, 'Macros');
            expect(await tree.children(folder)).toHaveLength(1);
            const text = (await createOf(tree, folder.ref)) ?? '';

            // The name appears quoted in the statements and never as it is.
            expect(text).not.toContain(HOSTILE_SCHEMA);
            expect(
              text.replaceAll(quoted.replaceAll('\n', '\n-- '), '').replaceAll(quoted, ''),
            ).not.toContain('DROP SCHEMA victim');

            await run(target, text);
            const macros = async (): Promise<string[]> => {
              const reader = await target.reader();
              try {
                const latest = Number(
                  (await rows(target, 'SELECT max(snapshot_id) FROM lake.snapshots()'))[0]?.[0],
                );
                return names(await reader.macros(await schemaId(reader, latest, HOSTILE_SCHEMA), latest));
              } finally {
                await reader.close();
              }
            };
            expect(await macros()).toEqual(['scalar add_one/1', 'table first_rows/1']);

            const calls = uncommentedAfter(text, '-- Call it');
            expect(calls).toEqual([
              `SELECT ${quoted}."add_one"(1);`,
              `SELECT * FROM ${quoted}."first_rows"(3);`,
            ]);
            expect(await rows(target, calls[0] ?? '')).toEqual([[2]]);
            expect(await rows(target, calls[1] ?? '')).toEqual([[42], [42], [42]]);

            // The examples are a plain CREATE: running the template again fails and replaces nothing.
            await expect(run(target, text)).rejects.toThrow(/already exists/i);
            expect(await macros()).toEqual(['scalar add_one/1', 'table first_rows/1']);
            // Dropping them removes exactly them.
            const drops = uncommentedAfter(text, '-- Drop it');
            expect(drops).toEqual([
              `DROP MACRO ${quoted}."add_one";`,
              `DROP MACRO TABLE ${quoted}."first_rows";`,
            ]);
            for (const drop of drops) {
              await run(target, drop);
            }
            expect(await macros()).toEqual([]);
            expect(
              await rows(
                target,
                "SELECT count(*) FROM duckdb_schemas() WHERE database_name = 'lake' AND schema_name = 'victim'",
              ),
            ).toEqual([['1']]);
          } finally {
            await tree.dispose();
            await target.remove();
          }
        });
      });
    },
  );
}
