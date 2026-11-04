import { describe, expect, it } from 'vitest';
import type {
  ColumnInfo,
  MacroInfo,
  PartitioningInfo,
  SchemaInfo,
  SortOrderInfo,
  TableInfo,
  TagsInfo,
  ViewInfo,
} from '../../src/catalog/model';
import { commented } from '../../src/script';
import { scriptOf } from '../../src/script-templates';
import type { NodeRef } from '../../src/tree/refs';

// The text of the scripts that need no engine, with a catalog that is a few objects in memory. Each statement shape is
// pinned once, written out in full: a changed word, a lost line or a different order is a failure. The same scripts run
// against a real DuckLake in script-templates-lake.test.ts.

const schema: SchemaInfo = { id: 1, name: 's', comment: null };
const table: TableInfo = {
  id: 3,
  schemaId: 1,
  name: 't',
  comment: null,
  stats: { rows: 0, files: 0, sizeBytes: 0 },
};
const view: ViewInfo = {
  id: 4,
  schemaId: 1,
  name: 'v',
  comment: null,
  dialect: 'duckdb',
  sql: 'SELECT 1',
  columnAliases: [],
};

const column = (
  name: string,
  type = 'int32',
  children: ColumnInfo[] = [],
  more: Partial<ColumnInfo> = {},
): ColumnInfo => ({
  id: 1,
  name,
  type,
  nullable: true,
  defaultValue: null,
  comment: null,
  children,
  ...more,
});

const COLUMNS = [
  column('id'),
  column('customer', 'struct', [column('name', 'varchar'), column('nested', 'struct', [column('x')])]),
  column('tags', 'list', [column('element', 'varchar')]),
  column('m', 'map', [column('key', 'varchar'), column('value', 'struct', [column('q')])]),
];

/** The reference of the node of a column, a struct field or the element, key or value of a list or map, as the tree makes it. */
function columnRef(...path: string[]): NodeRef {
  let level: readonly ColumnInfo[] = COLUMNS;
  let parent: ColumnInfo | undefined;
  let found: ColumnInfo | undefined;
  for (const name of path) {
    parent = found;
    found = level.find((candidate) => candidate.name === name);
    level = found?.children ?? [];
  }
  const member = parent !== undefined && ['list', 'map'].includes(parent.type);
  return {
    kind: 'column',
    connectionId: 'c',
    schema,
    table,
    column: found ?? column(path.at(-1) ?? ''),
    path,
    ...(member ? { member: true } : {}),
  } as never;
}

interface Catalog {
  schemas?: SchemaInfo[];
  tables?: TableInfo[];
  views?: ViewInfo[];
  columns?: ColumnInfo[];
  partitioning?: PartitioningInfo;
  sortOrder?: SortOrderInfo;
}

/** A tree that shows the newest snapshot (20) or the pinned one, and reads `catalog`. */
const treeOf = (catalog: Catalog = {}, snapshot: number | 'latest' = 'latest', fromReport?: true) =>
  ({
    state: () => ({ status: 'connected', snapshot, latestSnapshot: 20 }),
    reader: () => ({
      schemas: () => Promise.resolve(catalog.schemas ?? []),
      tables: () => Promise.resolve(catalog.tables ?? []),
      views: () => Promise.resolve(catalog.views ?? []),
      columns: () => Promise.resolve(catalog.columns ?? COLUMNS),
      partitioning: () => Promise.resolve(catalog.partitioning),
      sortOrder: () => Promise.resolve(catalog.sortOrder),
      metadata: () => Promise.resolve([]),
    }),
    ...(fromReport ? { fromReport } : {}),
  }) as never;

const folderRef = (folder: string, more: object = {}): NodeRef =>
  ({ kind: 'folder', folder, connectionId: 'c', schema, table, ...more }) as never;

const COMMENTED_OUT = [
  '-- Every statement in this script is commented out, so running it changes nothing.',
  '-- Remove the "-- " in front of the statements you want, replace the <placeholders> and run them in a read/write SQL session.',
];
const NEWEST_7 = '-- The tree shows snapshot @7; these statements act on the newest state.';

describe('commented', () => {
  it('puts a comment mark in front of every line, after LF, CRLF and CR, also inside a quoted name with line breaks', async () => {
    expect(commented('a\r\nb\nc\rd')).toBe('-- a\r\n-- b\n-- c\r-- d');

    const hostile = { id: 1, name: 'a\r\nDROP TABLE victim;\r\nb', comment: null };
    const script = await scriptOf('drop', treeOf(), {
      kind: 'schema',
      connectionId: 'c',
      schema: hostile,
    } as never);
    expect(script).toBe(
      [
        '-- Drops the schema. It must be empty: DuckLake refuses otherwise. Run it in a read/write SQL session.',
        'DROP SCHEMA "a\r\nDROP TABLE victim;\r\nb";',
        '-- Drops the schema and everything in it',
        '-- DROP SCHEMA "a\r\n-- DROP TABLE victim;\r\n-- b" CASCADE;',
      ].join('\n'),
    );
  });
});

describe('SELECT of a column', () => {
  const select = (ref: NodeRef, snapshot: number | 'latest' = 'latest') =>
    scriptOf('select', treeOf({}, snapshot), ref);
  const NOTE =
    '-- The element of a list and the key and value of a map cannot be selected by name; this selects the column that holds it.';

  it('selects a column and a struct field by their path, the column of a view, and the table for the folders that have no query of their own', async () => {
    expect(await select(columnRef('id'))).toBe('SELECT "id"\nFROM "s"."t"\nLIMIT 1000;');
    expect(await select(columnRef('customer', 'nested', 'x'), 7)).toBe(
      '-- Time travel to snapshot 7\nSELECT "customer"."nested"."x"\nFROM "s"."t" AT (VERSION => 7)\nLIMIT 1000;',
    );

    const viewColumn = {
      kind: 'viewColumn',
      connectionId: 'c',
      schema,
      view,
      column: { name: 'a', type: 'INTEGER', nullable: true },
    } as never;
    expect(await select(viewColumn)).toBe('SELECT\n  "a"\nFROM "s"."v"\nLIMIT 1000;');
    expect(
      await select({ kind: 'folder', folder: 'viewColumns', connectionId: 'c', schema, view } as never),
    ).toBe('SELECT *\nFROM "s"."v"\nLIMIT 1000;');

    const expected = 'SELECT\n  "id",\n  "customer",\n  "tags",\n  "m"\nFROM "s"."t"\nLIMIT 1000;';
    const tags: TagsInfo = { table: [], columns: [] };
    for (const folder of [
      { folder: 'partitioning', partitioning: { id: 1, beginSnapshot: 1, endSnapshot: null, columns: [] } },
      { folder: 'sortOrder', sortOrder: { id: 1, beginSnapshot: 1, endSnapshot: null, expressions: [] } },
      { folder: 'tags', tags },
    ]) {
      expect(await select(folderRef(folder.folder, folder)), folder.folder).toBe(expected);
    }
  });

  it('selects the list or the map that holds an element, a key or a value, and says so; these members have no CREATE and no DROP', async () => {
    expect(await select(columnRef('tags', 'element'))).toBe(
      `${NOTE}\nSELECT "tags"\nFROM "s"."t"\nLIMIT 1000;`,
    );
    expect(await select(columnRef('m', 'key'))).toBe(`${NOTE}\nSELECT "m"\nFROM "s"."t"\nLIMIT 1000;`);
    expect(await select(columnRef('m', 'value', 'q'))).toBe(`${NOTE}\nSELECT "m"\nFROM "s"."t"\nLIMIT 1000;`);
    for (const ref of [columnRef('tags', 'element'), columnRef('m', 'key'), columnRef('m', 'value')]) {
      expect(scriptOf('create', treeOf(), ref)).toBeUndefined();
      expect(scriptOf('drop', treeOf(), ref)).toBeUndefined();
    }
  });
});

describe('ALTER of the Columns folder', () => {
  it('starts with the block that adds a column, then has one block for each column', async () => {
    const folder = folderRef('columns', { columns: [column('id'), column('name', 'varchar')] });
    expect(await scriptOf('alter', treeOf(), folder)).toBe(
      [
        ...COMMENTED_OUT,
        '',
        '-- Add a column',
        '-- ALTER TABLE "s"."t" ADD COLUMN <new_column> <type>;',
        '',
        '-- Column 1 of 2',
        '-- ALTER TABLE "s"."t" RENAME COLUMN "id" TO <new_name>;',
        '-- ALTER TABLE "s"."t" ALTER COLUMN "id" SET DATA TYPE <new_type>;',
        '-- ALTER TABLE "s"."t" DROP COLUMN "id";',
        `-- COMMENT ON COLUMN "s"."t"."id" IS '<comment>';`,
        '',
        '-- Column 2 of 2',
        '-- ALTER TABLE "s"."t" RENAME COLUMN "name" TO <new_name>;',
        '-- ALTER TABLE "s"."t" ALTER COLUMN "name" SET DATA TYPE <new_type>;',
        '-- ALTER TABLE "s"."t" DROP COLUMN "name";',
        `-- COMMENT ON COLUMN "s"."t"."name" IS '<comment>';`,
      ].join('\n'),
    );
    expect(await scriptOf('alter', treeOf({}, 7), folder)).toContain(`\n${NEWEST_7}\n\n-- Add a column\n`);
  });
});

describe('ALTER of the Partitioning and the Sort Order folder', () => {
  it('explains the statements with the transforms and an example, all as comments', () => {
    const partitioning = folderRef('partitioning', {
      partitioning: { id: 1, beginSnapshot: 1, endSnapshot: null, columns: [] },
    });
    expect(scriptOf('alter', treeOf(), partitioning)).toBe(
      [
        ...COMMENTED_OUT,
        '-- Sets the partitioning. New data is written partitioned by the key; the files that exist keep their layout. The transforms are identity, year, month, day, hour and bucket(N, column).',
        '',
        '-- ALTER TABLE "s"."t" SET PARTITIONED BY (year(<column>), <column>);',
        '-- Removes it',
        '-- ALTER TABLE "s"."t" RESET PARTITIONED BY;',
      ].join('\n'),
    );

    const sortOrder = folderRef('sortOrder', {
      sortOrder: {
        id: 1,
        beginSnapshot: 1,
        endSnapshot: null,
        expressions: [{ expression: 'id', dialect: 'duckdb', direction: 'ASC', nullOrder: 'NULLS_LAST' }],
      },
    });
    expect(scriptOf('alter', treeOf(), sortOrder)).toBe(
      [
        ...COMMENTED_OUT,
        '-- Sets the sort order. New data is written sorted by the key; the files that exist keep their layout.',
        '',
        '-- ALTER TABLE "s"."t" SET SORTED BY (<column> ASC NULLS FIRST, <column> DESC NULLS LAST);',
        '-- Removes it',
        '-- ALTER TABLE "s"."t" RESET SORTED BY;',
      ].join('\n'),
    );
  });
});

describe('the Tags folder', () => {
  const TAGS_NOTE =
    '-- DuckLake has no SQL statement for tags other than the comment. COMMENT ON sets the comment of the table and of a column; the other tags can only be changed in the catalog.';
  const tags: TagsInfo = {
    table: [{ key: 'owner', value: 'team' }],
    columns: [
      { columnId: 2, path: ['name'], key: 'pii', value: 'yes' },
      { columnId: 2, path: ['name'], key: 'class', value: 'a' },
      { columnId: 5, path: ['customer', 'name'], key: 'pii', value: 'no' },
      { columnId: 6, path: ['b"y'], key: 'k', value: 'v' },
    ],
  };
  const ref = folderRef('tags', { tags });

  it('offers COMMENT ON for the table and once for each top-level column with tags, and removes the comment with NULL', async () => {
    expect(await scriptOf('alter', treeOf(), ref)).toBe(
      [
        ...COMMENTED_OUT,
        TAGS_NOTE,
        '',
        `-- COMMENT ON TABLE "s"."t" IS '<comment>';`,
        `-- COMMENT ON COLUMN "s"."t"."name" IS '<comment>';`,
        `-- COMMENT ON COLUMN "s"."t"."b""y" IS '<comment>';`,
      ].join('\n'),
    );
    expect(await scriptOf('drop', treeOf({}, 7), ref)).toBe(
      [
        '-- Every statement in this script is commented out, so running it changes nothing.',
        '-- Remove the "-- " in front of the drops you want and run them in a read/write SQL session.',
        TAGS_NOTE,
        '-- NULL removes a comment; the other tags stay.',
        NEWEST_7,
        '',
        '-- COMMENT ON TABLE "s"."t" IS NULL;',
        '-- COMMENT ON COLUMN "s"."t"."name" IS NULL;',
        '-- COMMENT ON COLUMN "s"."t"."b""y" IS NULL;',
      ].join('\n'),
    );
  });
});

describe('the newest state', () => {
  it('is named above the statements that act on it while the tree shows an older snapshot, in the words of the tree or of a report, and not for the latest one', async () => {
    const ref = { kind: 'table', connectionId: 'c', schema, table } as never;
    const statistics = folderRef('statistics');
    const tree = (fromReport?: true) => treeOf({ columns: [column('id')] }, 7, fromReport);
    expect(await scriptOf('create', tree(), ref)).toBe(
      [
        '-- The tree shows snapshot @7; this statement acts on the newest state.',
        '-- To drop it before it is created again, remove the "-- " of the next line.',
        '-- DROP TABLE "s"."t";',
        'CREATE TABLE "s"."t" (\n  "id" INTEGER\n);',
      ].join('\n'),
    );
    expect(await scriptOf('alter', tree(), ref)).toContain(`\n${NEWEST_7}\n`);
    expect(await scriptOf('alter', tree(true), ref)).toContain(
      '\n-- This script was made for snapshot @7; these statements act on the newest state.\n',
    );
    expect(await scriptOf('select', tree(true), statistics)).toContain(
      '\n-- This script was made for snapshot @7; this statement acts on the newest state.\n',
    );
    expect(await scriptOf('select', treeOf({ columns: [] }, 'latest', true), statistics)).not.toContain(
      'snapshot @',
    );
    expect(
      await scriptOf('drop', treeOf({}, 7), { kind: 'schema', connectionId: 'c', schema } as never),
    ).toBe(
      [
        '-- Drops the schema. It must be empty: DuckLake refuses otherwise. Run it in a read/write SQL session.',
        NEWEST_7,
        'DROP SCHEMA "s";',
        '-- Drops the schema and everything in it',
        '-- DROP SCHEMA "s" CASCADE;',
      ].join('\n'),
    );
  });
});

describe('the literals of the statistics, the history and the changes of a table', () => {
  const NAME = "a'b'c";
  const hostile = { id: 1, name: NAME, comment: null };
  const hostileTable = { ...table, name: NAME };
  const ref = (more: object) =>
    ({ connectionId: 'c', schema: hostile, table: hostileTable, ...more }) as never;

  it('double every apostrophe of a name', async () => {
    expect(await scriptOf('select', treeOf(), ref({ kind: 'folder', folder: 'statistics' }))).toBe(
      [
        '-- Files and size of the table, as DuckLake counts them',
        "SELECT * FROM ducklake_table_info('lake') WHERE table_id = 3;",
        '',
        '-- The data files of the table',
        "SELECT * FROM ducklake_list_files('lake', 'a''b''c', schema => 'a''b''c');",
        '',
        '-- The number of rows',
        `SELECT count(*) AS row_count FROM "a'b'c"."a'b'c";`,
      ].join('\n'),
    );
    const call = (name: string) => `ducklake_table_${name}('lake', 'a''b''c', 'a''b''c', 0, 20)`;
    expect(await scriptOf('select', treeOf(), ref({ kind: 'folder', folder: 'history' }))).toBe(
      [
        '-- What the snapshots up to @20 changed in the table',
        `SELECT * FROM ${call('changes')} LIMIT 1000;`,
        '-- Only the rows that were inserted, or only those that were deleted',
        `-- SELECT * FROM ${call('insertions')} LIMIT 1000;`,
        `-- SELECT * FROM ${call('deletions')} LIMIT 1000;`,
      ].join('\n'),
    );
    const change = {
      kind: 'detail',
      connectionId: 'c',
      change: { snapshot: 5, table: { schema: NAME, table: NAME } },
    } as never;
    expect(await scriptOf('select', treeOf(), change)).toBe(
      [
        '-- What snapshot @5 changed in the table (its names at that snapshot)',
        "SELECT * FROM ducklake_table_changes('lake', 'a''b''c', 'a''b''c', 5, 5) LIMIT 1000;",
      ].join('\n'),
    );
  });
});

describe('the scripts of the connection and of a schema', () => {
  const schemas = ['zeta', 'alpha', 'mid'].map((name, index) => ({ id: index + 1, name, comment: null }));
  const tables = ['b', 'a'].map((name, index) => ({ ...table, id: index + 10, name }));
  const views = ['d', 'c'].map((name, index) => ({ ...view, id: index + 20, name }));
  const catalog = { schemas, tables, views };
  const connection = { kind: 'connection', connectionId: 'c' } as const;

  it('list the schemas by name in the DROP of the connection, the tables then the views by name in the SELECT of a schema, and say so when there is nothing', async () => {
    expect(await scriptOf('drop', treeOf(catalog), connection)).toBe(
      [
        '-- Every statement in this script is commented out, so running it changes nothing.',
        '-- Remove the "-- " in front of the drops you want and run them in a read/write SQL session.',
        '-- A schema must be empty to be dropped; add CASCADE to drop what it holds, too.',
        '',
        '-- DROP SCHEMA "alpha";',
        '-- DROP SCHEMA "mid";',
        '-- DROP SCHEMA "zeta";',
      ].join('\n'),
    );
    expect(await scriptOf('drop', treeOf(), connection)).toBe('-- The catalog has no schemas.');
    expect(await scriptOf('select', treeOf(catalog), { kind: 'schema', connectionId: 'c', schema })).toBe(
      [
        '-- A query over each table, then each view of this schema.',
        '',
        ...['a', 'b', 'c', 'd'].flatMap((name, index) => [
          ...(index > 0 ? [''] : []),
          'SELECT *',
          `FROM "s"."${name}"`,
          'LIMIT 1000;',
        ]),
      ].join('\n'),
    );
  });

  it('list the objects and the newest snapshots of the lake attached as "lake" in the SELECT of the connection and of the Snapshots folder', async () => {
    expect(await scriptOf('select', treeOf(), connection)).toBe(
      [
        '-- The SQL editor of aantje attaches the lake as "lake", so the statements below use that name.',
        '-- The schemas',
        "SELECT schema_name FROM duckdb_schemas() WHERE database_name = 'lake' ORDER BY schema_name;",
        '',
        '-- The tables',
        "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = 'lake' ORDER BY schema_name, table_name;",
        '',
        '-- The views',
        "SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = 'lake' AND NOT internal ORDER BY schema_name, view_name;",
        '',
        '-- The macros',
        "SELECT DISTINCT schema_name, function_name, function_type FROM duckdb_functions() WHERE database_name = 'lake' AND function_type IN ('macro', 'table_macro') ORDER BY schema_name, function_name;",
        '',
        '-- The newest snapshots',
        "SELECT * FROM ducklake_snapshots('lake') ORDER BY snapshot_id DESC LIMIT 50;",
      ].join('\n'),
    );
    expect(
      await scriptOf('select', treeOf(), { kind: 'folder', folder: 'snapshots', connectionId: 'c' }),
    ).toBe(
      [
        '-- The newest snapshots of the lake, with what each one changed',
        "SELECT * FROM ducklake_snapshots('lake') ORDER BY snapshot_id DESC LIMIT 50;",
      ].join('\n'),
    );
  });
});

describe('the SELECT of a macro and of the Macros folder', () => {
  const macro = (
    name: string,
    kind: MacroInfo['kind'],
    ...parameters: { name: string; defaultValue: string | null }[]
  ): MacroInfo => ({
    id: 1,
    schemaId: 1,
    name,
    kind,
    implementations: [
      {
        dialect: 'duckdb',
        sql: '1',
        parameters: parameters.map((parameter) => ({ type: null, ...parameter })),
      },
    ],
  });

  it('limits the call of a table macro like the query of a table; the folder calls the first overload of each macro, a call that needs arguments as a comment', async () => {
    const tableMacro = {
      kind: 'macro',
      connectionId: 'c',
      schema,
      macro: macro('m', 'table', { name: 'n', defaultValue: null }),
    } as never;
    expect(await scriptOf('select', treeOf(), tableMacro)).toBe(
      ['-- Replace the <arg> placeholders with values.', 'SELECT * FROM "s"."m"(<arg1>) LIMIT 1000;'].join(
        '\n',
      ),
    );

    const folder = (macros: MacroInfo[]) =>
      ({ kind: 'folder', folder: 'macros', connectionId: 'c', schema, macros }) as never;
    const macros = [
      macro('needs', 'scalar', { name: 'x', defaultValue: null }),
      macro('plain', 'scalar'),
      macro('rows', 'table', { name: 'n', defaultValue: '10' }),
    ];
    expect(await scriptOf('select', treeOf(), folder(macros))).toBe(
      [
        '-- A call of each macro, with its first overload. A call that needs arguments is a comment: replace the <arg> placeholders and remove the "-- ".',
        '',
        '-- SELECT "s"."needs"(<arg1>);',
        'SELECT "s"."plain"();',
        'SELECT * FROM "s"."rows"() LIMIT 1000;',
      ].join('\n'),
    );
    expect(await scriptOf('select', treeOf(), folder([]))).toBe('-- This schema has no macros.');
    expect(await scriptOf('drop', treeOf(), folder([]))).toBe('-- This schema has no macros.');
  });
});
