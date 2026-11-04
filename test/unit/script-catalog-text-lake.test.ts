import { describe, expect, it } from 'vitest';
import { scriptOf } from '../../src/script-templates';
import { createLake, engineSkipReason } from './data-support';
import type { Lake } from './data-support';
import { scriptsOf, withWriter } from './script-support';
import type { Writer } from './script-support';

const skipReason = await engineSkipReason();
if (skipReason) {
  console.warn(`The script tests against a real DuckLake are skipped: ${skipReason}`);
}

const METADATA = '__ducklake_metadata_lake';

const live = (script: string | undefined): string[] =>
  (script ?? '').split(/\r\n|\r|\n/).filter((line) => line !== '' && !line.startsWith('--'));

/** Everything that exists in the lake and a script could create, change or drop, as one sorted list. */
const everything = async (writer: Writer): Promise<string[]> =>
  (
    await writer.rows(`
      SELECT 'table ' || schema_name || '.' || table_name FROM duckdb_tables() WHERE database_name = 'lake'
      UNION ALL SELECT 'view ' || schema_name || '.' || view_name FROM duckdb_views() WHERE database_name = 'lake' AND NOT internal
      UNION ALL SELECT function_type || ' ' || schema_name || '.' || function_name FROM duckdb_functions()
        WHERE database_name = 'lake' AND function_type IN ('macro', 'table_macro')
      UNION ALL SELECT 'column ' || table_name || '.' || column_name FROM duckdb_columns() WHERE database_name = 'lake'
      ORDER BY 1`)
  )
    .map(([name]) => String(name))
    .toSorted();

describe.skipIf(skipReason !== undefined)(
  'catalog text that can break out of its statement, run by a real DuckLake',
  () => {
    // DuckDB parses the macros and the column defaults of a lake when it loads it, so a text with a second statement in
    // them ends every session on that lake; the text of a view is parsed when the view is used. The text here is what
    // DuckDB still loads: comment marks, and a second statement in a view. It was written the way another writer of the
    // metadata could write it.
    const VIEW_SQL = 'SELECT 1 AS x; DROP TABLE victim';

    it('stays a comment in every script that copies it, so that running the script changes nothing', async () => {
      const lake = await createLake([
        'CREATE TABLE victim (a INTEGER)',
        'CREATE SCHEMA s',
        'CREATE TABLE s.t (a INTEGER, b INTEGER DEFAULT 5, c INTEGER)',
        'CREATE VIEW s.v AS SELECT 1 AS x',
        'CREATE MACRO s.m(x, y := 2) AS x + y',
        'CREATE MACRO s.tm(x) AS TABLE SELECT x AS answer',
      ]);
      try {
        await withWriter(lake, async (writer) => {
          const edit = (table: string, set: string, where: string): Promise<void> =>
            writer.run(`UPDATE ${METADATA}.${table} SET ${set} WHERE ${where}`);
          await edit(
            'ducklake_macro_parameters',
            "default_value = '2 -- c', default_value_type = 'expression'",
            "parameter_name = 'y'",
          );
          await edit('ducklake_macro_impl', "sql = 'x + /* c */ y'", "type = 'scalar'");
          await edit('ducklake_macro_impl', "sql = 'SELECT x AS answer -- c'", "type = 'table'");
          await edit(
            'ducklake_column',
            "default_value = '5 -- c', default_value_type = 'expression'",
            "column_name = 'b'",
          );
          await edit('ducklake_view', `sql = '${VIEW_SQL}'`, "view_name = 'v'");
        });
        const scripts = await scriptsOf(lake, async (nodeAt, tree) => {
          const refs = {
            macro: (await nodeAt('s', 'Macros', 'm')).ref,
            tableMacro: (await nodeAt('s', 'Macros', 'tm')).ref,
            table: (await nodeAt('s', 'Tables', 't')).ref,
            column: (await nodeAt('s', 'Tables', 't', 'Columns', 'b')).ref,
            view: (await nodeAt('s', 'Views', 'v')).ref,
          };
          const make = async (verb: 'create' | 'alter', ref: keyof typeof refs) =>
            (await scriptOf(verb, tree, refs[ref])) ?? '';
          return {
            macro: await make('create', 'macro'),
            macroAlter: await make('alter', 'macro'),
            tableMacro: await make('create', 'tableMacro'),
            table: await make('create', 'table'),
            column: await make('create', 'column'),
            view: await make('create', 'view'),
            viewAlter: await make('alter', 'view'),
          };
        });
        expect(scripts.macro).toContain(
          '\n-- CREATE OR REPLACE MACRO "s"."m"("x", "y" := 2 -- c) AS x + /* c */ y;',
        );
        expect(scripts.table).toContain('"b" INTEGER DEFAULT 5 -- c,');
        expect(scripts.view).toContain(`AS ${VIEW_SQL};`);
        await withWriter(lake, async (writer) => {
          const before = await everything(writer);
          for (const [name, script] of Object.entries(scripts)) {
            expect(live(script), name).toEqual([]);
            await writer.run(script);
          }
          expect(await everything(writer), 'running the scripts as they are changes nothing').toEqual(before);
          expect(before).toContain('table main.victim');

          // Without the comment marks the view script would have dropped the table: that is what they are for.
          await writer.run('DROP VIEW s.v');
          await writer.run(scripts.view.replace(/^-- (CREATE VIEW)/m, '$1'));
          expect(await everything(writer)).not.toContain('table main.victim');
        });
      } finally {
        await lake.remove();
      }
    });
  },
);

describe.skipIf(skipReason !== undefined)('the script that adds a column, run by a real DuckLake', () => {
  const SETUP = [
    'CREATE SCHEMA s',
    "CREATE TABLE s.t (id INTEGER, d TIMESTAMP DEFAULT now(), c INTEGER DEFAULT 3 NOT NULL, w VARCHAR DEFAULT 'it''s')",
    'INSERT INTO s.t (id) VALUES (1)',
  ];

  /** The script with the drop above it uncommented: the column is dropped and added again from the catalog. */
  const redo = (script: string): string => script.replace(/^-- (ALTER TABLE .* DROP COLUMN )/m, '$1');

  it('adds a column whose default is an expression in two statements, and the default holds for new rows', async () => {
    const lake = await createLake(SETUP);
    try {
      const script = await scriptsOf(
        lake,
        async (nodeAt, tree) =>
          (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'd')).ref)) ?? '',
      );
      expect(script).toContain(
        'ALTER TABLE "s"."t" ADD COLUMN "d" TIMESTAMP;\nALTER TABLE "s"."t" ALTER COLUMN "d" SET DEFAULT now();',
      );
      await withWriter(lake, async (writer) => {
        await writer.run(redo(script));
        expect(
          await writer.rows(
            "SELECT column_default FROM duckdb_columns() WHERE database_name = 'lake' AND column_name = 'd'",
          ),
        ).toEqual([['now()']]);
        await writer.run('INSERT INTO s.t (id) VALUES (2)');
        expect(await writer.rows('SELECT id, d IS NULL FROM s.t ORDER BY id')).toEqual([
          [1, true],
          [2, false],
        ]);
      });
    } finally {
      await lake.remove();
    }
  });

  it('adds a column with a literal default and NOT NULL in one statement, to a table with rows', async () => {
    const lake = await createLake(SETUP);
    try {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
        (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'c')).ref)) ?? '',
        (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'w')).ref)) ?? '',
      ]);
      expect(scripts[0]).toContain('\nALTER TABLE "s"."t" ADD COLUMN "c" INTEGER DEFAULT 3 NOT NULL;');
      await withWriter(lake, async (writer) => {
        for (const script of scripts) {
          await writer.run(redo(script));
        }
        expect(await writer.rows('SELECT id, c, w FROM s.t')).toEqual([[1, 3, "it's"]]);
      });
    } finally {
      await lake.remove();
    }
  });

  it('says that a NOT NULL column without a default needs a table without rows, and that is how DuckLake behaves', async () => {
    const lake = await createLake([
      'CREATE SCHEMA s',
      'CREATE TABLE s.t (id INTEGER NOT NULL, other INTEGER)',
      'CREATE TABLE s.u (id INTEGER NOT NULL, other INTEGER)',
      'INSERT INTO s.u VALUES (1, 1)',
    ]);
    try {
      const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
        (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Columns', 'id')).ref)) ?? '',
        (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 'u', 'Columns', 'id')).ref)) ?? '',
      ]);
      for (const script of scripts) {
        expect(script).toContain(
          '-- DuckLake adds a NOT NULL column without a default only to a table without rows.',
        );
      }
      await withWriter(lake, async (writer) => {
        await writer.run(redo(scripts[0] ?? ''));
        expect(
          await writer.rows(
            "SELECT is_nullable FROM duckdb_columns() WHERE table_name = 't' AND column_name = 'id'",
          ),
        ).toEqual([[false]]);
        expect(await writer.attempt(redo(scripts[1] ?? ''))).toMatch(/NULL values/);
      });
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason !== undefined)('the script that creates a table, run by a real DuckLake', () => {
  it('creates the table again, and with the statements for the layout and the comments uncommented, restores them', async () => {
    const lake = await createLake([
      'CREATE SCHEMA s',
      'CREATE TABLE s.t (id INTEGER NOT NULL, name VARCHAR, ts TIMESTAMP, c STRUCT(x INTEGER))',
      "COMMENT ON TABLE s.t IS 'the ''main'' table'",
      "COMMENT ON COLUMN s.t.name IS 'the name'",
      'ALTER TABLE s.t SET PARTITIONED BY (year(ts), bucket(4, id))',
      'ALTER TABLE s.t SET SORTED BY (id DESC NULLS LAST, name)',
    ]);
    try {
      const show = (): Promise<{ create: string; partitioning: string; sortOrder: string }> =>
        scriptsOf(lake, async (nodeAt, tree) => ({
          create: (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't')).ref)) ?? '',
          partitioning:
            (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Partitioning')).ref)) ?? '',
          sortOrder:
            (await scriptOf('create', tree, (await nodeAt('s', 'Tables', 't', 'Sort Order')).ref)) ?? '',
        }));
      const before = await show();
      expect(before.create).toContain(
        [
          '-- The partitioning, the sort order and the comments of the table',
          '-- ALTER TABLE "s"."t" SET PARTITIONED BY (year("ts"), bucket(4, "id"));',
          '-- ALTER TABLE "s"."t" SET SORTED BY (id DESC NULLS LAST, "name" ASC NULLS LAST);',
          `-- COMMENT ON TABLE "s"."t" IS 'the ''main'' table';`,
          `-- COMMENT ON COLUMN "s"."t"."name" IS 'the name';`,
        ].join('\n'),
      );
      await withWriter(lake, async (writer) => {
        // As it is, the table exists and the statement fails; nothing is lost.
        expect(await writer.attempt(before.create)).toMatch(/already exists/);
        await writer.run('DROP TABLE s.t');
        await writer.run(before.create);
        expect(
          await writer.rows(
            "SELECT comment FROM duckdb_tables() WHERE database_name = 'lake' AND table_name = 't'",
          ),
        ).toEqual([[null]]);
        await writer.run('DROP TABLE s.t');
        await writer.run(before.create.replace(/^-- (?!DROP|To drop|The partitioning)/gm, ''));
        expect(
          await writer.rows(
            "SELECT comment FROM duckdb_tables() WHERE database_name = 'lake' AND table_name = 't'",
          ),
        ).toEqual([["the 'main' table"]]);
      });
      expect(await show()).toEqual(before);
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason !== undefined)(
  'the template of a schema and of the Macros folder, run by a real DuckLake',
  () => {
    it('never replaces a macro of the same name: the statement fails and the macro stays', async () => {
      const lake = await createLake(['CREATE SCHEMA s', 'CREATE MACRO s.add_one(x) AS x + 100']);
      try {
        const scripts = await scriptsOf(lake, async (nodeAt, tree) => [
          (await scriptOf('create', tree, (await nodeAt('s', 'Macros')).ref)) ?? '',
          (await scriptOf('create', tree, (await nodeAt('s')).ref)) ?? '',
        ]);
        await withWriter(lake, async (writer) => {
          for (const script of scripts) {
            expect(await writer.attempt(script)).toMatch(/already exists/i);
          }
          expect(await writer.rows('SELECT s.add_one(1)')).toEqual([[101]]);
        });
      } finally {
        await lake.remove();
      }
    });
  },
);

describe.skipIf(skipReason !== undefined)('the history of a table, run by a real DuckLake', () => {
  it('returns the rows that the snapshots inserted and deleted, with the statements as the script writes them', async () => {
    const lake = await createLake([
      'CREATE SCHEMA "a\'b\'c"',
      'CREATE TABLE "a\'b\'c"."a\'b\'c" (n INTEGER)',
      'INSERT INTO "a\'b\'c"."a\'b\'c" VALUES (10), (20)',
      'INSERT INTO "a\'b\'c"."a\'b\'c" VALUES (30)',
      'DELETE FROM "a\'b\'c"."a\'b\'c" WHERE n = 20',
    ]);
    try {
      const script = await scriptsOf(
        lake,
        async (nodeAt, tree) =>
          (await scriptOf('select', tree, (await nodeAt("a'b'c", 'Tables', "a'b'c", 'History')).ref)) ?? '',
      );
      expect(script).toContain("ducklake_table_changes('lake', 'a''b''c', 'a''b''c', 0, 5)");
      await withWriter(lake, async (writer) => {
        const [changes, insertions, deletions] = await writer.results(
          script.replaceAll(/^-- (SELECT)/gm, '$1'),
        );
        const values = (rows: unknown[][] | undefined): unknown[] =>
          (rows ?? []).map((row) => row.at(-1)).toSorted();
        expect(values(insertions)).toEqual([10, 20, 30]);
        expect(values(deletions)).toEqual([20]);
        expect(changes).toHaveLength(4);
      });
    } finally {
      await lake.remove();
    }
  });
});

describe.skipIf(skipReason !== undefined)(
  'the order of the objects, in a lake that was written in reverse order',
  () => {
    it('lists schemas, tables and views by name, not in the order they were created', async () => {
      const lake: Lake = await createLake([
        'CREATE SCHEMA zeta',
        'CREATE SCHEMA alpha',
        'CREATE TABLE alpha.b (x INTEGER)',
        'CREATE TABLE alpha.a (x INTEGER)',
        'CREATE VIEW alpha.d AS SELECT 1 AS x',
        'CREATE VIEW alpha.c AS SELECT 1 AS x',
        'DROP SCHEMA main',
      ]);
      try {
        const [drop, select, create] = await scriptsOf(lake, async (nodeAt, tree) => [
          (await scriptOf('drop', tree, (await nodeAt()).ref)) ?? '',
          (await scriptOf('select', tree, (await nodeAt('alpha')).ref)) ?? '',
          (await scriptOf('create', tree, (await nodeAt()).ref)) ?? '',
        ]);
        expect(drop?.split('\n').filter((line) => line.startsWith('-- DROP'))).toEqual([
          '-- DROP SCHEMA "alpha";',
          '-- DROP SCHEMA "zeta";',
        ]);
        expect(select?.match(/^FROM .*$/gm)).toEqual([
          'FROM "alpha"."a"',
          'FROM "alpha"."b"',
          'FROM "alpha"."c"',
          'FROM "alpha"."d"',
        ]);
        expect(create).toContain('CREATE TABLE "alpha"."new_table"');
        // The session of the editor starts with alpha as the default schema, and the select runs.
        await withWriter(lake, async (writer) => {
          expect(await writer.results(select ?? '')).toHaveLength(4);
          expect(await writer.rows('SELECT current_schema()')).toEqual([['alpha']]);
        });
      } finally {
        await lake.remove();
      }
    });
  },
);
