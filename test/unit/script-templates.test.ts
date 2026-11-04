import { describe, expect, it } from 'vitest';
import { scriptOf } from '../../src/script-templates';
import type { NodeRef } from '../../src/tree/refs';

/** A tree that shows the newest snapshot, or the pinned one; it has no reader, so nothing here reads the catalog. */
const treeAt = (snapshot: number | 'latest' = 'latest') =>
  ({
    state: () => ({ status: 'connected', snapshot, latestSnapshot: 20 }),
    reader: () => undefined,
  }) as never;

const schema = { id: 1, name: 's', comment: null };
const table = { id: 3, schemaId: 1, name: 't', comment: null, stats: { rows: 0, files: 0, sizeBytes: 0 } };

const layout = (folder: 'partitioning' | 'sortOrder', content: object): NodeRef =>
  ({ kind: 'folder', connectionId: 'c', folder, schema, table, ...content }) as never;

const partitioning = (columns: { path: string[]; transform: string }[]): NodeRef =>
  layout('partitioning', {
    partitioning: {
      id: 1,
      beginSnapshot: 1,
      endSnapshot: null,
      columns: columns.map((c) => ({ columnId: 1, ...c })),
    },
  });

const sortOrder = (
  expressions: { expression: string; dialect?: string; direction?: string; nullOrder?: string }[],
): NodeRef =>
  layout('sortOrder', {
    sortOrder: {
      id: 1,
      beginSnapshot: 1,
      endSnapshot: null,
      expressions: expressions.map((e) => ({
        dialect: 'duckdb',
        direction: 'ASC',
        nullOrder: 'NULLS_LAST',
        ...e,
      })),
    },
  });

const live = (script: string | undefined): string[] =>
  (script ?? '').split(/\r\n|\r|\n/).filter((line) => line !== '' && !line.startsWith('--'));

describe('the scripts of the Partitioning folder', () => {
  it('state the partitioning with every transform DuckLake takes, the bucket with the number first, and have the reset as a comment above it and as the DROP', async () => {
    const ref = partitioning([
      { path: ['a'], transform: 'year' },
      { path: ['b'], transform: 'month' },
      { path: ['c'], transform: 'day' },
      { path: ['d'], transform: 'hour' },
      { path: ['e'], transform: 'bucket(16)' },
      { path: ['kind'], transform: 'identity' },
    ]);
    expect(await scriptOf('create', treeAt(), ref)).toBe(
      [
        '-- To drop it before it is created again, remove the "-- " of the next line.',
        '-- ALTER TABLE "s"."t" RESET PARTITIONED BY;',
        'ALTER TABLE "s"."t" SET PARTITIONED BY (year("a"), month("b"), day("c"), hour("d"), bucket(16, "e"), "kind");',
      ].join('\n'),
    );
    expect(await scriptOf('drop', treeAt(), ref)).toBe(
      [
        '-- Removes the partitioning of the table: new data is written without it. Run it in a read/write SQL session.',
        'ALTER TABLE "s"."t" RESET PARTITIONED BY;',
      ].join('\n'),
    );
    expect((await scriptOf('create', treeAt(7), ref))?.split('\n')[0]).toBe(
      '-- The tree shows snapshot @7; this statement acts on the newest state.',
    );
  });

  it('write no statement, only the reason, for a nested column, a transform DuckLake does not take, or no column at all: never a statement with an empty or a broken key', async () => {
    const refused: { path: string[]; transform: string }[][] = [
      [{ path: ['a', 'b'], transform: 'identity' }],
      [
        { path: ['a', 'b'], transform: 'identity' },
        { path: ['id'], transform: 'identity' },
      ],
      [{ path: ['a'], transform: 'truncate(3)' }],
      [{ path: ['a'], transform: 'year"); DROP TABLE victim; --' }],
      ...['bucket()', 'bucket(x)', 'bucket(4', 'bucket(-1)', 'Year', 'identity ', 'toString'].map(
        (transform) => [{ path: ['a'], transform }],
      ),
      [],
    ];
    for (const columns of refused) {
      const script = await scriptOf('create', treeAt(), partitioning(columns));
      expect(live(script), JSON.stringify(columns)).toEqual([]);
      expect(script, JSON.stringify(columns)).toContain(
        '-- This partitioning cannot be written as a statement',
      );
    }
  });
});

describe('the scripts of the Sort Order folder', () => {
  it('state the sort order with the direction and the position of the nulls, and warn that the expressions come from the catalog', async () => {
    const ref = sortOrder([
      { expression: 'id', direction: 'DESC', nullOrder: 'NULLS_FIRST' },
      { expression: '"name"' },
    ]);
    expect(await scriptOf('create', treeAt(), ref)).toBe(
      [
        '-- The sort expressions come from the catalog: read them before running.',
        '-- To drop it before it is created again, remove the "-- " of the next line.',
        '-- ALTER TABLE "s"."t" RESET SORTED BY;',
        'ALTER TABLE "s"."t" SET SORTED BY (id DESC NULLS FIRST, "name" ASC NULLS LAST);',
      ].join('\n'),
    );
  });

  it('write no statement for an expression that could add a statement or comment out the rest, nor for a dialect, direction or null order they do not know', async () => {
    const refused: { expression: string; dialect?: string; direction?: string; nullOrder?: string }[] = [
      { expression: 'id; DROP TABLE victim' },
      { expression: 'id\n, 1' },
      { expression: 'id\r, 1' },
      { expression: 'id -- the rest' },
      { expression: 'id /* x */' },
      { expression: 'id', dialect: 'spark' },
      { expression: 'id', direction: 'SIDEWAYS' },
      { expression: 'id', nullOrder: 'NULLS_MIDDLE' },
      { expression: 'id', nullOrder: 'constructor' },
    ];
    for (const odd of refused) {
      const script = await scriptOf('create', treeAt(), sortOrder([odd]));
      expect(live(script), JSON.stringify(odd)).toEqual([]);
      expect(script, JSON.stringify(odd)).not.toContain('SET SORTED BY (');
    }
  });
});

describe('the SELECT of a folder and of a macro', () => {
  const tables = ['a', 'b'].map((name, index) => ({ ...table, id: index, name }));

  it('lists the tables of the folder under one time travel note, and says so when the folder has nothing to list', async () => {
    const ref = { kind: 'folder', connectionId: 'c', folder: 'tables', schema, tables } as never;
    expect(await scriptOf('select', treeAt(5), ref)).toBe(
      [
        '-- A query over each table of this schema.',
        '',
        '-- Time travel to snapshot 5',
        'SELECT *',
        'FROM "s"."a" AT (VERSION => 5)',
        'LIMIT 1000;',
        '',
        'SELECT *',
        'FROM "s"."b" AT (VERSION => 5)',
        'LIMIT 1000;',
      ].join('\n'),
    );
    const empty = { kind: 'folder', connectionId: 'c', folder: 'views', schema, views: [] } as never;
    expect(await scriptOf('select', treeAt(), empty)).toBe('-- This schema has no views.');
    expect(await scriptOf('drop', treeAt(), empty)).toBe('-- This schema has no views.');
  });

  it('writes a call per overload, a placeholder for each parameter without a default, and never a parameter name', async () => {
    const hostile = 'x"); DROP TABLE victim; --';
    const macro = {
      id: 1,
      schemaId: 1,
      name: 'm',
      kind: 'scalar',
      implementations: [
        {
          dialect: 'duckdb',
          sql: '1',
          parameters: [
            { name: hostile, type: null, defaultValue: null },
            { name: 'k', type: null, defaultValue: '1' },
          ],
        },
        { dialect: 'duckdb', sql: '2', parameters: [] },
      ],
    };
    const script = await scriptOf('select', treeAt(), {
      kind: 'macro',
      connectionId: 'c',
      schema,
      macro,
    } as never);
    expect(script).toBe(
      [
        '-- Replace the <arg> placeholders with values.',
        '-- The call is for the first overload; the others follow as comments.',
        'SELECT "s"."m"(<arg1>);',
        '-- SELECT "s"."m"();',
      ].join('\n'),
    );
    expect(script).not.toContain('DROP');
  });
});

describe('the nodes that have no script', () => {
  it('give undefined for every verb of a message or a fact, and for a verb that the kind does not have', () => {
    for (const ref of [
      { kind: 'message', connectionId: 'c', text: 'x' },
      { kind: 'detail', connectionId: 'c' },
    ] as const) {
      for (const verb of ['select', 'create', 'alter', 'drop'] as const) {
        expect(scriptOf(verb, treeAt(), ref), `${verb} of ${ref.kind}`).toBeUndefined();
      }
    }
    const history = { kind: 'folder', connectionId: 'c', folder: 'history', schema, table } as never;
    const macros = { kind: 'folder', connectionId: 'c', folder: 'macros', schema, macros: [] } as never;
    for (const verb of ['create', 'alter', 'drop'] as const) {
      expect(scriptOf(verb, treeAt(), history), `${verb} of the History folder`).toBeUndefined();
    }
    expect(scriptOf('alter', treeAt(), macros)).toBeUndefined();
  });
});
