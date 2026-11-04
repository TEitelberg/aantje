import { beforeAll, describe, expect, it } from 'vitest';
import { snapshotReportCompareTargets, planSnapshotReportAction } from '../../src/snapshot-report/actions';
import type { SnapshotReportActionRequest, SnapshotReportPlan } from '../../src/snapshot-report/actions';
import { buildModel, snapshotReportDetailOf } from '../../src/snapshot-report/model';
import type { SnapshotReportData } from '../../src/snapshot-report/model';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { historyReport, snapshot, tableChange } from './snapshot-report-support';

const { events, customers, evolving, log, oldStuff } = HISTORY_ID;

let data: SnapshotReportData;
beforeAll(async () => {
  data = await historyReport();
});

const plan = (
  request: SnapshotReportActionRequest,
  from: SnapshotReportData = data,
): SnapshotReportPlan | undefined => planSnapshotReportAction(from, request);

describe('the actions that the data offers', () => {
  it('plans the latest snapshot, the catalog and the rows changed at a snapshot that was sent, named as the table was called then', () => {
    expect(plan({ action: 'showLatest' })).toEqual({ action: 'showLatest' });
    expect(plan({ action: 'showCatalog', snapshot: 23 })).toEqual({ action: 'showCatalog', snapshot: 23 });
    expect(plan({ action: 'showCatalog', snapshot: HISTORY_LATEST_SNAPSHOT + 1 })).toBeUndefined();
    expect(plan({ action: 'showCatalog' })).toBeUndefined();

    expect(
      plan({ action: 'rowsChanged', snapshot: HISTORY_SNAPSHOT.twoTablesInOneTransaction, table: customers }),
    ).toEqual({ action: 'rowsChanged', snapshot: 23, table: { schema: 'shop', table: 'customers' } });
    expect(
      plan({ action: 'rowsChanged', snapshot: HISTORY_SNAPSHOT.insertEvolving, table: evolving }),
    ).toEqual({ action: 'rowsChanged', snapshot: 27, table: { schema: 'main', table: 'evolving' } });
    expect(
      plan({ action: 'rowsChanged', snapshot: HISTORY_SNAPSHOT.insertEvolved, table: evolving }),
    ).toEqual({ action: 'rowsChanged', snapshot: 36, table: { schema: 'main', table: 'evolved' } });

    const refused: [string, number, number][] = [
      ['a compaction', HISTORY_SNAPSHOT.mergeLog, log],
      ['a snapshot that dropped the table', HISTORY_SNAPSHOT.dropOldStuff, oldStuff],
      ['a table the snapshot did not touch', HISTORY_SNAPSHOT.twoTablesInOneTransaction, log],
      ['a table that is not in the catalog', HISTORY_SNAPSHOT.twoTablesInOneTransaction, 4711],
      ['a schema-only snapshot', HISTORY_SNAPSHOT.renameColumn, evolving],
    ];
    for (const [name, at, table] of refused) {
      expect(plan({ action: 'rowsChanged', snapshot: at, table }), name).toBeUndefined();
    }

    // The first snapshot has no snapshot before it to compare with.
    const first: SnapshotReportData = { ...data, snapshots: [snapshot(0, [tableChange(3, 'inserted')])] };
    expect(plan({ action: 'rowsChanged', snapshot: 0, table: 3 }, first)).toBeUndefined();
    expect(plan({ action: 'query', snapshot: 0, table: 3 }, first)).toMatchObject({ action: 'query' });
    const lost: SnapshotReportData = {
      ...data,
      snapshots: [snapshot(5, [tableChange(3, 'inserted', null, null)])],
    };
    expect(plan({ action: 'rowsChanged', snapshot: 5, table: 3 }, lost)).toBeUndefined();
    expect(plan({ action: 'query', snapshot: 5, table: 3 }, lost)).toBeUndefined();

    expect(plan({ action: 'query', snapshot: 23, table: events })).toEqual({
      action: 'query',
      snapshot: 23,
      subject: { kind: 'table', id: events, schemaName: 'shop', name: 'events' },
    });
    expect(
      plan({ action: 'query', snapshot: HISTORY_SNAPSHOT.dropOldStuff, table: oldStuff }),
    ).toBeUndefined();
  });
});

describe('the comparisons that the data offers', () => {
  const schema = (snapshotId: number, against: SnapshotReportActionRequest['against'], other?: number) =>
    plan({ action: 'compareSchema', snapshot: snapshotId, table: evolving, against, other });
  const catalog = (snapshotId: number, against: SnapshotReportActionRequest['against'], other?: number) =>
    plan({ action: 'compareSnapshots', snapshot: snapshotId, against, other });
  const subject = { kind: 'table', id: evolving, schemaName: 'main', name: 'evolved' } as const;

  it('compares a snapshot with the one before it, the latest or a second one, older snapshot first, and refuses what makes no sense', () => {
    expect(schema(35, 'previous')).toEqual({ action: 'compareSchema', subject, from: 34, to: 35 });
    expect(schema(35, 'latest')).toEqual({
      action: 'compareSchema',
      subject,
      from: 35,
      to: HISTORY_LATEST_SNAPSHOT,
    });
    expect(catalog(35, 'previous')).toEqual({ action: 'compareSnapshots', from: 34, to: 35 });
    expect(catalog(35, 'latest')).toEqual({
      action: 'compareSnapshots',
      from: 35,
      to: HISTORY_LATEST_SNAPSHOT,
    });
    expect(schema(35, 'other', 40)).toEqual({ action: 'compareSchema', subject, from: 35, to: 40 });
    expect(schema(35, 'other', 28)).toEqual({ action: 'compareSchema', subject, from: 28, to: 35 });
    expect(catalog(35, 'other', 28)).toEqual({ action: 'compareSnapshots', from: 28, to: 35 });

    const refused: [string, number, 'previous' | 'latest' | 'other' | undefined, number | undefined][] = [
      ['the first snapshot with the one before it', 0, 'previous', undefined],
      ['the latest snapshot with the latest', HISTORY_LATEST_SNAPSHOT, 'latest', undefined],
      ['a snapshot with itself', 35, 'other', 35],
      ['a second snapshot that was not sent', 35, 'other', 999],
      ['a second snapshot that is not named', 35, 'other', undefined],
      ['no choice', 35, undefined, undefined],
    ];
    for (const [name, at, against, other] of refused) {
      expect(schema(at, against, other), name).toBeUndefined();
      expect(catalog(at, against, other), name).toBeUndefined();
    }

    const newest = data.snapshots.slice(0, 3);
    const some: SnapshotReportData = { ...data, snapshots: newest, more: true };
    expect(plan({ action: 'compareSnapshots', snapshot: 56, against: 'other', other: 54 }, some)).toEqual({
      action: 'compareSnapshots',
      from: 54,
      to: 56,
    });
    expect(
      plan({ action: 'compareSnapshots', snapshot: 56, against: 'other', other: 30 }, some),
    ).toBeUndefined();
  });

  it('does not compare the schema of a table before it was created or after it was dropped, but the catalog whatever the snapshot did', () => {
    const at = (
      snapshotId: number,
      table: number,
      against: SnapshotReportActionRequest['against'],
      other?: number,
    ) => plan({ action: 'compareSchema', snapshot: snapshotId, table, against, other });
    const { createOldStuff, insertOldStuff, createEvolving, dropOldStuff } = HISTORY_SNAPSHOT;
    expect(at(createOldStuff, oldStuff, 'previous')).toBeUndefined();
    expect(at(insertOldStuff, oldStuff, 'latest')).toBeUndefined();
    expect(at(insertOldStuff, oldStuff, 'other', 40)).toBeUndefined();
    expect(at(insertOldStuff, oldStuff, 'previous')).toMatchObject({
      from: createOldStuff,
      to: insertOldStuff,
    });
    expect(at(createEvolving, evolving, 'previous')).toBeUndefined();
    expect(at(createEvolving, evolving, 'latest')).toMatchObject({ from: createEvolving });
    expect(at(dropOldStuff, oldStuff, 'previous')).toBeUndefined();
    expect(plan({ action: 'compareSnapshots', snapshot: dropOldStuff, against: 'previous' })).toEqual({
      action: 'compareSnapshots',
      from: 44,
      to: 45,
    });
  });
});

describe('the snapshots to compare with', () => {
  const detail = (id: number) => {
    const found = snapshotReportDetailOf(buildModel(data.snapshots), data.latest, id);
    if (!found) throw new Error(`no detail for @${id}`);
    return found;
  };

  it('are the one before, the latest and the second one, in this order, each only where it makes sense', () => {
    expect(snapshotReportCompareTargets(detail(35), 56, 40)).toEqual([
      { against: 'previous', snapshot: 34 },
      { against: 'latest', snapshot: 56 },
      { against: 'other', snapshot: 40 },
    ]);
    expect(snapshotReportCompareTargets(detail(0), 56, undefined)).toEqual([
      { against: 'latest', snapshot: 56 },
    ]);
    expect(snapshotReportCompareTargets(detail(56), 56, 56)).toEqual([{ against: 'previous', snapshot: 55 }]);
  });
});
