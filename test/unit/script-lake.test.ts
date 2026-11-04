import { describe, expect, it } from 'vitest';
import { openDuckdb } from '../../src/catalog/drivers/duckdb';
import { createCatalogReader } from '../../src/catalog/reader';
import { OPTIONS } from '../../src/maintenance-options';
import { selectAtSnapshot, selectStatement } from '../../src/script';
import { scriptOf } from '../../src/script-templates';
import { createLake, engineSkipReason } from './data-support';
import {
  fill,
  GENERIC_FILL,
  NOT_UNDERSTOOD,
  scriptsOf,
  tableNames,
  viewNames,
  withWriter,
} from './script-support';

const alterOf = (tree: Parameters<typeof scriptOf>[1], ref: Parameters<typeof scriptOf>[2]) =>
  scriptOf('alter', tree, ref);
// The drop scripts of a table, a view and a macro are made without waiting.
const dropOf = (tree: Parameters<typeof scriptOf>[1], ref: Parameters<typeof scriptOf>[2]) =>
  scriptOf('drop', tree, ref) as string | undefined;

const skipReason = await engineSkipReason();
const TABLE_OPTIONS = OPTIONS.filter(({ scopes }) => scopes.includes('table')).length;
if (skipReason) {
  console.warn(`The script tests against a real DuckLake are skipped: ${skipReason}`);
}

describe.skipIf(skipReason !== undefined)('the scripts, run by a real DuckLake', () => {
  describe('Script as DROP', () => {
    it('drops the table or the view that the node stands for, and nothing else, also for hostile names', async () => {
      const lake = await createLake([
        'CREATE TABLE victim (a INTEGER)',
        'CREATE TABLE keep (a INTEGER)',
        'CREATE TABLE "a b""; DROP TABLE victim; --" (a INTEGER)',
        'CREATE VIEW "line\nbreak" AS SELECT 1 AS x',
      ]);
      try {
        const [dropTable, dropView] = await scriptsOf(lake, async (nodeAt, tree) => [
          dropOf(tree, (await nodeAt('main', 'Tables', 'a b"; DROP TABLE victim; --')).ref),
          dropOf(tree, (await nodeAt('main', 'Views', 'line\nbreak')).ref),
        ]);
        expect(dropTable).toBe(
          '-- Drops the table. Run it in a read/write SQL session.\nDROP TABLE "main"."a b""; DROP TABLE victim; --";',
        );

        await withWriter(lake, async (writer) => {
          expect(await writer.rows(tableNames)).toEqual([
            ['a b"; DROP TABLE victim; --'],
            ['keep'],
            ['victim'],
          ]);
          await writer.run(dropTable ?? '');
          expect(await writer.rows(tableNames)).toEqual([['keep'], ['victim']]);

          expect(await writer.rows(viewNames)).toEqual([['line\nbreak']]);
          await writer.run(dropView ?? '');
          expect(await writer.rows(viewNames)).toEqual([]);
          expect(await writer.rows(tableNames)).toEqual([['keep'], ['victim']]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as SELECT with time travel', () => {
    it('reads a table and a view as they were at the snapshot of the comment, on a real DuckLake', async () => {
      const lake = await createLake([
        'CREATE TABLE t (a INTEGER)',
        'INSERT INTO t VALUES (1)',
        'INSERT INTO t VALUES (2)',
        'CREATE VIEW v AS SELECT a FROM t',
        'INSERT INTO t VALUES (3)',
      ]);
      try {
        await withWriter(lake, async (writer) => {
          const ids = (await writer.rows('SELECT snapshot_id FROM lake.snapshots() ORDER BY 1')).map(([id]) =>
            Number(id),
          );
          const [, created, first, second, view, third] = ids.slice(-6) as [
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          const read = (relation: string, columns: string[] | undefined, at: number) =>
            writer.rows(selectStatement('main', relation, columns, at).replace(/;$/, ''));

          expect(await read('t', ['a'], created)).toEqual([]);
          expect(await read('t', ['a'], first)).toEqual([[1]]);
          expect(await read('t', ['a'], second)).toEqual([[1], [2]]);
          expect(await read('v', undefined, view)).toEqual([[1], [2]]);
          expect(await read('v', undefined, third)).toEqual([[1], [2], [3]]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as SELECT of a view at a snapshot', () => {
    // Snapshots: 1 schema s, 2 table, 3 insert, 4 view v (id), 5 insert, 6 view v replaced (id, name; id > 1), 7 column added.
    const SETUP = [
      'CREATE SCHEMA s',
      'CREATE TABLE s.t (id INTEGER, name VARCHAR)',
      "INSERT INTO s.t VALUES (1, 'a')",
      'CREATE VIEW s.v AS SELECT id FROM s.t',
      "INSERT INTO s.t VALUES (2, 'b')",
      'CREATE OR REPLACE VIEW s.v AS SELECT id, name FROM s.t WHERE id > 1',
      'ALTER TABLE s.t ADD COLUMN extra INTEGER',
    ];

    it('DuckLake applies AT (VERSION => n) to a view: the query of the view as of n over the tables as of n', async () => {
      const lake = await createLake(SETUP);
      try {
        await withWriter(lake, async (writer) => {
          const read = (at: number) =>
            writer.rows(selectStatement('s', 'v', undefined, at).replace(/;$/, ''));
          expect(await read(4)).toEqual([[1]]);
          // The old query (id) on the table as it was at 5 (two rows), not the newest query.
          expect(await read(5)).toEqual([[1], [2]]);
          expect(await read(6)).toEqual([[2, 'b']]);
          expect(await read(7)).toEqual([[2, 'b']]);
          // Before the view existed it is an error that names the version, and no other relation is read instead.
          await expect(read(3)).rejects.toThrow(/Table with name v does not exist at version 3/);
        });
      } finally {
        await lake.remove();
      }
    });

    it('runs the script of a view node of a tree that shows an older snapshot', async () => {
      const lake = await createLake(SETUP);
      try {
        const script = await scriptsOf(lake, async (nodeAt, tree) => {
          const view = await nodeAt('s', 'Views', 'v');
          tree.selectSnapshot('lake', 5);
          return scriptOf('select', tree, view.ref);
        });
        expect(script).toBe(
          '-- Time travel to snapshot 5\nSELECT *\nFROM "s"."v" AT (VERSION => 5)\nLIMIT 1000;',
        );
        await withWriter(lake, async (writer) => {
          expect((await writer.results(script ?? '')).at(-1)).toEqual([[1], [2]]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as SELECT of a relation without columns at the snapshot', () => {
    const SETUP = [
      'CREATE SCHEMA s',
      'CREATE TABLE s.t (a INTEGER, b VARCHAR)',
      "INSERT INTO s.t VALUES (1, 'x')",
    ];

    it('selects * for a table that has no columns at the pinned snapshot, and the script is valid SQL', async () => {
      const lake = await createLake(SETUP);
      try {
        const scripts = await scriptsOf(lake, async (nodeAt, tree) => {
          const table = await nodeAt('s', 'Tables', 't');
          tree.selectSnapshot('lake', 1); // the table is created in snapshot 2
          const reader = createCatalogReader(await openDuckdb({ path: lake.profile.path }));
          try {
            const subject = {
              kind: 'table',
              id: table.ref.kind === 'table' ? table.ref.table.id : -1,
            } as const;
            return [
              await scriptOf('select', tree, table.ref),
              await selectAtSnapshot(
                reader,
                { ...subject, schemaName: 's', name: 't' },
                { schema: 's', table: 't' },
                1,
              ),
            ];
          } finally {
            await reader.close();
          }
        });
        const expected =
          '-- Time travel to snapshot 1\nSELECT *\nFROM "s"."t" AT (VERSION => 1)\nLIMIT 1000;';
        expect(scripts).toEqual([expected, expected]);
        await withWriter(lake, async (writer) => {
          // The table does not exist at snapshot 1: the engine says so, it does not complain about the syntax.
          const error = await writer.attempt(scripts[0] ?? '');
          expect(error).toMatch(/does not exist at version 1/);
          expect(error).not.toMatch(/Parser Error/);
        });
      } finally {
        await lake.remove();
      }
    });

    it('selects * for the folder of the columns when it lists none, and returns the rows of the table', async () => {
      const lake = await createLake(SETUP);
      try {
        const script = await scriptsOf(lake, async (nodeAt, tree) => {
          const { ref } = await nodeAt('s', 'Tables', 't', 'Columns');
          return ref.kind === 'folder' && ref.folder === 'columns'
            ? scriptOf('select', tree, { ...ref, columns: [] })
            : undefined;
        });
        expect(script).toBe('SELECT *\nFROM "s"."t"\nLIMIT 1000;');
        await withWriter(lake, async (writer) => {
          expect((await writer.results(script ?? '')).at(-1)).toEqual([[1, 'x']]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as INSERT', () => {
    const placeholdersOf = (script: string | undefined): string[] =>
      [...(script ?? '').matchAll(/^ {2}(<.+>),?$/gm)].map(([, placeholder]) => placeholder ?? '');

    it('inserts one row once the placeholders are replaced: nested types, a default, NOT NULL and names that need quotes', async () => {
      const lake = await createLake([
        'CREATE SCHEMA s',
        'CREATE TABLE s."order ""lines""" (id INTEGER NOT NULL, "a b" STRUCT(x INTEGER, "y;z" VARCHAR[]), m MAP(VARCHAR, INTEGER), amount DECIMAL(10,2) DEFAULT 0, "note>--" VARCHAR)',
      ]);
      try {
        const script = await scriptsOf(lake, async (nodeAt, tree) =>
          scriptOf('insert', tree, (await nodeAt('s', 'Tables', 'order "lines"')).ref),
        );
        const placeholders = placeholdersOf(script);
        expect(placeholders).toEqual([
          '<"id" INTEGER NOT NULL>',
          '<"a b" STRUCT("x" INTEGER, "y;z" VARCHAR[])>',
          '<"m" MAP(VARCHAR, INTEGER)>',
          '<"amount" DECIMAL(10,2) DEFAULT 0>',
          '<"note>--" VARCHAR>',
        ]);
        const values = ['1', "{'x': 2, 'y;z': ['a']}", "MAP {'k': 3}", '4.5', "'n'"];
        await withWriter(lake, async (writer) => {
          await writer.run(
            fill(script ?? '', Object.fromEntries(placeholders.map((p, i) => [p, values[i] ?? '']))),
          );
          expect(
            await writer.rows(
              'SELECT id, "a b".x, "a b"."y;z"[1], m[\'k\'], amount::VARCHAR, "note>--" FROM s."order ""lines"""',
            ),
          ).toEqual([[1, 2, 'a', 3, '4.50', 'n']]);
        });
      } finally {
        await lake.remove();
      }
    });

    it('has the name and the columns of the newest snapshot when the tree shows an older one, where the table may be gone', async () => {
      const lake = await createLake([
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (a INTEGER)', // snapshot 2
        'ALTER TABLE s.t RENAME TO t2',
        'ALTER TABLE s.t2 ADD COLUMN b VARCHAR',
        'CREATE TABLE s.gone (a INTEGER)', // snapshot 5
        'DROP TABLE s.gone', // snapshot 6, the newest
      ]);
      try {
        const [renamed, gone] = await scriptsOf(lake, async (nodeAt, tree) => {
          tree.selectSnapshot('lake', 2);
          const old = await scriptOf('insert', tree, (await nodeAt('s', 'Tables', 't')).ref);
          tree.selectSnapshot('lake', 5);
          return [old, await scriptOf('insert', tree, (await nodeAt('s', 'Tables', 'gone')).ref)];
        });
        expect(renamed?.split('\n')[1]).toMatch(/^-- .*@2\b.*@6\b/);
        expect(placeholdersOf(renamed)).toEqual(['<"a" INTEGER>', '<"b" VARCHAR>']);
        expect(gone?.split('\n').filter((line) => !line.startsWith('--'))).toEqual([]);
        expect(gone).toMatch(/@5\b.*@6\b/);
        await withWriter(lake, async (writer) => {
          await writer.run(fill(renamed ?? '', { '<"a" INTEGER>': '1', '<"b" VARCHAR>': "'x'" }));
          expect(await writer.rows('SELECT a, b FROM s.t2')).toEqual([[1, 'x']]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as ALTER of a view', () => {
    it('runs as it is, and replaces the view, with its column names, once the query is edited', async () => {
      const lake = await createLake([
        'CREATE TABLE t (a INTEGER, b INTEGER)',
        'INSERT INTO t VALUES (1, 10), (2, 20)',
        'CREATE VIEW "v ""q" (x) AS SELECT a FROM t',
      ]);
      try {
        const script = await scriptsOf(lake, async (nodeAt, tree) =>
          alterOf(tree, (await nodeAt('main', 'Views', 'v "q')).ref),
        );
        expect(script).toBe(
          [
            '-- Edit the query, then run the statement in a read/write SQL session to replace the view.',
            'CREATE OR REPLACE VIEW "main"."v ""q" ("x") AS SELECT a FROM t;',
            '-- Rename the view',
            '-- ALTER VIEW "main"."v ""q" RENAME TO <new_name>;',
            '-- Comment on the view',
            `-- COMMENT ON VIEW "main"."v ""q" IS '<comment>';`,
            '-- Drop the view',
            '-- DROP VIEW "main"."v ""q";',
          ].join('\n'),
        );

        await withWriter(lake, async (writer) => {
          const read = 'SELECT * FROM "v ""q" ORDER BY 1';
          await writer.run(script ?? '');
          expect(await writer.rows(read)).toEqual([[1], [2]]);

          const edited = (script ?? '').replace('SELECT a FROM t', 'SELECT b FROM t');
          expect(edited).not.toBe(script);
          await writer.run(edited);
          expect(await writer.rows(read)).toEqual([[10], [20]]);
          expect(await writer.rows(viewNames)).toEqual([['v "q']]);
        });
      } finally {
        await lake.remove();
      }
    });
  });

  describe('Script as ALTER of a table', () => {
    const SETUP = [
      'CREATE SCHEMA s',
      'CREATE TABLE s.t (id INTEGER NOT NULL, name VARCHAR, customer STRUCT(name VARCHAR, nested STRUCT(x INTEGER, y INTEGER)), tags INTEGER[])',
      "INSERT INTO s.t VALUES (1, 'a', {'name': 'n', 'nested': {'x': 1, 'y': 2}}, [1])",
    ];
    const T = '"s"."t"';
    const columns =
      "SELECT column_name || ' ' || data_type FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = 's' AND table_name = 't'";
    const NESTED = 'nested STRUCT(x INTEGER, y INTEGER)';

    /** Every statement form of the template, filled in, with the columns of `s.t` after it ran (rolled back afterwards). */
    const cases: readonly {
      readonly statement: string;
      readonly fill: Record<string, string>;
      readonly columns: readonly string[];
    }[] = [
      {
        statement: 'ADD COLUMN <new_column> <type>',
        fill: { '<new_column>': '"added"', '<type>': 'VARCHAR' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          `customer STRUCT("name" VARCHAR, ${NESTED})`,
          'tags INTEGER[]',
          'added VARCHAR',
        ],
      },
      {
        statement: 'RENAME COLUMN "id" TO <new_name>',
        fill: { '<new_name>': '"ident"' },
        columns: [
          'ident INTEGER',
          'name VARCHAR',
          `customer STRUCT("name" VARCHAR, ${NESTED})`,
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'ALTER COLUMN "id" SET DATA TYPE <new_type>',
        fill: { '<new_type>': 'BIGINT' },
        columns: [
          'id BIGINT',
          'name VARCHAR',
          `customer STRUCT("name" VARCHAR, ${NESTED})`,
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'ALTER COLUMN "tags" SET DATA TYPE <new_type>',
        fill: { '<new_type>': 'BIGINT[]' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          `customer STRUCT("name" VARCHAR, ${NESTED})`,
          'tags BIGINT[]',
        ],
      },
      {
        statement: 'DROP COLUMN "name"',
        fill: {},
        columns: ['id INTEGER', `customer STRUCT("name" VARCHAR, ${NESTED})`, 'tags INTEGER[]'],
      },
      {
        statement: 'ADD COLUMN "customer".<new_field> <type>',
        fill: { '<new_field>': '"extra"', '<type>': 'DATE' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          `customer STRUCT("name" VARCHAR, ${NESTED}, extra DATE)`,
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'RENAME COLUMN "customer"."name" TO <new_name>',
        fill: { '<new_name>': '"full_name"' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          `customer STRUCT(full_name VARCHAR, ${NESTED})`,
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'DROP COLUMN "customer"."name"',
        fill: {},
        columns: ['id INTEGER', 'name VARCHAR', `customer STRUCT(${NESTED})`, 'tags INTEGER[]'],
      },
      {
        statement: 'ADD COLUMN "customer"."nested".<new_field> <type>',
        fill: { '<new_field>': '"z"', '<type>': 'INTEGER' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          'customer STRUCT("name" VARCHAR, nested STRUCT(x INTEGER, y INTEGER, z INTEGER))',
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'RENAME COLUMN "customer"."nested"."x" TO <new_name>',
        fill: { '<new_name>': '"xx"' },
        columns: [
          'id INTEGER',
          'name VARCHAR',
          'customer STRUCT("name" VARCHAR, nested STRUCT(xx INTEGER, y INTEGER))',
          'tags INTEGER[]',
        ],
      },
      {
        statement: 'DROP COLUMN "customer"."nested"."y"',
        fill: {},
        columns: [
          'id INTEGER',
          'name VARCHAR',
          'customer STRUCT("name" VARCHAR, nested STRUCT(x INTEGER))',
          'tags INTEGER[]',
        ],
      },
    ];

    it('offers statements that DuckLake runs: each form, uncommented and filled in, changes the table as described', async () => {
      const lake = await createLake(SETUP);
      try {
        const template = await scriptsOf(lake, async (nodeAt, tree) =>
          alterOf(tree, (await nodeAt('s', 'Tables', 't')).ref),
        );
        const lines = (template ?? '').split('\n');

        await withWriter(lake, async (writer) => {
          for (const { statement, fill: values, columns: expected } of cases) {
            const line = `-- ALTER TABLE ${T} ${statement};`;
            expect(lines, statement).toContain(line);
            const runnable = fill(line.slice(3), values);
            expect(await writer.tried(runnable, `${columns} ORDER BY column_index`), statement).toEqual(
              expected.map((column) => [column]),
            );
          }
          expect(await writer.tried(`ALTER TABLE ${T} RENAME TO "renamed"`, tableNames)).toEqual([
            ['renamed'],
          ]);
          expect(lines).toContain(`-- ALTER TABLE ${T} RENAME TO <new_name>;`);
          // Nothing of the above is left behind.
          expect(await writer.rows(tableNames)).toEqual([['t']]);
        });
      } finally {
        await lake.remove();
      }
    });

    it('offers no statement that DuckDB cannot parse or resolve, once the placeholders are filled in', async () => {
      const lake = await createLake(SETUP);
      try {
        const template = await scriptsOf(lake, async (nodeAt, tree) =>
          alterOf(tree, (await nodeAt('s', 'Tables', 't')).ref),
        );
        const statements = [
          ...(template ?? '').matchAll(/^-- ((?:ALTER TABLE|COMMENT ON|DROP TABLE) .*);$/gm),
        ].map((match) => match[1]);
        // 4 columns: rename, change the type, drop and comment each; the struct fields; the table: a new column, rename,
        // comment, set and reset the partitioning, set and reset the sort order, set and reset each option, drop.
        expect(statements).toHaveLength(4 * 4 + (1 + 2 * 2 + 1 + 2 * 2) + 8 + 2 * TABLE_OPTIONS);

        await withWriter(lake, async (writer) => {
          for (const statement of statements) {
            const message = await writer.attempt(fill(`${statement};`, GENERIC_FILL));
            expect(message ?? '', statement).not.toMatch(NOT_UNDERSTOOD);
          }
        });
      } finally {
        await lake.remove();
      }
    });

    describe('for a struct inside a list or a map', () => {
      const NESTED_SETUP = [
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (ls STRUCT(a INTEGER, b INTEGER)[], m MAP(VARCHAR, STRUCT(q INTEGER, r INTEGER)), mk MAP(STRUCT(k INTEGER, l INTEGER), VARCHAR), ll STRUCT(a INTEGER, b INTEGER)[][])',
      ];
      const typeOf = (column: string) =>
        `SELECT data_type FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = 's' AND table_name = 't' AND column_name = '${column}'`;

      const cases: readonly {
        readonly statement: string;
        readonly fill: Record<string, string>;
        readonly column: string;
        readonly type: string;
      }[] = [
        {
          statement: 'ADD COLUMN "ls"."element".<new_field> <type>',
          fill: { '<new_field>': '"z"', '<type>': 'DATE' },
          column: 'ls',
          type: 'STRUCT(a INTEGER, b INTEGER, z DATE)[]',
        },
        {
          statement: 'RENAME COLUMN "ls"."element"."a" TO <new_name>',
          fill: { '<new_name>': '"aa"' },
          column: 'ls',
          type: 'STRUCT(aa INTEGER, b INTEGER)[]',
        },
        { statement: 'DROP COLUMN "ls"."element"."a"', fill: {}, column: 'ls', type: 'STRUCT(b INTEGER)[]' },
        {
          statement: 'ADD COLUMN "m"."value".<new_field> <type>',
          fill: { '<new_field>': '"z"', '<type>': 'DATE' },
          column: 'm',
          type: 'MAP(VARCHAR, STRUCT(q INTEGER, r INTEGER, z DATE))',
        },
        {
          statement: 'RENAME COLUMN "m"."value"."q" TO <new_name>',
          fill: { '<new_name>': '"qq"' },
          column: 'm',
          type: 'MAP(VARCHAR, STRUCT(qq INTEGER, r INTEGER))',
        },
        {
          statement: 'DROP COLUMN "m"."value"."q"',
          fill: {},
          column: 'm',
          type: 'MAP(VARCHAR, STRUCT(r INTEGER))',
        },
        {
          statement: 'ADD COLUMN "ll"."element"."element".<new_field> <type>',
          fill: { '<new_field>': '"z"', '<type>': 'DATE' },
          column: 'll',
          type: 'STRUCT(a INTEGER, b INTEGER, z DATE)[][]',
        },
        {
          statement: 'ADD COLUMN "mk"."key".<new_field> <type>',
          fill: { '<new_field>': '"z"', '<type>': 'DATE' },
          column: 'mk',
          type: 'MAP(STRUCT(k INTEGER, l INTEGER, z DATE), VARCHAR)',
        },
        {
          statement: 'RENAME COLUMN "mk"."key"."k" TO <new_name>',
          fill: { '<new_name>': '"kk"' },
          column: 'mk',
          type: 'MAP(STRUCT(kk INTEGER, l INTEGER), VARCHAR)',
        },
        {
          statement: 'DROP COLUMN "mk"."key"."k"',
          fill: {},
          column: 'mk',
          type: 'MAP(STRUCT(l INTEGER), VARCHAR)',
        },
        {
          statement: 'DROP COLUMN "ll"."element"."element"."b"',
          fill: {},
          column: 'll',
          type: 'STRUCT(a INTEGER)[][]',
        },
      ];

      it('offers the statements that DuckLake runs on the fields of such a struct, map keys included', async () => {
        const lake = await createLake(NESTED_SETUP);
        try {
          const template = await scriptsOf(lake, async (nodeAt, tree) =>
            alterOf(tree, (await nodeAt('s', 'Tables', 't')).ref),
          );
          const lines = (template ?? '').split('\n');

          await withWriter(lake, async (writer) => {
            for (const { statement, fill: values, column, type } of cases) {
              const line = `-- ALTER TABLE ${T} ${statement};`;
              expect(lines, statement).toContain(line);
              expect(await writer.tried(fill(line.slice(3), values), typeOf(column)), statement).toEqual([
                [type],
              ]);
            }
          });
        } finally {
          await lake.remove();
        }
      });
    });

    it('keeps hostile names inside their identifiers: every line is a comment, and the statements run once uncommented', async () => {
      const names = [
        'a"b',
        'with space',
        'select',
        'line\nbreak',
        'ünï-日本',
        'x"; DROP TABLE victim; --',
        'a.b',
      ];
      const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
      const lake = await createLake([
        'CREATE TABLE victim (a INTEGER)',
        `CREATE SCHEMA ${q(names[5] ?? '')}`,
        `CREATE TABLE ${q(names[5] ?? '')}.${q(names[3] ?? '')} (${names.map((name) => `${q(name)} INTEGER`).join(', ')}, st STRUCT(${q(names[3] ?? '')} INTEGER, ${q(names[5] ?? '')} INTEGER))`,
      ]);
      try {
        const template = await scriptsOf(lake, async (nodeAt, tree) =>
          alterOf(tree, (await nodeAt(names[5] ?? '', 'Tables', names[3] ?? '')).ref),
        );
        const text = template ?? '';
        expect(text.split(/\r\n|\r|\n/).filter((line) => line !== '' && !line.startsWith('--'))).toEqual([]);

        const statements = [...text.matchAll(/^-- ((?:ALTER TABLE|COMMENT ON|DROP TABLE) .*?);$/gms)].map(
          (match) => (match[1] ?? '').replaceAll('\n-- ', '\n'),
        );
        expect(statements.length).toBeGreaterThan(names.length * 3);

        await withWriter(lake, async (writer) => {
          for (const statement of statements) {
            const message = await writer.attempt(
              fill(`${statement};`, { ...GENERIC_FILL, '<column>': q(names[0] ?? '') }),
            );
            expect(message ?? '', statement).not.toMatch(NOT_UNDERSTOOD);
          }
          expect(await writer.rows(tableNames)).toEqual([[names[3]], ['victim']]);
        });
      } finally {
        await lake.remove();
      }
    });
  });
});
