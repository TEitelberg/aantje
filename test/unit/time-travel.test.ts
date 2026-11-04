import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, SnapshotInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { snapshotChoices } from '../../src/snapshot';
import type { SnapshotPickItem } from '../../src/snapshot';
import {
  changesOfSnapshot,
  chooseChanges,
  choosePair,
  chooseQuery,
  chooseRange,
  subjectOf,
  subjectSnapshots,
} from '../../src/time-travel';
import type { PickOptions, Subject, TimeTravelUi } from '../../src/time-travel';
import type { NodeRef } from '../../src/tree/refs';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { editedCatalogs } from '../support/edited-catalog';
import { wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

/** One question that the commands asked: the labels of its rows and of the rows highlighted when it opened. */
interface Asked {
  readonly labels: string[];
  readonly active: string[];
}

/**
 * The person: answers the picks in order with a label (undefined cancels) and records what was asked and how often
 * something was told. A pick without an answer fails the test, so a command cannot ask more than the script says.
 */
function person(...answers: (string | undefined)[]): TimeTravelUi & { asked: Asked[]; told: string[] } {
  const asked: Asked[] = [];
  const told: string[] = [];
  const script = [...answers];
  return {
    asked,
    told,
    pick<T extends { readonly label: string }>(items: readonly T[], options: PickOptions<T>) {
      asked.push({
        labels: items.map(({ label }) => label),
        active: (options.active ?? []).map(({ label }) => label),
      });
      if (script.length === 0) {
        throw new Error(`Unexpected question "${options.title}"`);
      }
      const label = script.shift();
      return Promise.resolve(items.find((item) => item.label === label));
    },
    info: (message) => {
      told.push(message);
    },
  };
}

/** The main fixture as DuckDB 1.5 wrote it (DuckLake specification 1.0): no commit columns. */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const evolving: Subject = { kind: 'table', id: HISTORY_ID.evolving, schemaName: 'main', name: 'evolved' };
const customers: Subject = { kind: 'table', id: HISTORY_ID.customers, schemaName: 'shop', name: 'customers' };
const oldStuff: Subject = { kind: 'table', id: HISTORY_ID.oldStuff, schemaName: 'shop', name: 'old_stuff' };
const tmpView: Subject = { kind: 'view', id: HISTORY_ID.tmpView, schemaName: 'shop', name: 'tmp_view' };
const bigEvents: Subject = {
  kind: 'view',
  id: HISTORY_ID.bigEventsView,
  schemaName: 'shop',
  name: 'big_events',
};

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => to - i);

const catalogs = editedCatalogs();
let reader: CatalogReader;
let expired: CatalogReader;
beforeAll(async () => {
  reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
  expired = createCatalogReader(await openSqlite({ path: historyFixture.expired, wasmPath }));
});
afterAll(async () => {
  await reader.close();
  await expired.close();
  await catalogs.dispose();
});

describe('the snapshots at which a table or view exists', () => {
  const idsOf = async (source: CatalogReader, subject: Subject, shown?: number) =>
    (await subjectSnapshots(source, subject, shown)).map((row) => row.value);

  it('run from the creation to the latest snapshot across a rename, stop before a drop, and are none once the catalog expired them', async () => {
    expect(await idsOf(reader, evolving)).toEqual(
      range(HISTORY_SNAPSHOT.createEvolving, HISTORY_LATEST_SNAPSHOT),
    );
    expect(await idsOf(reader, bigEvents)).toEqual(
      range(HISTORY_SNAPSHOT.createBigEventsView, HISTORY_LATEST_SNAPSHOT),
    );
    expect(await idsOf(reader, oldStuff)).toEqual([44, 43]);
    expect(await idsOf(reader, tmpView)).toEqual([HISTORY_SNAPSHOT.createTmpView]);
    // Customers exist from snapshot 15 on: no row for the snapshots before it, and none for "Latest".
    const rows = await subjectSnapshots(reader, customers, undefined);
    expect(rows.at(-1)?.value).toBe(HISTORY_SNAPSHOT.createCustomers);
    expect(rows.some((row) => row.label === 'Latest')).toBe(false);

    expect(await idsOf(expired, oldStuff)).toEqual([]);
    expect(await idsOf(expired, { ...evolving, id: HISTORY_ID.log })).toEqual([56, 55]);
  });

  it('preselect the snapshot that the tree shows when the table exists there, and nothing otherwise', async () => {
    const picked = async (shown: number | undefined) =>
      (await subjectSnapshots(reader, evolving, shown)).filter((row) => row.picked).map((row) => row.value);
    expect(await picked(30)).toEqual([30]);
    expect(await picked(HISTORY_LATEST_SNAPSHOT)).toEqual([HISTORY_LATEST_SNAPSHOT]);
    expect(await picked(10)).toEqual([]);
    expect(await picked(undefined)).toEqual([]);
  });

  it('are listed with the changes only for a specification 1.0 catalog without commit messages', async () => {
    const previous = createCatalogReader(await openSqlite({ path: FIXTURE_V1_0, wasmPath }));
    try {
      const orders = { kind: 'table', id: 2, schemaName: 'sales', name: 'orders' } as const;
      const rows = await subjectSnapshots(previous, orders, 6);
      expect(rows.map(({ value }) => value)).toEqual(range(2, 13));
      expect(rows.find(({ value }) => value === 4)?.detail).toContain('#2');
      expect(rows.filter(({ picked }) => picked).map(({ value }) => value)).toEqual([6]);
    } finally {
      await previous.close();
    }
  });
});

describe('snapshotChoices', () => {
  const snapshot = (id: number): SnapshotInfo => ({
    id,
    time: '2026-10-29T21:22:46.999Z',
    changes: null,
    author: null,
    commitMessage: null,
    commitExtraInfo: null,
  });
  const ids = (rows: readonly SnapshotPickItem<number>[]) => rows.map((row) => row.value);

  it('keeps the first snapshot of the lifetime, drops the one that ends it, skips expired ones and sorts newest first', () => {
    const snapshots = [0, 1, 2, 3, 4, 5].map(snapshot);
    expect(ids(snapshotChoices(snapshots, undefined, { begin: 2, end: 5 }))).toEqual([4, 3, 2]);
    expect(ids(snapshotChoices(snapshots, undefined, { begin: 2, end: null }))).toEqual([5, 4, 3, 2]);
    expect(ids(snapshotChoices(snapshots, undefined))).toEqual([5, 4, 3, 2, 1, 0]);
    expect(ids(snapshotChoices([0, 7, 3, 9].map(snapshot), undefined, { begin: 1, end: null }))).toEqual([
      9, 7, 3,
    ]);
  });
});

describe('Query at Snapshot: the two questions', () => {
  it('asks for the snapshot with the shown one highlighted, then for what to open, and names the table as it was at that snapshot', async () => {
    const ui = person('@30', 'Top 1000 Rows');

    const choice = await chooseQuery(ui, reader, evolving, 35);

    // The tree shows the table as `evolved`; at snapshot 30 it is `evolving`, the only name the engine knows there.
    expect(choice).toEqual({ snapshot: 30, action: 'rows', table: { schema: 'main', table: 'evolving' } });
    expect(ui.asked.map(({ labels, active }) => [labels.length, labels[0], labels.at(-1), active])).toEqual([
      [31, '@56', '@26', ['@35']],
      [3, 'Top 1000 Rows', 'Open as SQL', []],
    ]);
    expect(ui.told).toEqual([]);
  });

  it('gives the notebook and the SQL choice with the name of the snapshot, and the name of the tree for a view', async () => {
    expect(await chooseQuery(person('@36', 'Create Notebook'), reader, evolving, undefined)).toEqual({
      snapshot: 36,
      action: 'notebook',
      table: { schema: 'main', table: 'evolved' },
    });
    expect(await chooseQuery(person('@30', 'Open as SQL'), reader, evolving, 35)).toEqual({
      snapshot: 30,
      action: 'sql',
      table: { schema: 'main', table: 'evolving' },
    });
    expect(await chooseQuery(person('@41', 'Top 1000 Rows'), reader, tmpView, 41)).toEqual({
      snapshot: 41,
      action: 'rows',
      table: { schema: 'shop', table: 'tmp_view' },
    });
  });

  it('does nothing when either question is cancelled', async () => {
    const first = person(undefined);
    const second = person('@30', undefined);
    await expect(chooseQuery(first, reader, evolving, 35)).resolves.toBeUndefined();
    await expect(chooseQuery(second, reader, evolving, 35)).resolves.toBeUndefined();
    expect([first.asked.length, second.asked.length]).toEqual([1, 2]);
  });

  it('says so, and asks nothing, when no snapshot of the catalog has the table any more', async () => {
    const ui = person();
    await expect(chooseQuery(ui, expired, oldStuff, 56)).resolves.toBeUndefined();
    expect(ui.told).toHaveLength(1);
    expect(ui.told[0]).toContain('shop.old_stuff');
    expect(ui.asked).toEqual([]);
  });
});

describe('the pair of snapshots of a comparison', () => {
  it('starts with the shown snapshot for A, offers the rest for B with the newest highlighted, and puts the older one first', async () => {
    const ui = person('@30', '@56');

    const pair = await chooseRange(ui, reader, evolving, 30);

    expect(pair).toEqual({ from: 30, to: 56 });
    expect(ui.asked.map(({ labels, active }) => [labels.length, labels[0], active])).toEqual([
      [31, '@56', ['@30']],
      // A is not offered again, and the newest of the rest is highlighted for B.
      [30, '@56', ['@56']],
    ]);
    expect(ui.asked[1]?.labels).not.toContain('@30');

    await expect(chooseRange(person('@50', '@27'), reader, evolving, undefined)).resolves.toEqual({
      from: 27,
      to: 50,
    });

    // When A is the newest snapshot, the next newest is highlighted for B, so that A and B cannot be the same.
    const newest = person('@56', '@55');
    await chooseRange(newest, reader, evolving, HISTORY_LATEST_SNAPSHOT);
    expect(newest.asked[0]?.active).toEqual(['@56']);
    expect(newest.asked[1]?.labels[0]).toBe('@55');
    expect(newest.asked[1]?.active).toEqual(['@55']);
  });

  it('does nothing when A or B is cancelled, and says so without asking for a table with one snapshot', async () => {
    const first = person(undefined);
    const second = person('@30', undefined);
    await expect(chooseRange(first, reader, evolving, 35)).resolves.toBeUndefined();
    await expect(chooseRange(second, reader, evolving, 35)).resolves.toBeUndefined();
    expect([first.asked.length, second.asked.length, first.told, second.told]).toEqual([1, 2, [], []]);

    const single = person();
    await expect(chooseRange(single, reader, tmpView, 41)).resolves.toBeUndefined();
    expect(single.told).toHaveLength(1);
    expect(single.told[0]).toContain('shop.tmp_view');
    expect(single.asked).toEqual([]);
  });

  it('compares any two snapshots of the catalog when the rows are those of the whole catalog', async () => {
    const ui = person('@3', '@12');
    const pair = await choosePair(ui, snapshotChoices(await reader.snapshots(), 12), 'the catalog "Lake"');
    expect(pair).toEqual({ from: 3, to: 12 });
    expect(ui.asked[0]?.active).toEqual(['@12']);
    expect(ui.asked[0]?.labels).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
  });
});

describe('Show Changes: the range of snapshots', () => {
  it('asks for the snapshot to compare against (the one before the creation included), then for the last one to include, and returns the range', async () => {
    const ui = person('@16', '@18');

    const choice = await chooseChanges(ui, reader, customers, 17);

    expect(choice).toEqual({ from: 16, to: 18, table: { schema: 'shop', table: 'customers' } });
    expect(ui.asked.map(({ labels, active }) => [labels.length, labels[0], labels.at(-1), active])).toEqual([
      // The start has the shown snapshot highlighted; the newest snapshot is not offered, nothing comes after it.
      [42, '@55', '@14', ['@17']],
      // The end only lists later snapshots than the start, and the newest is highlighted.
      [40, '@56', '@17', ['@56']],
    ]);
    expect(ui.told).toEqual([]);

    // The snapshot before the creation is a start, so the rows of the creating snapshot can show; it is no end.
    const before = person('@14', '@16');
    await expect(chooseChanges(before, reader, customers, undefined)).resolves.toMatchObject({
      from: 14,
      to: 16,
    });
    expect(before.asked[0]?.labels.slice(-2)).toEqual(['@15', '@14']);
    expect(before.asked[1]?.labels.at(-1)).toBe('@15');

    // Only the snapshots at which a dropped table existed.
    const dropped = person('@43', '@44');
    await expect(chooseChanges(dropped, reader, oldStuff, 44)).resolves.toMatchObject({ from: 43, to: 44 });
    expect(dropped.asked[0]?.labels).toEqual(['@43', '@42']);
    expect(dropped.asked[1]?.labels).toEqual(['@44']);
  });

  it('never offers an end that is not after the start, so the same snapshot cannot be chosen twice', async () => {
    for (const start of ['@14', '@17', '@40', '@55']) {
      const ui = person(start, undefined);
      await chooseChanges(ui, reader, customers, 56);
      const from = Number(start.slice(1));

      expect(ui.asked[1]?.labels.every((label) => Number(label.slice(1)) > from)).toBe(true);
      expect(ui.asked[1]?.labels.at(-1)).toBe(`@${from + 1}`);
    }
  });

  it('names the table as it is at the end of the range, because the engine knows no other name there', async () => {
    const before = await chooseChanges(person('@27', '@30'), reader, evolving, 56);
    const across = await chooseChanges(person('@27', '@36'), reader, evolving, 56);

    expect(before?.table).toEqual({ schema: 'main', table: 'evolving' });
    expect(across?.table).toEqual({ schema: 'main', table: 'evolved' });
  });

  it('stops without a choice when either question is cancelled, and says so without asking when the table has no snapshot or only one', async () => {
    const first = person(undefined);
    const second = person('@20', undefined);
    await expect(chooseChanges(first, reader, customers, 56)).resolves.toBeUndefined();
    await expect(chooseChanges(second, reader, customers, 56)).resolves.toBeUndefined();
    expect([first.asked.length, second.asked.length, first.told, second.told]).toEqual([1, 2, [], []]);

    const none = person();
    await expect(chooseChanges(none, expired, oldStuff, 56)).resolves.toBeUndefined();
    expect(none.told).toHaveLength(1);
    expect(none.told[0]).toContain('shop.old_stuff');

    const single = person();
    const one = {
      snapshots: async () => (await reader.snapshots()).slice(5, 6),
      lifetime: () => Promise.resolve({ begin: 5, end: null }),
      entries: () => Promise.resolve([]),
    };
    await expect(chooseChanges(single, one, customers, 5)).resolves.toBeUndefined();
    expect(single.told).toHaveLength(1);
    expect(single.told[0]).toContain('shop.customers');
    expect([none.asked, single.asked]).toEqual([[], []]);
  });
});

describe('Show Rows Changed: the range of one snapshot', () => {
  const at = (id: number, schema: string, table: string) => ({ snapshot: id, table: { schema, table } });

  it('is the snapshot and the one before it, with the name of the table at that snapshot, down to the first snapshot of the catalog', async () => {
    const ui = person();

    await expect(changesOfSnapshot(ui, reader, at(17, 'shop', 'customers'))).resolves.toEqual({
      from: 16,
      to: 17,
      table: { schema: 'shop', table: 'customers' },
    });
    await expect(changesOfSnapshot(ui, reader, at(35, 'main', 'evolved'))).resolves.toMatchObject({
      from: 34,
      to: 35,
    });
    await expect(changesOfSnapshot(ui, reader, at(44, 'shop', 'old_stuff'))).resolves.toMatchObject({
      from: 43,
      to: 44,
    });

    // shop.events begins at snapshot 1 here, in the snapshot that created its schema.
    const early = await catalogs.open(
      historyFixture.sqlite,
      'UPDATE ducklake_table SET begin_snapshot = 1 WHERE table_id = 3',
    );
    await expect(changesOfSnapshot(ui, early, at(1, 'shop', 'events'))).resolves.toEqual({
      from: 0,
      to: 1,
      table: { schema: 'shop', table: 'events' },
    });
    expect([ui.asked, ui.told]).toEqual([[], []]);
  });

  it('does not take a view of the same name, or a table of the same name in another schema, for the table that the snapshot dropped', async () => {
    // Snapshot 45 drops the table shop.old_stuff; here it also creates a view with that name and the table main.old_stuff.
    const replaced = await catalogs.open(
      historyFixture.sqlite,
      "INSERT INTO ducklake_view VALUES (30, 'view-30', 45, NULL, 1, 'old_stuff', 'duckdb', 'SELECT 1 AS x', '')",
      "INSERT INTO ducklake_table VALUES (70, 'table-70', 45, NULL, 0, 'old_stuff', 'old_stuff/', 1)",
    );
    const ui = person();

    await expect(changesOfSnapshot(ui, replaced, at(45, 'shop', 'old_stuff'))).resolves.toBeUndefined();
    await expect(changesOfSnapshot(ui, replaced, at(45, 'main', 'old_stuff'))).resolves.toMatchObject({
      from: 44,
      to: 45,
    });
    expect(ui.told).toHaveLength(1);
  });

  it('says so and returns nothing for the first snapshot, and for a table that is dropped there, not created yet or called otherwise', async () => {
    for (const change of [
      at(0, 'main', 'evolving'),
      at(45, 'shop', 'old_stuff'),
      at(20, 'shop', 'audit'),
      at(35, 'main', 'evolving'),
    ]) {
      const ui = person();
      await expect(changesOfSnapshot(ui, reader, change)).resolves.toBeUndefined();
      expect(ui.told, JSON.stringify(change)).toHaveLength(1);
      expect(ui.told[0]).toContain(
        change.snapshot === 0 ? '@0' : `${change.table.schema}.${change.table.table}`,
      );
    }
  });
});

describe('the table or view of a tree node', () => {
  it('is named by schema and name, and is nothing for the other nodes', () => {
    const schema = { id: 1, name: 'shop', comment: null };
    const table = {
      id: 3,
      schemaId: 1,
      name: 'events',
      comment: null,
      stats: { rows: 0, files: 0, sizeBytes: 0 },
    };
    const view = {
      id: 13,
      schemaId: 1,
      name: 'big_events',
      comment: null,
      sql: 'SELECT 1',
      dialect: 'duckdb',
      columnAliases: [],
    };
    expect(subjectOf({ kind: 'table', connectionId: 'c', schema, table })).toEqual({
      kind: 'table',
      id: 3,
      schemaName: 'shop',
      name: 'events',
    });
    expect(subjectOf({ kind: 'view', connectionId: 'c', schema, view })).toEqual({
      kind: 'view',
      id: 13,
      schemaName: 'shop',
      name: 'big_events',
    });
    const column = {
      id: 1,
      name: 'id',
      type: 'int32',
      nullable: true,
      defaultValue: null,
      comment: null,
      children: [],
    };
    const others: NodeRef[] = [
      { kind: 'connection', connectionId: 'c' },
      { kind: 'schema', connectionId: 'c', schema },
      { kind: 'folder', connectionId: 'c', folder: 'tables', schema, tables: [table] },
      { kind: 'folder', connectionId: 'c', folder: 'columns', schema, table, columns: [column] },
      { kind: 'column', connectionId: 'c', schema, table, column, path: ['id'] },
      { kind: 'detail', connectionId: 'c' },
      { kind: 'message', connectionId: 'c', text: 'x' },
    ];
    expect(others.map(subjectOf)).toEqual(others.map(() => undefined));
  });
});
