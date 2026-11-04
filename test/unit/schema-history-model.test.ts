import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnInfo, SchemaHistory, SchemaVersion } from '../../src/catalog/model';
import {
  CELL_KINDS,
  MAX_ROWS,
  buildHistory,
  columnLabel,
  schemaHistoryDetailOf,
  eventText,
  schemaHistoryViewOf,
} from '../../src/schema-history/model';
import type { SchemaHistoryData } from '../../src/schema-history/model';
import { HISTORY_ID } from '../support/expected-history';
import { TIME, historySchema } from './schema-history-support';

const { evolving, customers, oldStuff, events } = HISTORY_ID;

let evolved: SchemaHistoryData;
let dropped: SchemaHistoryData;
let tier: SchemaHistoryData;

beforeAll(async () => {
  evolved = await historySchema(evolving);
  dropped = await historySchema(oldStuff);
  tier = await historySchema(customers);
});

const all = { kinds: CELL_KINDS, text: '' } as const;

const column = (
  id: number,
  name: string,
  type = 'int32',
  children: readonly ColumnInfo[] = [],
): ColumnInfo => ({ id, name, type, nullable: true, defaultValue: null, comment: null, children });

const version = (
  snapshot: number,
  columns: readonly ColumnInfo[],
  name: string | null = 't',
): SchemaVersion => ({
  snapshot,
  time: TIME,
  author: null,
  commitMessage: null,
  table: name === null ? null : { schemaName: 's', name },
  columns,
});

const history = (versions: readonly SchemaVersion[], more = false): SchemaHistory => ({ versions, more });

const paths = (view: ReturnType<typeof schemaHistoryViewOf>): string[] =>
  view.rows.map(({ column: { path } }) => path.join('.'));

describe('the schema history of main.evolving / main.evolved', () => {
  it('has a snapshot for the creation, every column change and the rename, and one row per column id in table order', () => {
    expect(
      evolved.snapshots.map(({ id, previous, exists, events: own }) => [
        id,
        previous,
        exists,
        own.map(eventText),
      ]),
    ).toEqual([
      [26, null, true, ['created as main.evolving']],
      [28, 26, true, []],
      [29, 28, true, []],
      [30, 29, true, []],
      [31, 30, true, []],
      [32, 31, true, []],
      [33, 32, true, []],
      [34, 33, true, []],
      [35, 34, true, ['renamed main.evolving → main.evolved']],
    ]);
    expect(evolved).toMatchObject({
      tableId: evolving,
      schema: 'main',
      name: 'evolved',
      latest: 56,
      exists: true,
      more: false,
    });
    expect(
      evolved.columns.map((row) => [row.id, row.parent, row.path.join('.'), row.formerNames, row.now]),
    ).toEqual([
      [1, null, 'id', [], 'int32'],
      [2, null, 'title', ['name'], 'varchar'],
      [3, null, 'info', [], 'struct'],
      [4, 3, 'info.a', [], 'int32'],
      [5, 3, 'info.b', [], 'varchar'],
      [8, 3, 'info.c', [], 'float64'],
      [6, null, 'n', [], 'int64'],
      [9, null, 'flag', [], 'boolean'],
      [7, null, 'extra', [], null],
    ]);
    expect(evolved.columns.map(columnLabel)).toContain('title (formerly name)');

    const cellsOf = (id: number) =>
      evolved.columns
        .find((row) => row.id === id)
        ?.cells.map(({ snapshot, kind, text }) => [snapshot, kind, text]);
    expect(cellsOf(2)).toEqual([
      [26, 'added', '+ added: varchar'],
      [29, 'renamed', '↔ renamed: name → title'],
    ]);
    expect(cellsOf(6)).toEqual([
      [26, 'added', '+ added: int32'],
      [30, 'typeChanged', 'Δ type: int32 → int64'],
    ]);
    expect(cellsOf(9)?.map(([snapshot, kind]) => [snapshot, kind])).toEqual([
      [33, 'added'],
      [34, 'defaultChanged'],
    ]);
    expect(cellsOf(7)?.map(([snapshot, kind]) => [snapshot, kind])).toEqual([
      [28, 'added'],
      [31, 'removed'],
    ]);
    expect(cellsOf(8)?.map(([snapshot, kind]) => [snapshot, kind])).toEqual([[32, 'added']]);
  });

  it('describes a snapshot with every change it made, what to compare it with, and offers the newest state for all but the newest', () => {
    expect(schemaHistoryDetailOf(evolved, 30)).toMatchObject({
      snapshot: { id: 30 },
      changes: [{ columnId: 6, column: 'n', kind: 'typeChanged', text: 'Δ type: int32 → int64' }],
      previous: 29,
      hasLatest: true,
    });
    expect(schemaHistoryDetailOf(evolved, 26)).toMatchObject({ previous: null, hasLatest: true });
    expect(schemaHistoryDetailOf(evolved, 26)?.changes.map(({ column }) => column)).toEqual([
      'id',
      'title',
      'info',
      'info.a',
      'info.b',
      'n',
    ]);
    expect(schemaHistoryDetailOf(evolved, 27)).toBeUndefined();
    expect(schemaHistoryDetailOf({ ...evolved, latest: 36 }, 35)?.hasLatest).toBe(true);
    expect(schemaHistoryDetailOf({ ...evolved, latest: 35 }, 35)?.hasLatest).toBe(false);
    expect(schemaHistoryDetailOf({ ...evolved, latest: 35 }, 34)?.hasLatest).toBe(true);
  });

  it('reports a comment as a snapshot of its own, shows a table drop as an event, and handles tables with little or no history', async () => {
    expect(tier.snapshots.map(({ id }) => id)).toEqual([15, 38]);
    expect(tier.columns.find((row) => row.path.join('.') === 'tier')?.cells.map(({ kind }) => kind)).toEqual([
      'added',
      'commentChanged',
    ]);

    expect(
      dropped.snapshots.map(({ id, previous, exists, events: own }) => [
        id,
        previous,
        exists,
        own.map(eventText),
      ]),
    ).toEqual([
      [43, null, true, ['created as shop.old_stuff']],
      [45, 43, false, ['dropped (shop.old_stuff)']],
    ]);
    expect(dropped.exists).toBe(false);
    expect(dropped.columns.map(({ path, now, cells }) => [path, now, cells.map(({ kind }) => kind)])).toEqual(
      [[['x'], null, ['added']]],
    );
    expect(schemaHistoryDetailOf(dropped, 45)).toMatchObject({
      changes: [],
      previous: null,
      hasLatest: false,
    });
    expect(schemaHistoryDetailOf(dropped, 43)).toMatchObject({ previous: null, hasLatest: false });

    const created = await historySchema(events);
    expect(created.snapshots.map(({ id }) => id)).toEqual([4]);
    expect(created.columns.map(({ path }) => path.join('.'))).toEqual(['id', 'kind', 'ts', 'amount']);

    // The oldest version read is the starting point, with no change shown for it.
    const recent = await historySchema(evolving, 3);
    expect(recent.more).toBe(true);
    expect(recent.snapshots.map(({ id, previous }) => [id, previous])).toEqual([
      [34, 33],
      [35, 34],
    ]);
    expect(recent.columns.find(({ id }) => id === 9)?.cells.map(({ kind }) => kind)).toEqual([
      'defaultChanged',
    ]);
    expect(recent.columns.find(({ id }) => id === 2)?.formerNames).toEqual([]);
    expect(paths(schemaHistoryViewOf(recent, all))).toContain('id');
    expect(schemaHistoryViewOf(recent, { ...all, kinds: ['added'] }).rows).toEqual([]);

    expect(buildHistory('Lake', 99, 10, history([]))).toEqual({
      connection: 'Lake',
      tableId: 99,
      schema: null,
      name: 'table #99',
      latest: 10,
      exists: false,
      more: false,
      snapshots: [],
      columns: [],
    });
  });
});

describe('building the matrix from versions', () => {
  it('keeps renamed-back columns as one row, a moved column once under the new parent, and puts new columns after the one before them', () => {
    const renamed = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'a')]),
        version(2, [column(1, 'b')]),
        version(3, [column(1, 'a')]),
        version(4, [column(1, 'b')]),
      ]),
    );
    expect(renamed.columns).toHaveLength(1);
    // A former name is named once, however often the column went back and forth.
    expect(renamed.columns[0]).toMatchObject({ path: ['b'], formerNames: ['a'] });
    expect(renamed.columns[0]?.cells.map(({ kind }) => kind)).toEqual([
      'added',
      'renamed',
      'renamed',
      'renamed',
    ]);

    const moved = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'p', 'struct', [column(2, 'x')]), column(3, 'q', 'struct')]),
        version(2, [column(1, 'p', 'struct'), column(3, 'q', 'struct', [column(2, 'x')])]),
      ]),
    );
    expect(moved.columns.map(({ id, parent, path }) => [id, parent, path.join('.')])).toEqual([
      [1, null, 'p'],
      [3, null, 'q'],
      [2, 3, 'q.x'],
    ]);
    expect(moved.columns.find(({ id }) => id === 2)?.cells.map(({ kind }) => kind)).toEqual([
      'added',
      'added',
      'removed',
    ]);

    const ordered = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'a'), column(2, 'b'), column(3, 'c')]),
        version(2, [column(1, 'a'), column(3, 'c')]),
        version(3, [column(1, 'a'), column(4, 'd'), column(3, 'c')]),
      ]),
    );
    expect(ordered.columns.map(({ path }) => path.join('.'))).toEqual(['a', 'd', 'b', 'c']);

    const unchanged = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'a')]),
        version(2, [column(1, 'a')]),
        version(3, [column(1, 'a', 'int64')]),
      ]),
    );
    expect(unchanged.snapshots.map(({ id, previous }) => [id, previous])).toEqual([
      [1, null],
      [3, 2],
    ]);
  });

  it('reports nullability, moves, comments and defaults as cells, keeps author and message, and keeps markup as plain text', () => {
    const changed = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'a'), column(2, 'b')]),
        version(2, [{ ...column(2, 'b'), nullable: false, comment: 'c' }, column(1, 'a')]),
      ]),
    );
    expect(changed.columns.map(({ id, cells }) => [id, cells.slice(1).map(({ kind }) => kind)])).toEqual([
      [1, ['moved']],
      [2, ['nullableChanged', 'commentChanged']],
    ]);

    const defaults = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, 'a')]),
        version(2, [{ ...column(1, 'a'), defaultValue: '5' }]),
        version(3, [column(1, 'a')]),
      ]),
    );
    expect(defaults.columns[0]?.cells.slice(1).map(({ kind, text }) => [kind, text.includes('5')])).toEqual([
      ['defaultChanged', true],
      ['defaultChanged', true],
    ]);

    const authored = buildHistory(
      'Lake',
      1,
      9,
      history([{ ...version(1, [column(1, 'a')]), author: 'ann', commitMessage: 'First load' }]),
    );
    expect(authored.snapshots[0]).toMatchObject({ author: 'ann', message: 'First load' });

    const hostile = '<img src=x onerror=alert(1)>';
    const data = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(1, [column(1, hostile, hostile)], hostile),
        version(2, [column(1, hostile, 'int64')], hostile),
      ]),
    );
    expect(data.name).toBe(hostile);
    expect(data.columns[0]?.path).toEqual([hostile]);
    expect(data.columns[0]?.cells.map(({ text }) => text)).toEqual([
      `+ added: ${hostile}`,
      `Δ type: ${hostile} → int64`,
    ]);
  });
});

describe('what the filters leave of the matrix', () => {
  it('filters by kind, name (any name, any case, parent of a field), range and snapshot', () => {
    const everything = schemaHistoryViewOf(evolved, all);
    expect(everything.snapshots.map(({ id }) => id)).toEqual([26, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(everything.rows).toHaveLength(9);
    expect(everything.omittedRows).toBe(0);

    const typed = schemaHistoryViewOf(evolved, { ...all, kinds: ['typeChanged'] });
    expect(
      typed.rows.map(({ column: { path }, cells }) => [
        path.join('.'),
        cells.map(({ snapshot }) => snapshot),
      ]),
    ).toEqual([['n', [30]]]);
    expect(typed.snapshots.map(({ id }) => id)).toEqual([26, 30, 35]);
    expect(schemaHistoryViewOf(evolved, { ...all, kinds: [] }).rows).toEqual([]);

    expect(paths(schemaHistoryViewOf(evolved, { ...all, text: 'NAME' }))).toEqual(['title']);
    expect(paths(schemaHistoryViewOf(evolved, { ...all, text: ' c ' }))).toEqual(['info', 'info.c']);
    const none = schemaHistoryViewOf(evolved, { ...all, text: 'zzz' });
    expect(none.rows).toEqual([]);
    expect(none.snapshots.map(({ id }) => id)).toEqual([26, 35]);

    const ranged = schemaHistoryViewOf(evolved, { ...all, range: { from: 29, to: 30 } });
    expect(ranged.snapshots.map(({ id }) => id)).toEqual([29, 30]);
    expect(
      ranged.rows.map(({ column, cells }) => [column.path.join('.'), cells.map(({ snapshot }) => snapshot)]),
    ).toEqual([
      ['title', [29]],
      ['n', [30]],
    ]);

    const nested = buildHistory(
      'Lake',
      1,
      9,
      history([version(1, [column(1, 'outer', 'struct', [column(2, 'inner')]), column(3, 'other')])]),
    );
    expect(paths(schemaHistoryViewOf(nested, { ...all, text: 'outer' }))).toEqual(['outer']);
    expect(paths(schemaHistoryViewOf(nested, { ...all, text: 'inner' }))).toEqual(['outer', 'outer.inner']);
  });

  it('draws at most the first rows, says how many were left out, and lets the text filter reach the others', () => {
    const many = buildHistory(
      'Lake',
      1,
      9,
      history([
        version(
          1,
          Array.from({ length: 130 }, (_, index) => column(index + 1, `c${index + 1}`)),
        ),
      ]),
    );
    const view = schemaHistoryViewOf(many, all);
    expect(view.rows).toHaveLength(MAX_ROWS);
    expect(view.omittedRows).toBe(30);
    expect(paths(schemaHistoryViewOf(many, { ...all, text: 'c130' }))).toEqual(['c130']);
  });
});
