import { describe, expect, it } from 'vitest';
import type { CatalogEntry, ColumnInfo } from '../../src/catalog/model';
import { diffColumns, diffEntries } from '../../src/catalog/schema-diff';

function column(id: number, name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    id,
    name,
    type: 'varchar',
    nullable: true,
    defaultValue: null,
    comment: null,
    children: [],
    ...extra,
  };
}

function entry(kind: 'table' | 'view', id: number, schemaName: string, name: string): CatalogEntry {
  return { kind, id, name, schemaName, schemaId: schemaName.length };
}

describe('diffColumns', () => {
  it('matches by id and lists the differences of a column in a fixed order, added ones first and removed ones last', () => {
    const columns = [column(1, 'a'), column(2, 's', { type: 'struct', children: [column(3, 'x')] })];
    expect(diffColumns(columns, structuredClone(columns))).toEqual([]);
    expect(diffColumns([], [])).toEqual([]);

    const before = [column(1, 'a', { type: 'int32', defaultValue: '1', comment: 'old' })];
    const after = [column(1, 'b', { type: 'int64', nullable: false, defaultValue: null, comment: null })];
    expect(diffColumns(before, after)).toEqual([
      { change: 'renamed', id: 1, path: ['b'], from: 'a' },
      { change: 'typeChanged', id: 1, path: ['b'], from: 'int32', to: 'int64' },
      { change: 'nullableChanged', id: 1, path: ['b'], from: true, to: false },
      { change: 'defaultChanged', id: 1, path: ['b'], from: '1', to: null },
      { change: 'commentChanged', id: 1, path: ['b'], from: 'old', to: null },
    ]);

    // Two columns that swap their names are two renames; a new column with an old name is not the old column.
    expect(diffColumns([column(1, 'a'), column(2, 'b')], [column(1, 'b'), column(2, 'a')])).toEqual([
      { change: 'renamed', id: 1, path: ['b'], from: 'a' },
      { change: 'renamed', id: 2, path: ['a'], from: 'b' },
    ]);
    expect(diffColumns([column(1, 'a')], [column(2, 'a')])).toEqual([
      { change: 'added', id: 2, path: ['a'], type: 'varchar' },
      { change: 'removed', id: 1, path: ['a'], type: 'varchar' },
    ]);
    expect(
      diffColumns(
        [column(1, 'a'), column(2, 'b'), column(3, 'c')],
        [column(4, 'd'), column(2, 'b'), column(5, 'e')],
      ),
    ).toEqual([
      { change: 'added', id: 4, path: ['d'], type: 'varchar' },
      { change: 'added', id: 5, path: ['e'], type: 'varchar' },
      { change: 'removed', id: 1, path: ['a'], type: 'varchar' },
      { change: 'removed', id: 3, path: ['c'], type: 'varchar' },
    ]);

    const left = [column(1, 'a'), column(2, 'b')];
    const right = [column(2, 'b'), column(1, 'c')];
    const copies = [structuredClone(left), structuredClone(right)];
    diffColumns(left, right);
    expect([left, right]).toEqual(copies);
  });

  it('gives nested columns their path, also under a renamed, a removed or a changed parent', () => {
    const struct = (name: string, children: ColumnInfo[]) => column(10, name, { type: 'struct', children });

    expect(
      diffColumns(
        [struct('info', [column(11, 'a')])],
        [
          struct('info', [
            column(11, 'a'),
            column(12, 'tags', { type: 'list', children: [column(13, 'element', { type: 'int32' })] }),
          ]),
        ],
      ),
    ).toEqual([
      { change: 'added', id: 12, path: ['info', 'tags'], type: 'list' },
      { change: 'added', id: 13, path: ['info', 'tags', 'element'], type: 'int32' },
    ]);
    expect(diffColumns([struct('info', [column(11, 'a')])], [struct('details', [column(11, 'a')])])).toEqual([
      { change: 'renamed', id: 10, path: ['details'], from: 'info' },
    ]);
    expect(
      diffColumns(
        [struct('info', [column(11, 'a')])],
        [struct('details', [column(11, 'a', { type: 'int32' })])],
      ),
    ).toEqual([
      { change: 'renamed', id: 10, path: ['details'], from: 'info' },
      { change: 'typeChanged', id: 11, path: ['details', 'a'], from: 'varchar', to: 'int32' },
    ]);
    expect(diffColumns([struct('info', [column(11, 'a')])], [])).toEqual([
      { change: 'removed', id: 10, path: ['info'], type: 'struct' },
      { change: 'removed', id: 11, path: ['info', 'a'], type: 'varchar' },
    ]);
    // The same id under another parent is a removal and an addition.
    expect(
      diffColumns(
        [struct('info', [column(11, 'a')]), column(20, 'other', { type: 'struct' })],
        [struct('info', []), column(20, 'other', { type: 'struct', children: [column(11, 'a')] })],
      ),
    ).toEqual([
      { change: 'added', id: 11, path: ['other', 'a'], type: 'varchar' },
      { change: 'removed', id: 11, path: ['info', 'a'], type: 'varchar' },
    ]);
  });

  it('reports the column that moved, not the ones it moved over, and compares the order within the own struct', () => {
    const ids = (change: string, diff: ReturnType<typeof diffColumns>) =>
      diff.filter((entry) => entry.change === change).map((entry) => entry.id);
    const letters = (...order: string[]) => order.map((name, i) => column(i + 1, name));
    const reorder = (names: string[], order: string[]) =>
      order.map((name) => column(names.indexOf(name) + 1, name));
    const names = ['a', 'b', 'c', 'd'];

    expect(diffColumns(letters(...names), reorder(names, ['d', 'a', 'b', 'c']))).toEqual([
      { change: 'moved', id: 4, path: ['d'], from: 3, to: 0 },
    ]);
    // A column that was only added before or dropped between others is no move.
    expect(diffColumns(letters('a', 'b', 'c'), [column(9, 'new'), ...letters('a', 'b', 'c')])).toEqual([
      { change: 'added', id: 9, path: ['new'], type: 'varchar' },
    ]);
    expect(ids('moved', diffColumns(letters('a', 'b', 'c'), [column(1, 'a'), column(3, 'c')]))).toEqual([]);
    // A swap of two columns is one move, a reversal of three is two.
    expect(ids('moved', diffColumns(letters('a', 'b'), reorder(['a', 'b'], ['b', 'a'])))).toHaveLength(1);
    expect(
      ids('moved', diffColumns(letters('a', 'b', 'c'), reorder(['a', 'b', 'c'], ['c', 'b', 'a']))),
    ).toHaveLength(2);

    const before = [column(1, 's', { type: 'struct', children: [column(2, 'x'), column(3, 'y')] })];
    const after = [column(1, 's', { type: 'struct', children: [column(3, 'y'), column(2, 'x')] })];
    expect(diffColumns(before, after)).toEqual([
      { change: 'moved', id: 2, path: ['s', 'x'], from: 0, to: 1 },
    ]);
  });

  it('carries a hostile name through as it is', () => {
    const names = [
      '__proto__',
      'constructor',
      'a.b',
      'say "hi"',
      'ünï 🦆',
      '',
      ' ',
      'line\nbreak',
      '$(rm -rf)',
    ];
    for (const name of names) {
      expect(
        diffColumns([], [column(1, 's', { type: 'struct', children: [column(2, name)] })]),
        name,
      ).toEqual([
        { change: 'added', id: 1, path: ['s'], type: 'struct' },
        { change: 'added', id: 2, path: ['s', name], type: 'varchar' },
      ]);
      expect(diffColumns([column(1, name)], [column(1, `${name}!`)]), name).toEqual([
        { change: 'renamed', id: 1, path: [`${name}!`], from: name },
      ]);
    }
  });
});

describe('diffEntries', () => {
  it('finds added, dropped and renamed tables and views, matched by kind and id and not by name', () => {
    const same = [entry('table', 1, 'main', 'a'), entry('view', 2, 'main', 'v')];
    expect(diffEntries(same, structuredClone(same))).toEqual([]);

    expect(
      diffEntries(
        [entry('table', 1, 'main', 'old'), entry('view', 2, 'main', 'v'), entry('table', 3, 'main', 'c')],
        [entry('table', 1, 'main', 'new'), entry('view', 2, 'main', 'v'), entry('table', 4, 'main', 'd')],
      ),
    ).toEqual([
      {
        change: 'renamed',
        kind: 'table',
        id: 1,
        schemaName: 'main',
        name: 'new',
        from: { schemaName: 'main', name: 'old' },
      },
      { change: 'added', kind: 'table', id: 4, schemaName: 'main', name: 'd' },
      { change: 'dropped', kind: 'table', id: 3, schemaName: 'main', name: 'c' },
    ]);

    // A move to another schema is a rename, also together with a new name.
    expect(
      diffEntries(
        [entry('table', 1, 'a', 't'), entry('table', 2, 'a', 'u')],
        [entry('table', 1, 'b', 't'), entry('table', 2, 'b', 'w')],
      ),
    ).toEqual([
      {
        change: 'renamed',
        kind: 'table',
        id: 1,
        schemaName: 'b',
        name: 't',
        from: { schemaName: 'a', name: 't' },
      },
      {
        change: 'renamed',
        kind: 'table',
        id: 2,
        schemaName: 'b',
        name: 'w',
        from: { schemaName: 'a', name: 'u' },
      },
    ]);

    // A table and a view that share an id, and a dropped and a new table with the same name, are two changes.
    expect(diffEntries([entry('table', 5, 'main', 'x')], [entry('view', 5, 'main', 'x')])).toEqual([
      { change: 'added', kind: 'view', id: 5, schemaName: 'main', name: 'x' },
      { change: 'dropped', kind: 'table', id: 5, schemaName: 'main', name: 'x' },
    ]);
    expect(diffEntries([entry('table', 1, 'main', 't')], [entry('table', 2, 'main', 't')])).toEqual([
      { change: 'added', kind: 'table', id: 2, schemaName: 'main', name: 't' },
      { change: 'dropped', kind: 'table', id: 1, schemaName: 'main', name: 't' },
    ]);
  });

  it('handles a hostile name', () => {
    for (const name of ['__proto__', 'a"b', 'a.b', 'ünï 🦆', '', 'x\ny']) {
      expect(diffEntries([entry('table', 1, 'main', 'a')], [entry('table', 1, 'main', name)]), name).toEqual([
        {
          change: 'renamed',
          kind: 'table',
          id: 1,
          schemaName: 'main',
          name,
          from: { schemaName: 'main', name: 'a' },
        },
      ]);
    }
  });
});
