import { describe, expect, it } from 'vitest';
import { SCRIPTS, scriptKindOf, scriptOf } from '../../src/script-templates';
import type { ScriptVerb } from '../../src/script-templates';
import type { TreeNode } from '../../src/tree/refs';
import { createLake, engineSkipReason } from './data-support';
import type { Lake } from './data-support';
import { fill, GENERIC_FILL, NOT_UNDERSTOOD, scriptsOf, withWriter } from './script-support';
import type { Writer } from './script-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The script tests against a real DuckLake are skipped: ${skipReason}`);
}

const VERBS = ['select', 'create', 'alter', 'drop'] as const satisfies readonly ScriptVerb[];

/** Everything the lake holds that a script creates or drops, as one sorted list. */
const OBJECTS = `
  SELECT 'schema ' || schema_name FROM duckdb_schemas() WHERE database_name = 'lake'
  UNION ALL SELECT 'table ' || schema_name || '.' || table_name FROM duckdb_tables() WHERE database_name = 'lake'
  UNION ALL SELECT 'view ' || schema_name || '.' || view_name FROM duckdb_views() WHERE database_name = 'lake' AND NOT internal
  UNION ALL SELECT function_type || ' ' || schema_name || '.' || function_name FROM duckdb_functions()
    WHERE database_name = 'lake' AND function_type IN ('macro', 'table_macro')
  ORDER BY 1`;

const objects = async (writer: Writer): Promise<string[]> =>
  (await writer.rows(OBJECTS)).map(([name]) => String(name)).toSorted();

const columnsOf = (schema: string, table: string): string =>
  `SELECT column_name || ' ' || data_type FROM duckdb_columns() WHERE database_name = 'lake' AND schema_name = '${schema}' AND table_name = '${table}' ORDER BY column_index`;

/** The statements that a script has as comments, without the comment mark: the drops and the examples. */
const commentedStatements = (script: string, keyword: RegExp): string[] =>
  script
    .split('\n')
    .filter((line) => line.startsWith('-- ') && keyword.test(line.slice(3)))
    .map((line) => line.slice(3));

const SETUP = [
  'CREATE SCHEMA s',
  'CREATE SCHEMA empty_schema',
  'CREATE TABLE s.t (id INTEGER NOT NULL, name VARCHAR, customer STRUCT(name VARCHAR, nested STRUCT(x INTEGER, y INTEGER)), tags INTEGER[], m MAP(VARCHAR, STRUCT(q INTEGER)), ts TIMESTAMP)',
  "INSERT INTO s.t VALUES (1, 'a', {'name': 'n', 'nested': {'x': 1, 'y': 2}}, [1], MAP {'k': {'q': 1}}, TIMESTAMP '2020-01-01 00:00:00')",
  'ALTER TABLE s.t SET PARTITIONED BY (year(ts), bucket(4, id))',
  'ALTER TABLE s.t SET SORTED BY (id DESC NULLS LAST, name)',
  'CREATE VIEW s.v AS SELECT id, name FROM s.t',
  'CREATE MACRO s.f(a, b := 2) AS a + b, (a, b, c) AS a + b + c',
  'CREATE MACRO s.tm(n) AS TABLE SELECT * FROM s.t LIMIT n',
  'CREATE MACRO s.zero() AS 42',
];

/** Every node of the tree below the connection, with the labels that lead to it. */
async function allNodes(lake: Lake): Promise<
  {
    path: string[];
    contextValue: string;
    kind: ReturnType<typeof scriptKindOf>;
    texts: Record<ScriptVerb, string | undefined>;
  }[]
> {
  return scriptsOf(
    lake,
    async (_nodeAt, tree) => {
      const found: Awaited<ReturnType<typeof allNodes>> = [];
      const walk = async (node: TreeNode, path: string[]): Promise<void> => {
        const texts = Object.fromEntries(
          await Promise.all(VERBS.map(async (verb) => [verb, await scriptOf(verb, tree, node.ref)] as const)),
        ) as Record<ScriptVerb, string | undefined>;
        found.push({ path, contextValue: node.contextValue, kind: scriptKindOf(node.ref), texts });
        if (node.ref.kind !== 'snapshot') {
          for (const child of await tree.children(node)) {
            await walk(child, [...path, child.label]);
          }
        }
      };
      const [root] = tree.roots();
      if (root) {
        await walk(root, []);
      }
      return found;
    },
    // The explorer resolves the columns of a view with DuckDB; here the view has one column.
    () => Promise.resolve([{ name: 'a', type: 'INTEGER', nullable: true }]),
  );
}

/** A lake that is removed when the test is done. */
async function withLake<T>(setup: readonly string[], test: (lake: Lake) => Promise<T>): Promise<T> {
  const lake = await createLake(setup);
  try {
    return await test(lake);
  } finally {
    await lake.remove();
  }
}

describe.skipIf(skipReason !== undefined)('the scripts of every node, run by a real DuckLake', () => {
  it('writes a script for exactly the verbs of the matrix for each kind of node; the members of a column have no CREATE and no DROP', async () => {
    await withLake(SETUP, async (lake) => {
      const nodes = await allNodes(lake);
      const kinds = new Set(nodes.map(({ kind }) => kind));
      // Every kind of the matrix occurs in this lake, except the tags and the changes of a table, which the next tests add.
      for (const kind of Object.keys(SCRIPTS)) {
        if (!['folder.tags', 'detail.table'].includes(kind)) {
          expect(kinds, kind).toContain(kind);
        }
      }
      for (const { path, kind, contextValue, texts } of nodes) {
        // The menus ask for the context value of the node, the matrix is written for its kind: they are one name, but for
        // the schema main, which has the menus of a schema.
        const named = contextValue === 'schema.main' ? 'schema' : contextValue;
        expect(kind, path.join('/')).toBe(Object.hasOwn(SCRIPTS, named) ? named : undefined);
        for (const verb of VERBS) {
          const expected = kind !== undefined && SCRIPTS[kind][verb] !== undefined;
          expect(texts[verb] !== undefined, `${verb} of ${path.join('/')}`).toBe(expected);
          if (texts[verb] !== undefined) {
            expect(texts[verb]?.trim(), `${verb} of ${path.join('/')} is not empty`).not.toBe('');
          }
        }
      }

      const at = (...path: string[]) => nodes.find((node) => node.path.join('/') === path.join('/'));
      const column = ['s', 'Tables', 't', 'Columns'];
      for (const path of [['customer'], ['customer', 'name'], ['customer', 'nested', 'x'], ['tags'], ['m']]) {
        expect(at(...column, ...path)?.contextValue, path.join('/')).toBe('column');
      }
      for (const path of [
        ['tags', 'element'],
        ['m', 'key'],
        ['m', 'value'],
      ]) {
        const node = at(...column, ...path);
        expect(node?.contextValue, path.join('/')).toBe('column.member');
        expect(
          [node?.texts.select, node?.texts.create, node?.texts.alter, node?.texts.drop].map(Boolean),
        ).toEqual([true, false, true, false]);
      }
      // A struct inside a map value is addressed through the fixed name `value`, and its field is a column again.
      expect(at(...column, 'm', 'value', 'q')?.contextValue).toBe('column');
      expect(at(...column, 'm', 'value')?.texts.alter).toContain(
        '-- ALTER TABLE "s"."t" RENAME COLUMN "m"."value"."q" TO <new_name>;',
      );
    });
  });

  it('CREATE on the connection and on a schema runs as it is, in main, else the first schema, else the schema it creates, and keeps a hostile name quoted', async () => {
    const createOfRoot = (lake: Lake, ...path: string[]): Promise<string> =>
      scriptsOf(lake, async (nodeAt, tree) => scriptOf('create', tree, (await nodeAt(...path)).ref)).then(
        (script) => script ?? '',
      );
    await withLake([], async (lake) => {
      const script = await createOfRoot(lake);
      await withWriter(lake, async (writer) => {
        expect(await objects(writer)).toEqual(['schema main']);
        await writer.run(script);
        expect(await objects(writer)).toEqual([
          'macro main.add_one',
          'schema main',
          'schema new_schema',
          'table main.new_table',
          'table_macro main.first_rows',
          'view main.new_view',
        ]);
        // The drops are comments until the user removes the marks.
        for (const drop of commentedStatements(script, /^DROP /).reverse()) {
          await writer.run(drop);
        }
        expect(await objects(writer)).toEqual(['schema main']);
      });
    });

    for (const [setup, schema] of [
      [['CREATE SCHEMA alpha', 'DROP SCHEMA main'], 'alpha'],
      [['CREATE SCHEMA alpha', 'CREATE SCHEMA zeta'], 'main'],
      [['DROP SCHEMA main'], 'new_schema'],
    ] as const) {
      await withLake(setup, async (lake) => {
        const script = await createOfRoot(lake);
        expect(script).toContain(`CREATE TABLE "${schema}"."new_table"`);
        // A lake without any schema has no session to run in; the others run with their first schema as the default.
        if (schema !== 'new_schema') {
          await withWriter(lake, async (writer) => {
            await writer.run(script);
            const created = await objects(writer);
            expect(created).toContain(`table ${schema}.new_table`);
            expect(created).toContain(`view ${schema}.new_view`);
            expect(created).toContain(`macro ${schema}.add_one`);
          });
        }
      });
    }

    const name = 'x"; DROP TABLE victim; --\nline';
    const q = `"${name.replaceAll('"', '""')}"`;
    await withLake(['CREATE TABLE victim (a INTEGER)', `CREATE SCHEMA ${q}`], async (lake) => {
      const script = await createOfRoot(lake, name);
      await withWriter(lake, async (writer) => {
        await writer.run(script);
        expect(await objects(writer)).toEqual(
          [
            `macro ${name}.add_one`,
            'schema main',
            `schema ${name}`,
            `table ${name}.new_table`,
            'table main.victim',
            `table_macro ${name}.first_rows`,
            `view ${name}.new_view`,
          ].toSorted(),
        );
      });
    });
  });

  it('CREATE on a table, a view, a macro and the folders keeps the drop as a comment; uncommented, it recreates the object', async () => {
    await withLake(SETUP, async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => ({
        table: (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't')).ref)) ?? '',
        view: (await scriptOf('create', tree, (await nodeAt('s', 'Views', 'v')).ref)) ?? '',
        macro: (await scriptOf('create', tree, (await nodeAt('s', 'Macros', 'f')).ref)) ?? '',
        tableMacro: (await scriptOf('create', tree, (await nodeAt('s', 'Macros', 'tm')).ref)) ?? '',
      }));
      await withWriter(lake, async (writer) => {
        const before = await objects(writer);
        // As it is, a table and a view that exist are not replaced: the statement fails and nothing is lost.
        expect(await writer.attempt(scripts.table)).toMatch(/already exists/);
        expect(await writer.attempt(scripts.view)).toMatch(/already exists/);
        expect(await writer.rows('SELECT count(*) FROM s.t')).toEqual([['1']]);

        for (const script of Object.values(scripts)) {
          await writer.run(script.replace(/^-- (DROP )/gm, '$1'));
        }
        expect(await objects(writer)).toEqual(before);
        expect(await writer.rows('SELECT count(*) FROM s.t')).toEqual([['0']]);
        expect(await writer.rows(columnsOf('s', 't'))).toEqual([
          ['id INTEGER'],
          ['name VARCHAR'],
          ['customer STRUCT("name" VARCHAR, nested STRUCT(x INTEGER, y INTEGER))'],
          ['tags INTEGER[]'],
          ['m MAP(VARCHAR, STRUCT(q INTEGER))'],
          ['ts TIMESTAMP'],
        ]);
        expect(await writer.rows('SELECT s.f(1), s.f(1, 2, 3)')).toEqual([[3, 6]]);
      });

      // The templates of the Tables, Views and Macros folders run as they are and create what they say, in the schema of the folder.
      const folders = await scriptsOf(lake, async (nodeAt, tree) => [
        await scriptOf('create', tree, (await nodeAt('s', 'Tables')).ref),
        await scriptOf('create', tree, (await nodeAt('s', 'Views')).ref),
        await scriptOf('create', tree, (await nodeAt('s', 'Macros')).ref),
      ]);
      await withWriter(lake, async (writer) => {
        for (const script of folders) {
          await writer.run(script ?? '');
        }
        expect(await objects(writer)).toEqual(
          expect.arrayContaining([
            'table s.new_table',
            'view s.new_view',
            'macro s.add_one',
            'table_macro s.first_rows',
          ]),
        );
      });
    });
  });

  it('CREATE on the Columns, Partitioning and Sort Order folders runs as it is, and on a column the statement adds the column again', async () => {
    await withLake(SETUP, async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => ({
        folder: (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns')).ref)) ?? '',
        name:
          (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'tags')).ref)) ?? '',
        field:
          (await scriptOf(
            'create',
            tree,
            (await nodeAt('s', 'Tables', 't', 'Columns', 'customer', 'name')).ref,
          )) ?? '',
      }));
      await withWriter(lake, async (writer) => {
        await writer.run(scripts.folder);
        expect((await writer.rows(columnsOf('s', 't'))).map(([c]) => c)).toContain('new_column VARCHAR');
        await writer.run(commentedStatements(scripts.folder, /^ALTER TABLE /).join('\n'));
        expect((await writer.rows(columnsOf('s', 't'))).map(([c]) => c)).not.toContain('new_column VARCHAR');

        for (const script of [scripts.name, scripts.field]) {
          await writer.run(script.replace(/^-- (ALTER)/gm, '$1'));
        }
        // Dropped and added again: the same columns and fields, each at the end of its list.
        expect((await writer.rows(columnsOf('s', 't'))).map(([c]) => c)).toEqual([
          'id INTEGER',
          'name VARCHAR',
          'customer STRUCT(nested STRUCT(x INTEGER, y INTEGER), "name" VARCHAR)',
          'm MAP(VARCHAR, STRUCT(q INTEGER))',
          'ts TIMESTAMP',
          'tags INTEGER[]',
        ]);
      });
    });

    await withLake(SETUP, async (lake) => {
      const layout = (): Promise<string[]> =>
        scriptsOf(lake, async (nodeAt, tree) => [
          (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Partitioning')).ref)) ?? '',
          (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Sort Order')).ref)) ?? '',
        ]);
      const scripts = await layout();
      expect(scripts[0]).toContain('ALTER TABLE "s"."t" SET PARTITIONED BY (year("ts"), bucket(4, "id"));');
      expect(scripts[1]).toContain(
        'ALTER TABLE "s"."t" SET SORTED BY (id DESC NULLS LAST, "name" ASC NULLS LAST);',
      );
      await withWriter(lake, async (writer) => {
        for (const script of scripts) {
          await writer.run(script);
        }
      });
      // The layout is the same after it ran.
      expect(await layout()).toEqual(scripts);
    });
  });

  it('DROP on a schema is refused while it holds objects; on the connection and the folders it is comments only, each drop removing its object and nothing else', async () => {
    await withLake(SETUP, async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => ({
        empty: (await scriptOf('drop', tree, (await nodeAt('empty_schema')).ref)) ?? '',
        full: (await scriptOf('drop', tree, (await nodeAt('s')).ref)) ?? '',
      }));
      expect(scripts.full).toContain('\nDROP SCHEMA "s";\n');
      expect(scripts.full).toContain('\n-- DROP SCHEMA "s" CASCADE;');
      await withWriter(lake, async (writer) => {
        expect(await writer.attempt(scripts.full)).toMatch(/depend/);
        expect(await objects(writer)).toContain('table s.t');

        await writer.run(scripts.empty);
        expect(await objects(writer)).not.toContain('schema empty_schema');

        // CASCADE, uncommented, drops what the schema holds.
        await writer.run(
          scripts.full
            .replace('-- DROP SCHEMA "s" CASCADE', 'DROP SCHEMA "s" CASCADE')
            .replace('\nDROP SCHEMA "s";\n', '\n'),
        );
        expect(await objects(writer)).toEqual(['schema main']);
      });
    });

    await withLake([...SETUP, 'CREATE TABLE s.keep (a INTEGER, b INTEGER)'], async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => ({
        connection: (await scriptOf('drop', tree, (await nodeAt()).ref)) ?? '',
        tables: (await scriptOf('drop', tree, (await nodeAt('s', 'Tables')).ref)) ?? '',
        views: (await scriptOf('drop', tree, (await nodeAt('s', 'Views')).ref)) ?? '',
        macros: (await scriptOf('drop', tree, (await nodeAt('s', 'Macros')).ref)) ?? '',
        columns: (await scriptOf('drop', tree, (await nodeAt('s', 'Tables', 'keep', 'Columns')).ref)) ?? '',
        main: (await scriptOf('drop', tree, (await nodeAt('main')).ref)) ?? '',
      }));
      for (const [name, script] of Object.entries(scripts)) {
        expect(
          script.split('\n').filter((line) => line !== '' && !line.startsWith('--')),
          name,
        ).toEqual([]);
      }
      // The schema main is never dropped: not in the list of the connection, and not by its own script.
      expect(commentedStatements(scripts.connection, /^DROP SCHEMA/)).toEqual([
        'DROP SCHEMA "empty_schema";',
        'DROP SCHEMA "s";',
      ]);
      expect(commentedStatements(scripts.main, /^DROP/)).toEqual([]);
      await withWriter(lake, async (writer) => {
        const before = await objects(writer);
        for (const script of Object.values(scripts)) {
          await writer.run(script);
        }
        expect(await objects(writer), 'running the scripts as they are changes nothing').toEqual(before);

        const drop = async (script: string, statement: RegExp): Promise<void> => {
          for (const line of commentedStatements(script, statement)) {
            expect(await writer.attempt(line), line).toBeUndefined();
          }
        };
        // A schema that holds objects is refused, and the empty ones go.
        expect(await writer.attempt('DROP SCHEMA "s";')).toMatch(/depend/);
        await drop(scripts.connection, /^DROP SCHEMA "empty_schema"/);
        await drop(scripts.tables, /^DROP TABLE /);
        await drop(scripts.views, /^DROP VIEW /);
        await drop(scripts.macros, /^DROP MACRO /);
        await drop(scripts.columns, /^ALTER TABLE /);

        // Uncommenting the drops of the tables removes the table that is listed, and keeps the other one.
        await writer.run(commentedStatements(scripts.tables, /^DROP TABLE "s"\."t"/).join('\n'));
        expect(await objects(writer)).toContain('table s.keep');
        expect(await objects(writer)).not.toContain('table s.t');
        await writer.run(commentedStatements(scripts.macros, /^DROP MACRO /).join('\n'));
        expect((await objects(writer)).filter((name) => name.includes('macro'))).toEqual([]);
      });
    });
  });

  it('DROP lists at most twenty objects; on a column or struct field it is live, and the layout folders remove the layout', async () => {
    await withLake(
      [
        'CREATE SCHEMA many',
        ...Array.from(
          { length: 23 },
          (_, index) => `CREATE TABLE many.t${String(index).padStart(2, '0')} (a INTEGER)`,
        ),
      ],
      async (lake) => {
        const [drops, selects] = await scriptsOf(lake, async (nodeAt, tree) => [
          (await scriptOf('drop', tree, (await nodeAt('many', 'Tables')).ref)) ?? '',
          (await scriptOf('select', tree, (await nodeAt('many')).ref)) ?? '',
        ]);
        expect(commentedStatements(drops ?? '', /^DROP TABLE /)).toHaveLength(20);
        expect(selects?.match(/^SELECT \*$/gm)).toHaveLength(20);
      },
    );

    await withLake(SETUP, async (lake) => {
      const [field, list, elementCreate, elementDrop] = await scriptsOf(lake, async (nodeAt, tree) => {
        const element = (await nodeAt('s', 'Tables', 't', 'Columns', 'tags', 'element')).ref;
        return [
          (await scriptOf(
            'drop',
            tree,
            (await nodeAt('s', 'Tables', 't', 'Columns', 'customer', 'nested', 'x')).ref,
          )) ?? '',
          (await scriptOf('drop', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'tags')).ref)) ?? '',
          await scriptOf('create', tree, element),
          await scriptOf('drop', tree, element),
        ];
      });
      // The element of a list has no name to create or drop: the menu does not offer these scripts.
      expect([elementCreate, elementDrop]).toEqual([undefined, undefined]);
      await withWriter(lake, async (writer) => {
        await writer.run(field ?? '');
        await writer.run(list ?? '');
        expect((await writer.rows(columnsOf('s', 't'))).map(([c]) => c)).toEqual([
          'id INTEGER',
          'name VARCHAR',
          'customer STRUCT("name" VARCHAR, nested STRUCT(y INTEGER))',
          'm MAP(VARCHAR, STRUCT(q INTEGER))',
          'ts TIMESTAMP',
        ]);
      });
    });

    await withLake(SETUP, async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
        (await scriptOf('drop', tree, (await nodeAt('s', 'Tables', 't', 'Partitioning')).ref)) ?? '',
        (await scriptOf('drop', tree, (await nodeAt('s', 'Tables', 't', 'Sort Order')).ref)) ?? '',
      ]);
      await withWriter(lake, async (writer) => {
        for (const script of scripts) {
          await writer.run(script);
        }
      });
      const labels = await scriptsOf(lake, async (nodeAt, tree) =>
        (await tree.children(await nodeAt('s', 'Tables', 't'))).map((node) => node.label),
      );
      expect(labels).toEqual(['Statistics', 'History', 'Columns']);
    });
  });

  it('ALTER offers statements that DuckLake understands once the placeholders are filled in, all as comments; the Tags folder offers COMMENT ON and removes the comment with NULL', async () => {
    await withLake(SETUP, async (lake) => {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
        (await scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't', 'Columns')).ref)) ?? '',
        (await scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'customer')).ref)) ?? '',
        (await scriptOf(
          'alter',
          tree,
          (await nodeAt('s', 'Tables', 't', 'Columns', 'customer', 'nested')).ref,
        )) ?? '',
        (await scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't', 'Partitioning')).ref)) ?? '',
        (await scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't', 'Sort Order')).ref)) ?? '',
      ]);
      await withWriter(lake, async (writer) => {
        for (const script of scripts) {
          expect(script.split('\n').filter((line) => line !== '' && !line.startsWith('--'))).toEqual([]);
          const statements = commentedStatements(script, /^(ALTER TABLE|COMMENT ON) /);
          expect(statements.length).toBeGreaterThan(0);
          for (const statement of statements) {
            const message = await writer.attempt(fill(statement, { ...GENERIC_FILL, '<comment>': 'c' }));
            expect(message ?? '', statement).not.toMatch(NOT_UNDERSTOOD);
          }
        }
      });
    });

    const lake = await createLake(SETUP);
    const twin = await createLake(SETUP);
    try {
      // Tags other than comments are written by other tools; DuckDB refuses to write to a lake that has such a tag on a column.
      await withWriter(lake, async (writer) => {
        const [[table]] = (await writer.rows(
          "SELECT table_id FROM __ducklake_metadata_lake.ducklake_table WHERE table_name = 't'",
        )) as [[string]];
        const [[column]] = (await writer.rows(
          `SELECT column_id FROM __ducklake_metadata_lake.ducklake_column WHERE table_id = ${table} AND column_name = 'name'`,
        )) as [[string]];
        await writer.run(
          `INSERT INTO __ducklake_metadata_lake.ducklake_tag VALUES (${table}, 1, NULL, 'owner', 'team')`,
        );
        await writer.run(
          `INSERT INTO __ducklake_metadata_lake.ducklake_column_tag VALUES (${table}, ${column}, 1, NULL, 'pii', 'yes')`,
        );
      });
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
        (await scriptOf('alter', tree, (await nodeAt('s', 'Tables', 't', 'Tags')).ref)) ?? '',
        (await scriptOf('drop', tree, (await nodeAt('s', 'Tables', 't', 'Tags')).ref)) ?? '',
      ]);
      expect(commentedStatements(scripts[0] ?? '', /^COMMENT ON /)).toEqual([
        `COMMENT ON TABLE "s"."t" IS '<comment>';`,
        `COMMENT ON COLUMN "s"."t"."name" IS '<comment>';`,
      ]);
      expect(commentedStatements(scripts[1] ?? '', /^COMMENT ON /)).toEqual([
        'COMMENT ON TABLE "s"."t" IS NULL;',
        'COMMENT ON COLUMN "s"."t"."name" IS NULL;',
      ]);
      await withWriter(twin, async (writer) => {
        for (const script of scripts) {
          for (const statement of commentedStatements(script, /^COMMENT ON /)) {
            expect(await writer.attempt(statement), statement).toBeUndefined();
          }
          // Run as they are, the scripts change nothing.
          await writer.run(script);
        }
        await writer.run(`COMMENT ON TABLE s.t IS 'hello'`);
        await writer.run(commentedStatements(scripts[1] ?? '', /^COMMENT ON TABLE /).join('\n'));
        expect(await writer.rows("SELECT comment FROM duckdb_tables() WHERE table_name = 't'")).toEqual([
          [null],
        ]);
      });
    } finally {
      await lake.remove();
      await twin.remove();
    }
  });

  it('SELECT runs for every node that has one and returns what the node stands for, also at an older snapshot and for a change', async () => {
    await withLake(SETUP, async (lake) => {
      const nodes = await allNodes(lake);
      const text = (...path: string[]): string => {
        const node = nodes.find((candidate) => candidate.path.join('/') === path.join('/'));
        return node?.texts.select ?? '';
      };
      await withWriter(lake, async (writer) => {
        const last = async (...path: string[]): Promise<unknown[][]> =>
          (await writer.results(text(...path))).at(-1) ?? [];
        expect(await last('s', 'Tables', 't', 'Columns', 'customer', 'nested', 'y')).toEqual([[2]]);
        expect(await last('s', 'Tables', 't', 'Columns', 'name')).toEqual([['a']]);
        // The element of a list is not addressable by name: the script selects the list.
        expect(await last('s', 'Tables', 't', 'Columns', 'tags', 'element')).toEqual([[[1]]]);
        expect(await last('s', 'Tables', 't', 'Columns')).toHaveLength(1);
        expect(await last('s', 'Tables', 't')).toHaveLength(1);
        for (const folder of ['Partitioning', 'Sort Order']) {
          expect(await last('s', 'Tables', 't', folder), folder).toHaveLength(1);
        }
        expect(await last('s', 'Views', 'v')).toEqual([[1, 'a']]);
        expect(await last('s', 'Macros', 'zero')).toEqual([[42]]);
        // A list of queries: one result for each table, then one for each view.
        expect((await writer.results(text('s', 'Tables'))).map((rows) => rows.length)).toEqual([1]);
        expect(await writer.results(text('s', 'Views'))).toEqual([[[1, 'a']]]);
        expect((await writer.results(text('s'))).map((rows) => rows.length)).toEqual([1, 1]);
        expect(await writer.results(text('empty_schema'))).toEqual([]);
        // The calls that need no argument run; the others are comments.
        expect(await writer.results(text('s', 'Macros'))).toEqual([[[42]]]);
        expect(text('s', 'Macros', 'f')).toContain(
          'SELECT "s"."f"(<arg1>);\n-- SELECT "s"."f"(<arg1>, <arg2>, <arg3>);',
        );
        // The statistics: the table, its files, the number of rows.
        const statistics = await writer.results(text('s', 'Tables', 't', 'Statistics'));
        expect(statistics.map((rows) => rows.length)).toEqual([1, 1, 1]);
        expect(statistics[2]).toEqual([['1']]);
        expect((await last('s', 'Tables', 't', 'History')).length).toBeGreaterThan(0);
        expect(await last('Snapshots', '@2')).toHaveLength(1);
        // The catalog: the schemas, tables, views, macros and snapshots that the lake has.
        const [schemas, tables, views, macros, snapshots] = await writer.results(text());
        expect(schemas).toEqual([['empty_schema'], ['main'], ['s']]);
        expect(tables).toEqual([['s', 't']]);
        expect(views).toEqual([['s', 'v']]);
        expect(macros).toEqual([
          ['s', 'f', 'macro'],
          ['s', 'tm', 'table_macro'],
          ['s', 'zero', 'macro'],
        ]);
        expect(snapshots).toHaveLength(11);
        expect(await last('Snapshots')).toHaveLength(11);
      });
    });

    await withLake(
      [
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (a INTEGER)',
        'INSERT INTO s.t VALUES (1)',
        'INSERT INTO s.t VALUES (2)',
      ],
      async (lake) => {
        // The tree shows an older snapshot: the table, the statistics and the files are read through time travel.
        const scripts = await scriptsOf(lake, async (nodeAt, tree) => {
          tree.selectSnapshot('lake', 3);
          return [
            (await scriptOf('select', tree, (await nodeAt('s', 'Tables', 't')).ref)) ?? '',
            (await scriptOf('select', tree, (await nodeAt('s', 'Tables', 't', 'Statistics')).ref)) ?? '',
            (await scriptOf('select', tree, (await nodeAt('s')).ref)) ?? '',
          ];
        });
        expect(scripts[0]).toContain('AT (VERSION => 3)');
        expect(scripts[1]).toContain('snapshot_version => 3');
        expect(scripts[1]).toContain('AT (VERSION => 3)');
        await withWriter(lake, async (writer) => {
          expect((await writer.results(scripts[0] ?? '')).at(-1)).toEqual([[1]]);
          expect((await writer.results(scripts[1] ?? '')).at(-1)).toEqual([['1']]);
          expect((await writer.results(scripts[2] ?? '')).at(-1)).toEqual([[1]]);
        });
      },
    );

    await withLake(
      [
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (a INTEGER)',
        'INSERT INTO s.t VALUES (1), (2)',
        'DELETE FROM s.t WHERE a = 1',
      ],
      async (lake) => {
        const script = await scriptsOf(lake, async (nodeAt, tree) => {
          const changes = await tree.children(await nodeAt('Snapshots', '@4'));
          const change = changes.find((node) => node.ref.kind === 'detail' && node.ref.change !== undefined);
          return change && scriptOf('select', tree, change.ref);
        });
        expect(script).toContain("ducklake_table_changes('lake', 's', 't', 4, 4)");
        await withWriter(lake, async (writer) => {
          const rows = (await writer.results(script as string)).at(-1) ?? [];
          expect(rows.map((row) => row.slice(2))).toEqual([['delete', 1]]);
        });
      },
    );
  });

  it('keeps hostile names inside their identifiers in every script of every node: no script drops anything else', async () => {
    const names = [
      'hx"; DROP TABLE victim; --',
      'hy\nline_two -- c',
      '/* hz */ w',
      'hw\r\n-- DROP TABLE victim;\r\nw',
      "zq'z'q",
    ];
    const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
    const literal = (name: string): string => `'${name.replaceAll("'", "''")}'`;
    await withLake(
      [
        'CREATE TABLE victim (a INTEGER)',
        ...names.flatMap((name, index) => [
          `CREATE SCHEMA ${q(name)}`,
          `CREATE TABLE ${q(name)}.${q(names[(index + 1) % names.length] ?? '')} (${q(names[(index + 2) % names.length] ?? '')} INTEGER, st STRUCT(${q(name)} INTEGER))`,
          `CREATE VIEW ${q(name)}.${q(names[(index + 2) % names.length] ?? '')} AS SELECT 1 AS a`,
          `CREATE MACRO ${q(name)}.${q(names[index] ?? '')}(${q(names[(index + 1) % names.length] ?? '')}) AS 1`,
        ]),
      ],
      async (lake) => {
        const nodes = await allNodes(lake);
        expect(nodes.length).toBeGreaterThan(60);
        await withWriter(lake, async (writer) => {
          for (const { path, kind, texts } of nodes) {
            for (const verb of VERBS) {
              const text = texts[verb];
              if (text === undefined) {
                continue;
              }
              // Take the names away, as identifiers (also in a commented statement, where each line has its own mark) and as
              // strings: whatever is left, the words of the comments included, holds nothing of them.
              const rest = names.reduce(
                (remaining, name) =>
                  [q(name), literal(name)]
                    .flatMap((form) => [form, form.replaceAll('\n', '\n-- ')])
                    .reduce((result, form) => result.replaceAll(form, ''), remaining),
                text,
              );
              for (const name of names) {
                expect(rest, `${verb} of ${path.join('/')} (${kind})`).not.toContain(name.slice(0, 2));
              }
              const message = await writer.attempt(
                fill(text, { ...GENERIC_FILL, '<comment>': 'c', '<arg1>': '1' }),
              );
              expect(message ?? '', `${verb} of ${path.join('/')}`).not.toMatch(/Parser Error/);
            }
          }
          // Whatever ran was rolled back, and the table the names try to drop is still there.
          expect(
            await writer.rows("SELECT table_name FROM duckdb_tables() WHERE table_name = 'victim'"),
          ).toEqual([['victim']]);
        });
      },
    );
  });

  it('asks to connect again for the scripts that need the catalog once the connection is closed, and still writes the others', async () => {
    await withLake(SETUP, async (lake) => {
      await scriptsOf(lake, async (nodeAt, tree) => {
        const refs = {
          connection: (await nodeAt()).ref,
          schema: (await nodeAt('s')).ref,
          table: (await nodeAt('s', 'Tables', 't')).ref,
          history: (await nodeAt('s', 'Tables', 't', 'History')).ref,
          folder: (await nodeAt('s', 'Tables')).ref,
        };
        await tree.disconnect('lake');
        const closed = { code: 'CONNECTION_FAILED' };
        await expect(async () => scriptOf('create', tree, refs.connection)).rejects.toMatchObject(closed);
        await expect(async () => scriptOf('drop', tree, refs.connection)).rejects.toMatchObject(closed);
        await expect(async () => scriptOf('select', tree, refs.schema)).rejects.toMatchObject(closed);
        await expect(async () => scriptOf('alter', tree, refs.table)).rejects.toMatchObject(closed);
        await expect(async () => scriptOf('select', tree, refs.history)).rejects.toMatchObject(closed);
        // The scripts of a folder and the templates of a schema need no catalog.
        expect(await scriptOf('drop', tree, refs.folder)).toContain('-- DROP TABLE "s"."t";');
        expect(await scriptOf('create', tree, refs.schema)).toContain('CREATE TABLE "s"."new_table"');
      });
    });
  });
});
