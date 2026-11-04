import { beforeAll, describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { SnapshotInfo } from '../../src/catalog/model';
import { describeChange, parseChanges } from '../../src/catalog/changes';
import type { ChangeEntry } from '../../src/catalog/changes';
import { describeAction, describeChanges, snapshotPickItems } from '../../src/snapshot';
import { createCatalogReader } from '../../src/catalog/reader';
import { LATEST_SNAPSHOT, SNAPSHOT } from '../support/expected';
import { HISTORY_COMMIT, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { fixturePath, wasmPath } from '../support/fixtures';
import { historyFixture } from '../support/sources/history';

const NO_COMMIT = { author: null, commitMessage: null, commitExtraInfo: null } as const;

interface FixtureSnapshot extends SnapshotInfo {
  /** The stored `snapshot_time` text, e.g. `2026-10-29 21:22:46.430739+00`; expectations are derived from it. */
  readonly stored: string;
}

/** The snapshots of the fixture catalog, newest first, mapped the way the catalog reader maps them. */
async function readFixtureSnapshots(): Promise<FixtureSnapshot[]> {
  const driver = await openSqlite({ path: fixturePath('ducklake.sqlite'), wasmPath });
  try {
    const rows = await driver.query(
      `SELECT s.snapshot_id, s.snapshot_time, c.changes_made
         FROM ducklake_snapshot s
         LEFT JOIN ducklake_snapshot_changes c ON c.snapshot_id = s.snapshot_id
        ORDER BY s.snapshot_id DESC`,
    );
    return rows.map((row) => {
      const stored = String(row.snapshot_time);
      return {
        id: Number(row.snapshot_id),
        stored,
        time: stored.replace(' ', 'T').replace(/\+00$/, 'Z'),
        changes: typeof row.changes_made === 'string' ? row.changes_made : null,
        ...NO_COMMIT,
      };
    });
  } finally {
    await driver.close();
  }
}

/** What `describeChanges` must say about each statement of test/fixtures/generate.py. */
const FIXTURE_CHANGES: Readonly<Record<number, string>> = {
  [SNAPSHOT.createMainSchema]: 'Created schema main',
  [SNAPSHOT.createSalesSchema]: 'Created schema sales',
  [SNAPSHOT.createOrders]: 'Created table sales.orders',
  [SNAPSHOT.createTmp]: 'Created table sales.tmp',
  [SNAPSHOT.insertOrders]: 'Inserted into table #2',
  [SNAPSHOT.insertTmp]: 'Inserted into table #3',
  [SNAPSHOT.deleteOrder2]: 'Deleted from table #2',
  [SNAPSHOT.createBigOrdersView]: 'Created view sales.big_orders',
  [SNAPSHOT.commentOnOrders]: 'Altered table #2',
  [SNAPSHOT.commentOnAmount]: 'Altered table #2',
  [SNAPSHOT.commentOnView]: 'Altered view #4',
  [SNAPSHOT.dropTmp]: 'Dropped table #3',
  [SNAPSHOT.createPlain]: 'Created table main.plain',
  [SNAPSHOT.addPlainColumn]: 'Altered table #5',
};

describe('describeChanges', () => {
  it('describes the change of every snapshot of the fixture catalog', async () => {
    const snapshots = await readFixtureSnapshots();
    const described = Object.fromEntries(
      snapshots.map((snapshot) => [snapshot.id, describeChanges(snapshot.changes)]),
    );
    expect(described).toEqual(FIXTURE_CHANGES);
  });

  it('words the tokens of the DuckLake vocabulary, in their stored order, with names read as stored', () => {
    // Every other token of the DuckLake vocabulary (specification and ducklake_transaction_changes.cpp).
    const cases: [string, string][] = [
      ['created_scalar_macro:"main"."add_one"', 'Created scalar macro main.add_one'],
      ['created_table_macro:"main"."recent_orders"', 'Created table macro main.recent_orders'],
      ['dropped_schema:1', 'Dropped schema #1'],
      ['dropped_view:4', 'Dropped view #4'],
      ['dropped_scalar_macro:7', 'Dropped scalar macro #7'],
      ['dropped_table_macro:8', 'Dropped table macro #8'],
      ['inlined_insert:2', 'Inserted inlined rows into table #2'],
      ['inlined_delete:2', 'Deleted inlined rows from table #2'],
      ['flushed_inlined:2', 'Flushed inlined data of table #2'],
      ['inline_flush:2', 'Flushed inlined data of table #2'],
      ['compacted_table:2', 'Compacted table #2'],
      ['merge_adjacent:2', 'Merged adjacent files of table #2'],
      ['rewrite_delete:2', 'Rewrote data files of table #2'],
      ['created_tag:"release 1"', 'Created snapshot tag release 1'],
      ['dropped_tag:"release 1"', 'Dropped snapshot tag release 1'],
      ['expired_snapshot:5', 'Expired snapshot @5'],
      [
        'created_schema:"s",created_table:"s"."a",created_view:"s"."v"',
        'Created schema s; Created table s.a; Created view s.v',
      ],
      // A name with a comma, a doubled quote, a dot, a quote-dot-quote, a colon, line breaks and a nested path.
      [
        'created_table:"sales"."orders, 2026",inserted_into_table:9',
        'Created table sales.orders, 2026; Inserted into table #9',
      ],
      ['created_table:"sales"."say ""hi"""', 'Created table sales.say "hi"'],
      ['created_view:"sales"."v1.2"', 'Created view sales.v1.2'],
      ['created_table:"sales"."a"".""b"', 'Created table sales.a"."b'],
      ['created_table:"main"."a:b"', 'Created table main.a:b'],
      ['created_table:"main"."a\nb"', 'Created table main.a\nb'],
      ['created_table:"sales"."europe"."orders"', 'Created table sales.europe.orders'],
    ];
    for (const [changes, expected] of cases) {
      expect(describeChanges(changes), changes).toBe(expected);
    }
  });

  it('keeps an unknown change, or a known one with an unusable argument, as stored, and takes no object property for a change', () => {
    expect(describeChanges('inserted_into_table:2,frobnicated:7,dropped_table:3')).toBe(
      'Inserted into table #2; frobnicated:7; Dropped table #3',
    );
    const stored = [
      'frobnicated:7',
      'inserted_into_table:abc',
      'inserted_into_table:',
      'altered_view:4x',
      'expired_snapshot:abc',
      'dropped_table',
      'created_schema:',
      'created_table:sales.orders',
      'created_table:"sales"."orders',
      'created_table:x"a"."b"',
      'created_table:"a"x"b"',
      'constructor:1',
      'toString:2',
      '__proto__:3',
    ];
    for (const changes of stored) {
      expect(describeChanges(changes), changes).toBe(changes);
    }
    expect(describeChanges(null)).toBe(describeChanges(''));
  });
});

describe('snapshotPickItems', () => {
  let snapshots: FixtureSnapshot[];
  beforeAll(async () => {
    snapshots = await readFixtureSnapshots();
  });

  const itemsFor = (selected: number | 'latest', list: readonly SnapshotInfo[] = snapshots) =>
    snapshotPickItems(list, { selected, latest: LATEST_SNAPSHOT });
  const pickedValues = (selected: number | 'latest') =>
    itemsFor(selected)
      .filter((item) => item.picked)
      .map((item) => item.value);

  it('offers Latest first and then every snapshot, newest first by id whatever the order and the commit time, with its time and changes', () => {
    const rows = itemsFor('latest');
    expect(rows.map((item) => item.label)).toEqual([
      'Latest',
      ...Array.from({ length: LATEST_SNAPSHOT + 1 }, (_, i) => `@${LATEST_SNAPSHOT - i}`),
    ]);
    expect(rows[0]).toMatchObject({ description: `@${LATEST_SNAPSHOT}`, value: 'latest', picked: true });
    // The stored text is `YYYY-MM-DD HH:mm:ss.ffffff+00`: cut at the second, no rounding.
    expect(rows.slice(1).map((row) => [row.label, row.description, row.detail])).toEqual(
      snapshots.map((snapshot) => [
        `@${snapshot.id}`,
        `${snapshot.stored.slice(0, 19)} UTC`,
        FIXTURE_CHANGES[snapshot.id],
      ]),
    );
    expect(rows.find((item) => item.value === SNAPSHOT.deleteOrder2)).toMatchObject({
      label: '@6',
      value: 6,
      picked: false,
    });
    expect(itemsFor('latest', [...snapshots].reverse())).toEqual(rows);

    // snapshot_time is written by the committing client, so its clock can disagree with the order of the ids.
    const skewed = snapshotPickItems(
      [
        { id: 1, time: '2026-10-29T12:00:00Z', changes: null, ...NO_COMMIT },
        { id: 2, time: '2026-10-29T11:00:00Z', changes: null, ...NO_COMMIT },
      ],
      { selected: 'latest', latest: 2 },
    );
    expect(skewed.map((row) => row.label)).toEqual(['Latest', '@2', '@1']);

    // A new catalog has only the snapshot 0.
    const fresh = [
      { id: 0, time: '2026-10-29T21:16:30.953Z', changes: 'created_schema:"main"', ...NO_COMMIT },
    ];
    const rowsFor = (selected: number | 'latest') => snapshotPickItems(fresh, { selected, latest: 0 });
    expect(rowsFor('latest').map((row) => [row.value, row.description, row.picked])).toEqual([
      ['latest', '@0', true],
      [0, '2026-10-29 21:16:30 UTC', false],
    ]);
    expect(rowsFor(0).map((row) => row.picked)).toEqual([false, true]);
  });

  it('marks only the selected snapshot, or Latest while the tree follows it, and nothing for one that is gone', () => {
    expect(pickedValues('latest')).toEqual(['latest']);
    expect(pickedValues(SNAPSHOT.deleteOrder2)).toEqual([6]);
    expect(pickedValues(SNAPSHOT.createMainSchema)).toEqual([0]);
    expect(pickedValues(LATEST_SNAPSHOT)).toEqual([LATEST_SNAPSHOT]);
    expect(pickedValues(99)).toEqual([]);
  });

  it('writes the time of a snapshot to the second, in UTC, whatever the precision it was stored with', () => {
    const timeOf = (time: string) =>
      snapshotPickItems([{ id: 1, time, changes: null, ...NO_COMMIT }], {
        selected: 'latest',
        latest: 1,
      }).find((item) => item.value === 1)?.description;
    const times: [string, string][] = [
      ['2026-10-29T21:16:30.953304Z', '2026-10-29 21:16:30 UTC'],
      ['2026-10-29T21:16:30.953Z', '2026-10-29 21:16:30 UTC'],
      ['2026-10-29T21:16:30Z', '2026-10-29 21:16:30 UTC'],
      ['2026-10-29T23:59:59.999Z', '2026-10-29 23:59:59 UTC'],
      ['2026-10-30T00:00:00.000Z', '2026-10-30 00:00:00 UTC'],
      ['2027-01-01T00:00:00Z', '2027-01-01 00:00:00 UTC'],
      ['2026-03-08T07:05:09Z', '2026-03-08 07:05:09 UTC'],
    ];
    for (const [time, expected] of times) {
      expect(timeOf(time), time).toBe(expected);
    }
  });
});

describe('snapshotPickItems with commit messages', () => {
  const fresh = (id: number, commitMessage: string | null): SnapshotInfo => ({
    id,
    time: '2026-10-29T21:22:46Z',
    changes: 'inserted_into_table:9',
    author: 'tillmann',
    commitMessage,
    commitExtraInfo: null,
  });
  const detailOf = (snapshot: SnapshotInfo) =>
    snapshotPickItems([snapshot], { selected: 'latest', latest: snapshot.id })[1]?.detail;

  it('puts the commit message of the history fixture in front of the changes of that snapshot only', async () => {
    const reader = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
    try {
      const rows = snapshotPickItems(await reader.snapshots(), {
        selected: 'latest',
        latest: HISTORY_LATEST_SNAPSHOT,
      });
      const detail = (id: number) => rows.find((row) => row.value === id)?.detail;
      expect(detail(HISTORY_COMMIT.snapshot)).toBe(`${HISTORY_COMMIT.message} · Inserted into table #9`);
      expect(detail(HISTORY_SNAPSHOT.updateCustomer)).toBe('Inserted into table #9; Deleted from table #9');
      expect(rows.filter((row) => row.detail.includes(HISTORY_COMMIT.message))).toHaveLength(1);
    } finally {
      await reader.close();
    }
  });

  it('shows a message on one line, "$(" literally, and the plain changes for an empty message', () => {
    expect(detailOf(fresh(1, '  Nightly\r\nimport\n\n  of   the\tlake '))).toBe(
      'Nightly import of the lake · Inserted into table #9',
    );
    // A picker would draw an icon for "$(".
    expect(detailOf(fresh(1, 'deploy $(rocket) done $(x'))).toBe(
      'deploy \\$(rocket) done \\$(x · Inserted into table #9',
    );
    expect(detailOf({ ...fresh(1, null), changes: 'created_table:"s"."$(x)"' })).toBe(
      'Created table s.\\$(x)',
    );
    for (const message of [null, '', '  \n ']) {
      expect(detailOf(fresh(1, message)), JSON.stringify(message)).toBe('Inserted into table #9');
    }
  });
});

describe('describeAction', () => {
  it('words every action like describeChange, without the name or the id, and adds the renamed and unknown ones', () => {
    const entries = [
      'created_schema:"s"',
      'created_table:"s"."t"',
      'created_view:"s"."v"',
      'created_scalar_macro:"s"."m"',
      'created_table_macro:"s"."m"',
      'dropped_schema:1',
      'dropped_table:1',
      'dropped_view:1',
      'dropped_scalar_macro:1',
      'dropped_table_macro:1',
      'altered_table:1',
      'altered_view:1',
      'inserted_into_table:1',
      'deleted_from_table:1',
      'inlined_insert:1',
      'inlined_delete:1',
      'flushed_inlined:1',
      'compacted_table:1',
      'merge_adjacent:1',
      'rewrite_delete:1',
      'created_tag:"t"',
      'dropped_tag:"t"',
      'expired_snapshot:1',
    ];
    for (const raw of entries) {
      const [entry] = parseChanges(raw);
      expect(entry?.object, raw).not.toBeNull();
      const action = describeAction(entry?.action ?? 'unknown', entry?.object ?? 'table');
      expect(describeChange(entry as ChangeEntry).startsWith(`${action} `), raw).toBe(true);
    }
    expect(describeAction('renamed', 'table')).toBe('Renamed table');
    expect(describeAction('unknown', 'table')).toBe('Changed table');
  });
});
