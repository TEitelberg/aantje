import { beforeAll, describe, expect, it } from 'vitest';
import {
  OTHER_LABEL,
  OTHER_LANE,
  POINT_KINDS,
  buildModel,
  snapshotReportDetailOf,
  snapshotReportTableChoices,
  tableExistsAt,
  snapshotReportViewOf,
} from '../../src/snapshot-report/model';
import type { ResolvedAction } from '../../src/catalog/model';
import type { SnapshotReportFilter, Model, SnapshotReportData } from '../../src/snapshot-report/model';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

const MAX_LANES = 30;

const EVERYTHING: SnapshotReportFilter = { lanes: [], kinds: POINT_KINDS };
const { events, customers, notes, audit, evolving, log, oldStuff, readings } = HISTORY_ID;
const key = (id: number): string => `t${id}`;
const keys = (lanes: readonly { readonly key: string }[]): string[] => lanes.map((lane) => lane.key);

let data: SnapshotReportData;
let model: Model;
beforeAll(async () => {
  data = await historyReport();
  model = buildModel(data.snapshots);
});

describe('the model of the history fixture', () => {
  it('has the tables busiest first, the other objects last, and keeps a renamed table on one lane', () => {
    expect(
      model.lanes.map((lane) => [lane.key, lane.schema, lane.name, lane.activity, lane.dropped]),
    ).toEqual([
      [key(evolving), 'main', 'evolved', 11, false],
      [key(customers), 'shop', 'customers', 8, false],
      [key(events), 'shop', 'events', 8, false],
      [key(log), 'shop', 'log', 7, false],
      [key(notes), 'shop', 'notes', 4, false],
      [key(readings), 'shop', 'readings', 4, false],
      [key(oldStuff), 'shop', 'old_stuff', 3, true],
      [key(audit), 'shop', 'audit', 1, false],
      [OTHER_LANE, null, OTHER_LABEL, 12, false],
    ]);
    const snapshotsOf = (lane: string) =>
      model.points.filter((point) => point.lane === lane).map((point) => point.snapshot);
    expect(snapshotsOf(key(evolving))).toEqual([26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36]);
    expect(snapshotsOf(OTHER_LANE)).toEqual([0, 1, 2, 3, 39, 40, 41, 42, 46, 47, 48, 49]);
  });

  it('has points of the kind a snapshot makes, one per snapshot and table, and joins transactions', () => {
    const pointAt = (id: number, lane: string) =>
      model.points.find((point) => point.snapshot === id && point.lane === lane);
    const expected = [
      [HISTORY_SNAPSHOT.insertEvents, key(events), 'insert', ['inserted']],
      [HISTORY_SNAPSHOT.deleteCustomer, key(customers), 'delete', ['deleted']],
      [HISTORY_SNAPSHOT.updateCustomer, key(customers), 'update', ['inserted', 'deleted']],
      [HISTORY_SNAPSHOT.updateNote, key(notes), 'update', ['inlined_insert', 'inlined_delete']],
      [HISTORY_SNAPSHOT.createAndInsertInOneTransaction, key(audit), 'ddl', ['created', 'inserted']],
      [HISTORY_SNAPSHOT.renameTable, key(evolving), 'ddl', ['renamed']],
      [HISTORY_SNAPSHOT.dropOldStuff, key(oldStuff), 'ddl', ['dropped']],
      [HISTORY_SNAPSHOT.mergeLog, key(log), 'maintenance', ['merged']],
      [HISTORY_SNAPSHOT.createGrossMacro, OTHER_LANE, 'ddl', ['created']],
    ] as const;
    for (const [id, lane, kind, actions] of expected) {
      expect(pointAt(id, lane), `snapshot ${id}`).toEqual({ snapshot: id, lane, kind, actions });
    }
    const one = buildModel([snapshot(1, [tableChange(3, 'inserted'), tableChange(3, 'inserted')])]);
    expect(one.points).toEqual([{ snapshot: 1, lane: 't3', kind: 'insert', actions: ['inserted'] }]);
    expect(snapshotReportViewOf(model, EVERYTHING).transactions).toEqual([
      HISTORY_SNAPSHOT.twoTablesInOneTransaction,
    ]);
  });

  it('classifies actions into kinds and data changes, and a mix of insert and delete is an update', () => {
    const kinds: readonly [ResolvedAction, string][] = [
      ['created', 'ddl'],
      ['dropped', 'ddl'],
      ['altered', 'ddl'],
      ['renamed', 'ddl'],
      ['unknown', 'ddl'],
      ['inserted', 'insert'],
      ['inlined_insert', 'insert'],
      ['deleted', 'delete'],
      ['inlined_delete', 'delete'],
      ['flushed_inlined', 'maintenance'],
      ['compacted', 'maintenance'],
      ['merged', 'maintenance'],
      ['rewritten', 'maintenance'],
      ['expired', 'maintenance'],
    ];
    for (const [action, kind] of kinds) {
      const built = buildModel([snapshot(1, [tableChange(3, action)])]);
      expect(
        built.points.map((point) => point.kind),
        action,
      ).toEqual([kind]);
    }
    const dataChanges: readonly [ResolvedAction, boolean][] = [
      ['inserted', true],
      ['deleted', true],
      ['inlined_insert', true],
      ['inlined_delete', true],
      ['compacted', false],
      ['altered', false],
      ['created', false],
    ];
    for (const [action, dataChange] of dataChanges) {
      const found = snapshotReportDetailOf(buildModel([snapshot(1, [tableChange(3, action)])]), 1, 1);
      expect(
        found?.tables.map((table) => table.dataChange),
        action,
      ).toEqual([dataChange]);
    }
    const kind = (...actions: ResolvedAction[]) =>
      buildModel([
        snapshot(
          1,
          actions.map((action) => tableChange(3, action)),
        ),
      ]).points[0]?.kind;
    expect(kind('inserted', 'deleted')).toBe('update');
    expect(kind('inlined_insert', 'inlined_delete')).toBe('update');
    expect(kind('inserted', 'deleted', 'altered')).toBe('ddl');
  });
});

describe('the view of the report', () => {
  it('has a column per snapshot and a point per change, and narrows by kind, table and range', () => {
    const view = snapshotReportViewOf(model, EVERYTHING);
    expect(view.columns.map(({ id }) => id)).toEqual(
      Array.from({ length: HISTORY_LATEST_SNAPSHOT + 1 }, (_, id) => id),
    );
    expect(view.points).toHaveLength(58);
    expect(view.omittedLanes).toBe(0);
    expect(keys(view.lanes)).toEqual(keys(model.lanes));

    const noMaintenance = snapshotReportViewOf(model, {
      lanes: [],
      kinds: ['insert', 'update', 'delete', 'ddl'],
    });
    expect(noMaintenance.points.some((point) => point.kind === 'maintenance')).toBe(false);
    expect(noMaintenance.columns.map(({ id }) => id)).not.toContain(HISTORY_SNAPSHOT.mergeLog);
    expect(noMaintenance.lanes.find((lane) => lane.key === key(log))?.activity).toBe(6);
    expect(keys(snapshotReportViewOf(model, { lanes: [], kinds: ['maintenance'] }).lanes)).toEqual([
      key(log),
    ]);
    expect(snapshotReportViewOf(model, { lanes: [], kinds: [] }).points).toEqual([]);

    const chosen = snapshotReportViewOf(model, { lanes: [key(customers), key(events)], kinds: POINT_KINDS });
    expect(keys(chosen.lanes)).toEqual([key(customers), key(events)]);
    expect(chosen.columns.map(({ id }) => id)).toEqual(
      [...new Set(chosen.points.map((point) => point.snapshot))].toSorted((a, b) => a - b),
    );
    expect(keys(snapshotReportViewOf(model, { lanes: [OTHER_LANE], kinds: POINT_KINDS }).lanes)).toEqual([
      OTHER_LANE,
    ]);

    const late = snapshotReportViewOf(model, { ...EVERYTHING, range: { from: 50, to: 56 } });
    expect(late.lanes.map((lane) => [lane.key, lane.activity])).toEqual([[key(log), 7]]);
    const early = snapshotReportViewOf(model, { ...EVERYTHING, range: { from: 4, to: 10 } });
    expect(early.lanes.map((lane) => [lane.key, lane.activity])).toEqual([[key(events), 7]]);
    expect(snapshotReportViewOf(model, { ...EVERYTHING, range: { from: 20, to: 10 } }).points).toEqual([]);
  });

  it('draws the 30 busiest tables, tells how many were left out, and shows a chosen omitted table', () => {
    // Table n is changed in n + 1 snapshots, so the 5 least busy ones are the tables 0 to 4.
    const snapshots = [
      snapshot(1, [
        { action: 'created', object: 'schema', objectId: 9, schemaName: null, name: 'extra', raw: 'x' },
      ]),
      ...Array.from({ length: 35 }, (_, table) =>
        Array.from({ length: table + 1 }, (_, round) =>
          snapshot(100 + table * 100 + round, [tableChange(table, 'inserted', 'shop', `table_${table}`)]),
        ),
      ).flat(),
    ];
    const big = buildModel(snapshots);
    const view = snapshotReportViewOf(big, EVERYTHING);

    const tables = view.lanes.filter((lane) => lane.key !== OTHER_LANE);
    expect(tables).toHaveLength(MAX_LANES);
    expect(view.omittedLanes).toBe(5);
    expect(view.lanes.at(-1)?.key).toBe(OTHER_LANE);
    expect(tables.map((lane) => lane.activity)).toEqual(
      Array.from({ length: MAX_LANES }, (_, index) => 35 - index),
    );
    const shown = new Set(keys(view.lanes));
    expect(view.points.every((point) => shown.has(point.lane))).toBe(true);
    const rest = keys(big.lanes.filter((lane) => lane.key !== OTHER_LANE && !shown.has(lane.key)));
    expect(rest).toEqual(['t4', 't3', 't2', 't1', 't0']);
    const chosen = snapshotReportViewOf(big, { lanes: rest, kinds: POINT_KINDS });
    expect(keys(chosen.lanes)).toEqual(rest);
    expect(chosen.omittedLanes).toBe(0);
  });

  it('draws no transaction line through an omitted lane', () => {
    const snapshots = [
      ...Array.from({ length: MAX_LANES + 1 }, (_, table) =>
        Array.from({ length: MAX_LANES + 2 - table }, (_, round) =>
          snapshot(1000 + table * 100 + round, [tableChange(table, 'inserted', 'shop', `t_${table}`)]),
        ),
      ).flat(),
      snapshot(1, [
        tableChange(0, 'inserted', 'shop', 't_0'),
        tableChange(MAX_LANES, 'inserted', 'shop', 't_30'),
      ]),
    ];
    const view = snapshotReportViewOf(buildModel(snapshots), EVERYTHING);

    expect(view.omittedLanes).toBe(1);
    expect(view.transactions).toEqual([]);
    expect(view.columns.map(({ id }) => id)).toContain(1);
  });

  it('orders lanes deterministically: by activity inside the range, then name, then table id', () => {
    const tied = buildModel([
      snapshot(1, [
        tableChange(7, 'inserted', 'shop', 'b'),
        tableChange(8, 'inserted', 'shop', 'a'),
        tableChange(9, 'inserted', 'archive', 'z'),
        tableChange(5, 'inserted', 'shop', 'same'),
        tableChange(4, 'inserted', 'shop', 'same'),
      ]),
    ]);
    expect(keys(tied.lanes)).toEqual(['t9', 't8', 't7', 't4', 't5']);

    const range = buildModel([
      snapshot(1, [tableChange(1, 'inserted', 'shop', 'a')]),
      snapshot(2, [tableChange(1, 'inserted', 'shop', 'a')]),
      snapshot(3, [tableChange(1, 'inserted', 'shop', 'a')]),
      snapshot(10, [tableChange(2, 'inserted', 'shop', 'b')]),
      snapshot(11, [tableChange(2, 'inserted', 'shop', 'b'), tableChange(1, 'inserted', 'shop', 'a')]),
    ]);
    expect(keys(range.lanes)).toEqual(['t1', 't2']);
    expect(keys(snapshotReportViewOf(range, { ...EVERYTHING, range: { from: 10, to: 11 } }).lanes)).toEqual([
      't2',
      't1',
    ]);
  });

  it('groups the table choices by schema in name order, and keeps the newest name of a table', () => {
    expect(snapshotReportTableChoices(model)).toEqual([
      { schema: 'main', tables: [{ key: key(evolving), name: 'evolved', dropped: false }] },
      {
        schema: 'shop',
        tables: [
          { key: key(audit), name: 'audit', dropped: false },
          { key: key(customers), name: 'customers', dropped: false },
          { key: key(events), name: 'events', dropped: false },
          { key: key(log), name: 'log', dropped: false },
          { key: key(notes), name: 'notes', dropped: false },
          { key: key(oldStuff), name: 'old_stuff', dropped: true },
          { key: key(readings), name: 'readings', dropped: false },
        ],
      },
    ]);
    const built = buildModel([
      snapshot(1, [tableChange(1, 'inserted', 'zeta', 'a'), tableChange(2, 'inserted', 'alpha', 'b')]),
      snapshot(2, [tableChange(1, 'inserted', null, null)]),
    ]);
    expect(built.lanes.map((lane) => [lane.schema, lane.name])).toEqual([
      ['zeta', 'a'],
      ['alpha', 'b'],
    ]);
    expect(snapshotReportTableChoices(built).map((group) => group.schema)).toEqual(['alpha', 'zeta']);
  });
});

describe('the detail of a snapshot', () => {
  const detail = (id: number) => snapshotReportDetailOf(model, HISTORY_LATEST_SNAPSHOT, id);

  it('names the tables a snapshot changed with their ids, and says what exists and what changed rows', () => {
    const found = detail(HISTORY_SNAPSHOT.twoTablesInOneTransaction);
    expect(
      found?.tables.map(({ key: tableKey, tableId, schema, name, exists, dataChange }) => ({
        tableKey,
        tableId,
        schema,
        name,
        exists,
        dataChange,
      })),
    ).toEqual([
      {
        tableKey: key(events),
        tableId: events,
        schema: 'shop',
        name: 'events',
        exists: true,
        dataChange: true,
      },
      {
        tableKey: key(customers),
        tableId: customers,
        schema: 'shop',
        name: 'customers',
        exists: true,
        dataChange: true,
      },
    ]);
    expect([found?.others, found?.previous, found?.hasLatest]).toEqual([[], 22, true]);
    expect(found?.timeText).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);

    expect(detail(HISTORY_SNAPSHOT.dropOldStuff)?.tables).toMatchObject([
      { name: 'old_stuff', exists: false, dataChange: false },
    ]);
    expect(detail(HISTORY_SNAPSHOT.mergeLog)?.tables).toMatchObject([
      { name: 'log', exists: true, dataChange: false },
    ]);
    expect(detail(HISTORY_SNAPSHOT.dropScratch)).toMatchObject({ tables: [] });
    expect(detail(HISTORY_SNAPSHOT.dropScratch)?.others).toHaveLength(1);
    expect(detail(HISTORY_SNAPSHOT.createBigEventsView)?.others).toHaveLength(1);
    expect(detail(HISTORY_SNAPSHOT.createBigEventsView)?.others[0]).toContain('big_events');

    expect(detail(HISTORY_SNAPSHOT.commitMessage)).toMatchObject({
      author: 'tillmann',
      message: 'Nightly import',
    });
    expect(detail(HISTORY_SNAPSHOT.insertEvents)).toMatchObject({ author: null, message: null });
    expect(detail(HISTORY_LATEST_SNAPSHOT + 1)).toBeUndefined();
  });

  it('knows the snapshot before and after, also in an expired or partly read catalog', () => {
    expect(detail(0)).toMatchObject({ previous: undefined, hasLatest: true });
    expect(detail(HISTORY_LATEST_SNAPSHOT)).toMatchObject({ previous: 55, hasLatest: false });

    const expired = buildModel([snapshot(0, []), snapshot(55, []), snapshot(56, [])]);
    expect([0, 55, 56].map((id) => snapshotReportDetailOf(expired, 56, id)?.previous)).toEqual([
      undefined,
      0,
      55,
    ]);
    const newest = [snapshot(55, []), snapshot(56, [])];
    expect(snapshotReportDetailOf(buildModel(newest, true), 56, 55)?.previous).toBe(54);
    expect(snapshotReportDetailOf(buildModel(newest, false), 56, 55)?.previous).toBeUndefined();
    const first = buildModel([snapshot(0, []), snapshot(1, [])]);
    expect(snapshotReportDetailOf(first, 1, 1)?.previous).toBe(0);
  });

  it('keeps an object that the catalog no longer names, by its id', () => {
    const lost = buildModel([
      snapshot(9, [
        {
          action: 'dropped',
          object: 'table',
          objectId: 15,
          schemaName: null,
          name: null,
          raw: 'dropped_table:15',
        },
        {
          action: 'unknown',
          object: null,
          objectId: null,
          schemaName: null,
          name: null,
          raw: 'strange:token',
        },
        {
          action: 'expired',
          object: 'snapshot',
          objectId: 5,
          schemaName: null,
          name: null,
          raw: 'expired_snapshot:5',
        },
      ]),
    ]);
    const found = snapshotReportDetailOf(lost, 9, 9);
    expect(found?.tables).toMatchObject([{ tableId: 15, schema: null, name: null, exists: false }]);
    expect(found?.others).toHaveLength(2);
    expect(found?.others[0]).toContain('strange:token');
    expect(lost.lanes).toHaveLength(2);
  });

  it('keeps names and messages from the catalog as they are', () => {
    const hostile = [
      '<img src=x onerror=alert(1)>',
      '"><script>alert(1)</script>',
      '{dropped|x}',
      '__proto__',
      'constructor',
      'line one\nline two',
      "o'brien; DROP TABLE",
    ];
    for (const name of hostile) {
      const built = buildModel([
        snapshot(1, [tableChange(3, 'inserted', name, name)], { author: name, commitMessage: name }),
        snapshot(2, [tableChange(4, 'inserted', 'ok', 'ok')]),
      ]);
      expect(built.lanes.map((lane) => lane.name).toSorted(), name).toEqual([name, 'ok'].toSorted());
      expect(snapshotReportTableChoices(built).map(({ schema }) => schema)).toContain(name);
      expect(snapshotReportDetailOf(built, 2, 1)).toMatchObject({
        author: name,
        message: name,
        tables: [{ label: `${name}.${name}` }],
      });
      expect(snapshotReportViewOf(built, { lanes: ['t3'], kinds: POINT_KINDS }).points).toHaveLength(1);
    }
  });
});

describe('where a table is', () => {
  it('begins with its creating snapshot, ends with its dropping one, and survives a rename', () => {
    const exists = (at: number) => tableExistsAt(model, key(oldStuff), at);
    expect([42, 43, 44, 45, 56].map(exists)).toEqual([false, true, true, false, false]);
    const later = buildModel([snapshot(40, [tableChange(7, 'inserted')])]);
    expect([0, 40, 99].map((at) => tableExistsAt(later, key(7), at))).toEqual([true, true, true]);
    expect(tableExistsAt(model, key(evolving), HISTORY_SNAPSHOT.renameTable)).toBe(true);
    expect(tableExistsAt(model, key(evolving), HISTORY_SNAPSHOT.createEvolving - 1)).toBe(false);
  });
});
