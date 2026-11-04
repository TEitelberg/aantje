import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NO_AUTHOR,
  activityCards,
  authorKey,
  choices,
  activityModelOf,
  summarizeActivity,
} from '../../src/activity/model';
import type { ActivityData, ActivityFilter } from '../../src/activity/model';
import { POINT_KINDS } from '../../src/snapshot-report/model';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyActivity } from './activity-support';
import { snapshot, tableChange } from './snapshot-report-support';

const MAX_AUTHORS = 50;
const TOP_TABLES = 20;

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

const all: ActivityFilter = { kinds: POINT_KINDS, text: '' };
const HOSTILE = 'Fix 100% of <b>it</b> | `now`';

let data: ActivityData;
let plain: ActivityData;

beforeAll(async () => {
  data = await historyActivity(catalogs, [40, 44, 'ann', 'Backfill'], [45, 49, 'bob', HOSTILE]);
  plain = await historyActivity(catalogs);
});

describe('what the Activity report counts in the history fixture', () => {
  it('counts the commits per day by kind, the authors, the most changed tables and the key figures', () => {
    const summary = summarizeActivity(activityModelOf(data), all);
    expect(summary.days).toEqual([
      { day: '2026-10-20', commits: 10, kinds: { insert: 3, update: 0, delete: 0, ddl: 7, maintenance: 0 } },
      { day: '2026-10-21', commits: 10, kinds: { insert: 3, update: 1, delete: 1, ddl: 5, maintenance: 0 } },
      { day: '2026-10-22', commits: 10, kinds: { insert: 5, update: 1, delete: 1, ddl: 4, maintenance: 0 } },
      { day: '2026-10-23', commits: 10, kinds: { insert: 1, update: 0, delete: 0, ddl: 9, maintenance: 0 } },
      { day: '2026-10-24', commits: 10, kinds: { insert: 1, update: 0, delete: 0, ddl: 9, maintenance: 0 } },
      { day: '2026-10-25', commits: 7, kinds: { insert: 5, update: 0, delete: 0, ddl: 1, maintenance: 1 } },
    ]);
    expect(summary.kinds).toEqual({ insert: 18, update: 2, delete: 2, ddl: 35, maintenance: 1 });
    expect(summary.commits).toHaveLength(57);
    // Snapshot 23 inserted into shop.events and shop.customers: one commit, two changes.
    const tables = summarizeActivity(activityModelOf(data), { ...all, range: { from: 23, to: 23 } });
    expect(tables.commits.map(({ id }) => id)).toEqual([23]);
    expect(tables.kinds.insert).toBe(2);
    expect(tables.tables.map(({ label, changes }) => [label, changes])).toEqual([
      ['shop.customers', 1],
      ['shop.events', 1],
    ]);

    expect(summary.omittedAuthors).toBe(0);
    expect(summary.authors).toEqual([
      {
        author: NO_AUTHOR,
        commits: 46,
        first: '2026-10-20T10:00:00.000Z',
        last: '2026-10-25T10:56:00.000Z',
        message: null,
      },
      {
        author: 'ann',
        commits: 5,
        first: '2026-10-24T10:40:00.000Z',
        last: '2026-10-24T10:44:00.000Z',
        message: 'Backfill',
      },
      {
        author: 'bob',
        commits: 5,
        first: '2026-10-24T10:45:00.000Z',
        last: '2026-10-24T10:49:00.000Z',
        message: HOSTILE,
      },
      {
        author: 'tillmann',
        commits: 1,
        first: '2026-10-22T10:25:00.000Z',
        last: '2026-10-22T10:25:00.000Z',
        message: 'Nightly import',
      },
    ]);
    expect(
      summarizeActivity(activityModelOf(plain), all).authors.map(({ author, commits }) => [author, commits]),
    ).toEqual([
      [NO_AUTHOR, 56],
      ['tillmann', 1],
    ]);

    expect(summary.omittedTables).toBe(0);
    expect(summary.tablesChanged).toBe(8);
    expect(
      summary.tables.map(({ key, label, changes, kinds }) => [
        key,
        label,
        changes,
        [kinds.insert, kinds.update, kinds.delete, kinds.ddl, kinds.maintenance],
      ]),
    ).toEqual([
      [`t${HISTORY_ID.evolving}`, 'main.evolved', 11, [2, 0, 0, 9, 0]],
      [`t${HISTORY_ID.customers}`, 'shop.customers', 8, [3, 1, 1, 3, 0]],
      [`t${HISTORY_ID.events}`, 'shop.events', 8, [5, 0, 0, 3, 0]],
      [`t${HISTORY_ID.log}`, 'shop.log', 7, [5, 0, 0, 1, 1]],
      [`t${HISTORY_ID.notes}`, 'shop.notes', 4, [1, 1, 1, 1, 0]],
      [`t${HISTORY_ID.readings}`, 'shop.readings', 4, [1, 0, 0, 3, 0]],
      [`t${HISTORY_ID.oldStuff}`, 'shop.old_stuff (dropped)', 3, [1, 0, 0, 2, 0]],
      [`t${HISTORY_ID.audit}`, 'shop.audit', 1, [0, 0, 0, 1, 0]],
    ]);

    expect(activityCards(summary, 57).map(({ value }) => value)).toEqual([
      '57',
      '4',
      '8',
      '6',
      '2026-10-25 10:56:00 UTC',
    ]);
    const empty = summarizeActivity(activityModelOf(data), { ...all, text: 'nothing like this' });
    expect(activityCards(empty, 57)[4]?.value).toBe('none');
  });
});

describe('what the filters leave', () => {
  const ids = (filter: Partial<ActivityFilter>): number[] =>
    summarizeActivity(activityModelOf(data), { ...all, ...filter }).commits.map(({ id }) => id);

  it('filters by author, message words, kind of change, table and range, and combines the filters', () => {
    expect(ids({ author: 'ann' })).toEqual([44, 43, 42, 41, 40]);
    expect(ids({ author: 'tillmann' })).toEqual([25]);
    expect(ids({ author: NO_AUTHOR })).toHaveLength(46);
    expect(ids({ author: 'nobody' })).toEqual([]);
    const ann = summarizeActivity(activityModelOf(data), { ...all, author: 'ann' });
    expect(ann.authors.map(({ author }) => author)).toEqual(['ann']);
    expect(ann.days.map(({ day, commits }) => [day, commits])).toEqual([['2026-10-24', 5]]);

    expect(ids({ text: 'NIGHTLY' })).toEqual([25]);
    expect(ids({ text: '  backfill ' })).toEqual([44, 43, 42, 41, 40]);
    expect(ids({ text: '<B>it</b>' })).toEqual([49, 48, 47, 46, 45]);
    expect(ids({ text: 'zzz' })).toEqual([]);

    expect(ids({ kinds: ['delete'] })).toEqual([22, 18]);
    expect(ids({ kinds: ['update'] })).toEqual([21, 17]);
    expect(ids({ kinds: ['maintenance'] })).toEqual([55]);
    expect(ids({ kinds: [] })).toEqual([]);
    const deletes = summarizeActivity(activityModelOf(data), { ...all, kinds: ['delete'] });
    expect(deletes.kinds).toEqual({ insert: 0, update: 0, delete: 2, ddl: 0, maintenance: 0 });
    expect(deletes.tables.map(({ label }) => label)).toEqual(['shop.customers', 'shop.notes']);

    expect(ids({ table: `t${HISTORY_ID.events}` })).toEqual([23, 10, 9, 8, 7, 6, 5, 4]);
    const events = summarizeActivity(activityModelOf(data), { ...all, table: `t${HISTORY_ID.events}` });
    expect(events.tables.map(({ label, changes }) => [label, changes])).toEqual([['shop.events', 8]]);
    expect(events.kinds).toEqual({ insert: 5, update: 0, delete: 0, ddl: 3, maintenance: 0 });
    expect(ids({ table: `t${HISTORY_ID.events}`, kinds: ['ddl'] })).toEqual([9, 5, 4]);

    expect(ids({ range: { from: 24, to: 26 } })).toEqual([26, 25, 24]);
    expect(ids({ range: { from: 24, to: 26 }, author: 'tillmann' })).toEqual([25]);
    expect(ids({ range: { from: 30, to: 20 } })).toEqual([]);
    expect(ids({ range: { from: 0, to: 56 }, text: 'import', kinds: ['insert'] })).toEqual([25]);

    // A snapshot without a recorded change stays while nothing narrows the kinds or the tables.
    const bare = { ...snapshot(5, []), changes: [] };
    const withBare = activityModelOf({ ...data, snapshots: [bare], more: false });
    expect(summarizeActivity(withBare, all).commits.map(({ id }) => id)).toEqual([5]);
    expect(summarizeActivity(withBare, { ...all, kinds: ['insert'] }).commits).toEqual([]);
    expect(summarizeActivity(withBare, { ...all, table: 't1' }).commits).toEqual([]);
  });

  it('offers the authors and the tables of everything that was read, in name order', () => {
    const offered = choices(activityModelOf(data));
    expect(offered.authors.map(({ key }) => key)).toEqual([NO_AUTHOR, 'ann', 'bob', 'tillmann']);
    expect(offered.tables.map(({ label }) => label)).toEqual([
      'main.evolved',
      'shop.audit',
      'shop.customers',
      'shop.events',
      'shop.log',
      'shop.notes',
      'shop.old_stuff (dropped)',
      'shop.readings',
    ]);
    expect(authorKey(null)).toBe(NO_AUTHOR);
    expect(authorKey('')).toBe(NO_AUTHOR);
  });
});

describe('limits, hostile text and details that a user reads', () => {
  const at = (id: number, time: string, extra: Parameters<typeof snapshot>[2] = {}) => ({
    ...snapshot(id, [tableChange(1, 'inserted')], extra),
    time,
  });

  it('lists the 20 most changed tables and the 50 authors with the most commits, counts the others and all in the key figures', () => {
    const snapshots = Array.from({ length: 60 }, (_, index) =>
      snapshot(
        index + 1,
        [tableChange(index + 1, 'inserted', 'shop', `table_${String(index).padStart(2, '0')}`)],
        {
          author: `author_${String(index).padStart(2, '0')}`,
        },
      ),
    );
    const summary = summarizeActivity(activityModelOf({ ...data, snapshots, more: false }), all);
    expect(summary.tables).toHaveLength(TOP_TABLES);
    expect(summary.omittedTables).toBe(40);
    expect(summary.tablesChanged).toBe(60);
    expect(summary.authors).toHaveLength(MAX_AUTHORS);
    expect(summary.omittedAuthors).toBe(10);
    expect(summary.authors[0]?.author).toBe('author_00');
    const cards = activityCards(summary, 60);
    expect(cards[1]?.value).toBe('60');
    expect(cards[2]?.value).toBe('60');

    const none = summarizeActivity(activityModelOf({ ...data, snapshots: [], more: false }), all);
    expect(none).toMatchObject({ commits: [], days: [], authors: [], tables: [], tablesChanged: 0 });
  });

  it('keeps hostile text as it is, counts days in UTC, shows the newest message of an author, and sorts authors with equal commits by name', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const summary = summarizeActivity(
      activityModelOf({
        ...data,
        snapshots: [
          snapshot(1, [tableChange(7, 'inserted', hostile, hostile)], {
            author: hostile,
            commitMessage: hostile,
          }),
        ],
        more: false,
      }),
      all,
    );
    expect(summary.authors[0]).toMatchObject({ author: hostile, message: hostile });
    expect(summary.tables[0]?.label).toBe(`${hostile}.${hostile}`);
    expect(summary.commits[0]).toMatchObject({ author: hostile, message: hostile });

    const { days } = summarizeActivity(
      activityModelOf({
        ...plain,
        snapshots: [
          at(1, '2026-10-24T23:30:00.000Z'),
          at(2, '2026-10-24T23:59:59.000Z'),
          at(3, '2026-10-25T00:00:00.000Z'),
          at(4, '2026-10-25T00:30:00.000Z'),
        ],
      }),
      all,
    );
    expect(days.map(({ day, commits }) => [day, commits])).toEqual([
      ['2026-10-24', 2],
      ['2026-10-25', 2],
    ]);

    const messages = summarizeActivity(
      activityModelOf({
        ...plain,
        snapshots: [
          at(1, '2026-10-24T10:00:00.000Z', { author: 'ann', commitMessage: 'first' }),
          at(2, '2026-10-24T10:01:00.000Z', { author: 'ann', commitMessage: 'second' }),
          at(3, '2026-10-24T10:02:00.000Z', { author: 'ann' }),
          at(4, '2026-10-24T10:03:00.000Z', { author: 'bob', commitMessage: '' }),
        ],
      }),
      all,
    );
    expect(messages.authors.map(({ author, commits, message }) => [author, commits, message])).toEqual([
      ['ann', 3, 'second'],
      ['bob', 1, null],
    ]);

    const sorted = summarizeActivity(
      activityModelOf({
        ...plain,
        snapshots: [
          at(1, '2026-10-24T10:00:00.000Z', { author: 'zed' }),
          at(2, '2026-10-24T10:01:00.000Z', { author: 'abe' }),
          at(3, '2026-10-24T10:02:00.000Z'),
          at(4, '2026-10-24T10:03:00.000Z', { author: '!first' }),
        ],
      }),
      all,
    );
    expect(sorted.authors.map(({ author }) => author)).toEqual(['!first', NO_AUTHOR, 'abe', 'zed']);
  });
});
