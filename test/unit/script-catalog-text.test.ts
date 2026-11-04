import { describe, expect, it } from 'vitest';
import { addColumnDdl } from '../../src/catalog/ddl';
import type { ColumnInfo, MacroInfo, SchemaInfo, TableInfo } from '../../src/catalog/model';
import { scriptOf } from '../../src/script-templates';
import { COMMENTED_OUT_NOTE, createWithDrop, READ_ALL_NOTE } from '../support/scripts';

// Catalog text that is copied into a statement as it is (a macro body, a default, a type) must not be able to end the
// statement, start another one or hide the rest: when it holds `;`, `--` or `/*`, the statement is a comment. The same
// scripts run against a real DuckLake in script-catalog-text-lake.test.ts.

const schema: SchemaInfo = { id: 1, name: 's', comment: null };
const table: TableInfo = {
  id: 3,
  schemaId: 1,
  name: 't',
  comment: null,
  stats: { rows: 0, files: 0, sizeBytes: 0 },
};

const column = (name: string, type: string, more: Partial<ColumnInfo> = {}): ColumnInfo => ({
  id: 1,
  name,
  type,
  nullable: true,
  defaultValue: null,
  comment: null,
  children: [],
  ...more,
});

const treeOf = (columns: ColumnInfo[] = [], partitioning?: unknown, sortOrder?: unknown) =>
  ({
    state: () => ({ status: 'connected', snapshot: 'latest', latestSnapshot: 20 }),
    reader: () => ({
      columns: () => Promise.resolve(columns),
      partitioning: () => Promise.resolve(partitioning),
      sortOrder: () => Promise.resolve(sortOrder),
      metadata: () => Promise.resolve([]),
    }),
  }) as never;

const live = (script: string | undefined): string[] =>
  (script ?? '').split(/\r\n|\r|\n/).filter((line) => line !== '' && !line.startsWith('--'));

const macroRef = (sql: string, parameter: { type: string | null; defaultValue: string | null }): never =>
  ({
    kind: 'macro',
    connectionId: 'c',
    schema,
    macro: {
      id: 1,
      schemaId: 1,
      name: 'm',
      kind: 'scalar',
      implementations: [{ dialect: 'duckdb', sql, parameters: [{ name: 'x', ...parameter }] }],
    } satisfies MacroInfo,
  }) as never;

const tableRef = (comment: string | null = null) =>
  ({ kind: 'table', connectionId: 'c', schema, table: { ...table, comment } }) as never;
const columnRef = (c: ColumnInfo, path = [c.name]) =>
  ({ kind: 'column', connectionId: 'c', schema, table, column: c, path }) as never;

describe('the script of a macro', () => {
  it('writes the statement as a comment, with the notes, when a default, the body or a parameter type can break out of it, every line of a body with line breaks', async () => {
    const defaultValue = '2); DROP TABLE victim; SELECT (1';
    const ref = macroRef('(x + y)', { type: null, defaultValue });
    const statement = `CREATE OR REPLACE MACRO "s"."m"("x" := ${defaultValue}) AS (x + y);`;
    expect(await scriptOf('create', treeOf(), ref)).toBe(
      createWithDrop('DROP MACRO "s"."m";', `-- ${statement}`, READ_ALL_NOTE, COMMENTED_OUT_NOTE),
    );
    expect(await scriptOf('alter', treeOf(), ref)).toBe(
      [
        '-- Edit the macro, then run the statement in a read/write SQL session to replace it. The statement holds all its overloads.',
        READ_ALL_NOTE,
        COMMENTED_OUT_NOTE,
        `-- ${statement}`,
        '-- Drop the macro',
        '-- DROP MACRO "s"."m";',
      ].join('\n'),
    );

    const hostile: [sql: string, parameter: { type: string | null; defaultValue: string | null }][] = [
      ['(x + y)', { type: null, defaultValue: "2 -- ' DROP TABLE victim" }],
      ['(x + y)', { type: null, defaultValue: '2 /* DROP TABLE victim */' }],
      ['1; DROP TABLE victim', { type: null, defaultValue: null }],
      ['1 -- x', { type: null, defaultValue: null }],
      ['1 /* x */', { type: null, defaultValue: null }],
      ['1', { type: 'foo; DROP TABLE victim', defaultValue: null }],
      ['1;\r\nDROP TABLE victim;\nSELECT 2', { type: null, defaultValue: null }],
    ];
    for (const [sql, parameter] of hostile) {
      const name = JSON.stringify([sql, parameter]);
      const create = (await scriptOf('create', treeOf(), macroRef(sql, parameter))) ?? '';
      expect(live(create), name).toEqual([]);
      expect(create, name).toContain(COMMENTED_OUT_NOTE);
      expect(live(await scriptOf('alter', treeOf(), macroRef(sql, parameter))), name).toEqual([]);
      // Taking the comment marks away gives the statement back unchanged, line breaks included.
      expect(create.replaceAll(/^-- /gm, ''), name).toContain(`AS ${sql};`);
    }
  });

  it('leaves a harmless macro as it is: live, without a note', async () => {
    expect(
      await scriptOf('create', treeOf(), macroRef('(x + 1)', { type: 'int32', defaultValue: '2' })),
    ).toBe(
      createWithDrop('DROP MACRO "s"."m";', 'CREATE OR REPLACE MACRO "s"."m"("x" INTEGER := 2) AS (x + 1);'),
    );
  });
});

describe('the script of a table or a column', () => {
  const DEFAULT = '1, "z" INTEGER); DROP TABLE victim; CREATE TABLE "q" ("a" INTEGER';
  const EXPRESSION_NOTE =
    '-- DuckLake adds a column with a literal default only: the default is set after the column is added and applies to new rows.';

  it('writes CREATE TABLE and ADD COLUMN as comments when a default or a type can break out of the statement, also below a struct, a list or a map', async () => {
    const create = await scriptOf(
      'create',
      treeOf([column('a', 'int32', { defaultValue: DEFAULT })]),
      tableRef(),
    );
    expect(create).toBe(
      createWithDrop(
        'DROP TABLE "s"."t";',
        `-- CREATE TABLE "s"."t" (\n--   "a" INTEGER DEFAULT ${DEFAULT}\n-- );`,
        READ_ALL_NOTE,
        COMMENTED_OUT_NOTE,
      ),
    );
    const added = await scriptOf(
      'create',
      treeOf(),
      columnRef(column('a', 'int32', { defaultValue: DEFAULT })),
    );
    expect(added).toBe(
      createWithDrop(
        'ALTER TABLE "s"."t" DROP COLUMN "a";',
        [
          '-- ALTER TABLE "s"."t" ADD COLUMN "a" INTEGER;',
          `-- ALTER TABLE "s"."t" ALTER COLUMN "a" SET DEFAULT ${DEFAULT};`,
        ].join('\n'),
        EXPRESSION_NOTE,
        READ_ALL_NOTE,
        COMMENTED_OUT_NOTE,
      ),
    );

    const unknown = column('x', 'foo; DROP TABLE victim');
    const hostile: [name: string, columns: ColumnInfo[]][] = [
      ['a line comment in a default', [column('a', 'varchar', { defaultValue: "'a' -- x" })]],
      ['a block comment in a default', [column('a', 'varchar', { defaultValue: "'a' /* x */" })]],
      ['a semicolon in a literal default', [column('a', 'varchar', { defaultValue: "'x; y'" })]],
      ['an unknown type with a semicolon', [unknown]],
      ...['struct', 'list', 'map'].map((type): [string, ColumnInfo[]] => [
        `an unknown type below a ${type}`,
        [column('c', type, { children: [column('a', 'int32'), unknown] })],
      ]),
    ];
    for (const [name, columns] of hostile) {
      expect(live(await scriptOf('create', treeOf(columns), tableRef())), name).toEqual([]);
      const [first] = columns;
      if (first) {
        expect(live(await scriptOf('create', treeOf(), columnRef(first))), name).toEqual([]);
      }
    }
    expect(await scriptOf('create', treeOf(), columnRef(unknown, ['c', 'x']))).toContain(
      '\n-- ALTER TABLE "s"."t" ADD COLUMN "c"."x" foo; DROP TABLE victim;',
    );
  });

  it('writes CREATE TABLE as it is for plain defaults and types, with the layout and the comments as commented statements after it, and adds a plain column live with the notes DuckLake needs', async () => {
    const columns = [
      column('id', 'int32', { defaultValue: '1', nullable: false, comment: "the 'key'" }),
      column('b', 'varchar', { defaultValue: "'it''s'" }),
      column('ts', 'timestamp', { defaultValue: 'now()' }),
    ];
    const partitioning = {
      id: 1,
      beginSnapshot: 1,
      endSnapshot: null,
      columns: [{ columnId: 2, path: ['ts'], transform: 'year' }],
    };
    const sortOrder = {
      id: 1,
      beginSnapshot: 1,
      endSnapshot: null,
      expressions: [{ expression: 'id', dialect: 'duckdb', direction: 'DESC', nullOrder: 'NULLS_LAST' }],
    };
    expect(
      await scriptOf('create', treeOf(columns, partitioning, sortOrder), tableRef('line one\nline two')),
    ).toBe(
      createWithDrop(
        'DROP TABLE "s"."t";',
        [
          'CREATE TABLE "s"."t" (\n  "id" INTEGER DEFAULT 1 NOT NULL,\n  "b" VARCHAR DEFAULT \'it\'\'s\',\n  "ts" TIMESTAMP DEFAULT now()\n);',
          '-- The partitioning, the sort order and the comments of the table',
          '-- ALTER TABLE "s"."t" SET PARTITIONED BY (year("ts"));',
          '-- ALTER TABLE "s"."t" SET SORTED BY (id DESC NULLS LAST);',
          '-- COMMENT ON TABLE "s"."t" IS \'line one\n-- line two\';',
          '-- COMMENT ON COLUMN "s"."t"."id" IS \'the \'\'key\'\'\';',
        ].join('\n'),
      ),
    );
    expect(await scriptOf('create', treeOf([column('a', 'int32')]), tableRef())).toBe(
      createWithDrop('DROP TABLE "s"."t";', 'CREATE TABLE "s"."t" (\n  "a" INTEGER\n);'),
    );
    const nested = { ...partitioning, columns: [{ columnId: 2, path: ['a', 'b'], transform: 'identity' }] };
    expect(await scriptOf('create', treeOf([column('a', 'int32')], nested), tableRef())).toContain(
      '\n-- This partitioning cannot be written as a statement (a nested column, or an expression or transform that is not plain).',
    );

    expect(
      await scriptOf(
        'create',
        treeOf(),
        columnRef(column('d', 'timestamp', { defaultValue: 'now()', nullable: false })),
      ),
    ).toBe(
      [
        EXPRESSION_NOTE,
        '-- NOT NULL is left out: the rows that exist have no value for the column.',
        '-- To drop it before it is created again, remove the "-- " of the next line.',
        '-- ALTER TABLE "s"."t" DROP COLUMN "d";',
        'ALTER TABLE "s"."t" ADD COLUMN "d" TIMESTAMP;',
        'ALTER TABLE "s"."t" ALTER COLUMN "d" SET DEFAULT now();',
      ].join('\n'),
    );
  });
});

describe('the statements that add a column', () => {
  const add = (c: ColumnInfo, path = [c.name]) => addColumnDdl('s', 't', path, c);
  const EXPRESSION_NOTE =
    '-- DuckLake adds a column with a literal default only: the default is set after the column is added and applies to new rows.';

  it('tell a literal default, which goes into the ADD COLUMN with NOT NULL, from an expression, which is set afterwards without NOT NULL; a struct field gets its type only', () => {
    for (const defaultValue of ['1', '-1.5', '1000.0', "'a'", "'it''s'", 'true', 'NULL', '1e3']) {
      expect(add(column('a', 'int32', { defaultValue, nullable: false })), defaultValue).toEqual({
        statements: [`ALTER TABLE "s"."t" ADD COLUMN "a" INTEGER DEFAULT ${defaultValue} NOT NULL;`],
        notes: [],
      });
    }
    expect(add(column('a', 'int32'))).toEqual({
      statements: ['ALTER TABLE "s"."t" ADD COLUMN "a" INTEGER;'],
      notes: [],
    });
    for (const defaultValue of ['now()', '1 + 1', 'x + 1', "'a' || 'b'", 'NULLIF(1, 2)', 'true AND false']) {
      expect(add(column('a', 'int32', { defaultValue })), defaultValue).toEqual({
        statements: [
          'ALTER TABLE "s"."t" ADD COLUMN "a" INTEGER;',
          `ALTER TABLE "s"."t" ALTER COLUMN "a" SET DEFAULT ${defaultValue};`,
        ],
        notes: [EXPRESSION_NOTE],
      });
    }
    expect(add(column('d', 'int32', { defaultValue: '(1 + 1)', nullable: false })).notes).toEqual([
      EXPRESSION_NOTE,
      '-- NOT NULL is left out: the rows that exist have no value for the column.',
    ]);
    expect(add(column('a', 'int32', { nullable: false }))).toEqual({
      statements: ['ALTER TABLE "s"."t" ADD COLUMN "a" INTEGER NOT NULL;'],
      notes: ['-- DuckLake adds a NOT NULL column without a default only to a table without rows.'],
    });
    expect(add(column('f', 'int32', { defaultValue: 'now()', nullable: false }), ['c', 'f'])).toEqual({
      statements: ['ALTER TABLE "s"."t" ADD COLUMN "c"."f" INTEGER;'],
      notes: [],
    });
  });
});
