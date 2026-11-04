import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogReader, SnapshotInfo } from '../../src/catalog/model';
import type { ColumnChange } from '../../src/catalog/schema-diff';
import {
  compareCatalog,
  compareSchema,
  comparisonMarkdown,
  describeColumnChange,
  documentAddress,
  snapshotsReport,
} from '../../src/compare';
import type { CompareLimits } from '../../src/compare';
import { formatUtc } from '../../src/snapshot';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';

/** The main fixture as DuckDB 1.5 wrote it (DuckLake specification 1.0): no commit columns. */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const evolved = { kind: 'table', id: HISTORY_ID.evolving, schemaName: 'main', name: 'evolved' } as const;
const customers = { kind: 'table', id: HISTORY_ID.customers, schemaName: 'shop', name: 'customers' } as const;

const catalogs = editedCatalogs();
const readerOf = (source: string, ...statements: string[]): Promise<CatalogReader> =>
  catalogs.open(source, ...statements);
let reader: CatalogReader;

beforeAll(async () => {
  reader = await readerOf(historyFixture.sqlite);
});
afterAll(() => catalogs.dispose());

describe('Compare Schema on the history of main.evolving', () => {
  it('gives the two CREATE TABLE statements, each with the table as it was at its snapshot, named as at B', async () => {
    const { documents, title } = await compareSchema(reader, 'lake', evolved, 30, 35);

    expect(title).toContain('main.evolved');
    expect(documents).toEqual({
      left: {
        key: { connectionId: 'lake', tableId: 12, snapshot: 30 },
        text: [
          'CREATE TABLE "main"."evolving" (',
          '  "id" INTEGER,',
          '  "title" VARCHAR,',
          '  "info" STRUCT("a" INTEGER, "b" VARCHAR),',
          '  "n" BIGINT,',
          '  "extra" DOUBLE',
          ');',
        ].join('\n'),
      },
      right: {
        key: { connectionId: 'lake', tableId: 12, snapshot: 35 },
        text: [
          'CREATE TABLE "main"."evolved" (',
          '  "id" INTEGER,',
          '  "title" VARCHAR,',
          '  "info" STRUCT("a" INTEGER, "b" VARCHAR, "c" DOUBLE),',
          '  "n" BIGINT,',
          '  "flag" BOOLEAN DEFAULT true',
          ');',
        ].join('\n'),
      },
    });
  });

  it('offers no documents when both texts are the same, and takes the names from the catalog, not from the node that asked', async () => {
    // A comment is not part of the DDL; snapshots 36 and 56 have the same schema.
    expect((await compareSchema(reader, 'lake', customers, 37, 38)).documents).toBeUndefined();
    expect((await compareSchema(reader, 'lake', evolved, 36, 56)).documents).toBeUndefined();

    // A rename of the table alone: two documents that differ.
    const renamed = await compareSchema(reader, 'lake', evolved, 34, 35);
    expect(renamed.documents?.left.text.split('\n')[0]).toBe('CREATE TABLE "main"."evolving" (');
    expect(renamed.documents?.right.text.split('\n')[0]).toBe('CREATE TABLE "main"."evolved" (');

    const stale = { ...evolved, schemaName: 'other', name: 'old name' };
    const { title, documents } = await compareSchema(reader, 'lake', stale, 30, 35);
    expect(title).toContain('main.evolved');
    expect(documents?.left.text.split('\n')[0]).toBe('CREATE TABLE "main"."evolving" (');

    // From snapshot 35 the table keeps its name but lives in schema shop (1) instead of main (0): a rename.
    const moved = await readerOf(
      historyFixture.sqlite,
      "UPDATE ducklake_table SET table_name = 'evolving', schema_id = 1 WHERE table_id = 12 AND begin_snapshot = 35",
    );
    const afterMove = await compareSchema(moved, 'lake', evolved, 34, 35);
    expect(afterMove.title).toContain('shop.evolving');
    expect(afterMove.documents?.right.text.split('\n')[0]).toBe('CREATE TABLE "shop"."evolving" (');
  });
});

describe('the address of a schema document', () => {
  it('is made of the table id and the snapshot, keeps names out of the path, and differs for every part', () => {
    expect(documentAddress({ connectionId: 'lake', tableId: 12, snapshot: 30 })).toEqual({
      path: '/12@30.sql',
      query: 'lake',
    });
    // No table name can make an invalid or foreign URI.
    expect(documentAddress({ connectionId: '//x?#\n"', tableId: 1, snapshot: 2 })).toEqual({
      path: '/1@2.sql',
      query: '//x?#\n"',
    });
    const base = { connectionId: 'a', tableId: 1, snapshot: 2 };
    const addresses = [
      base,
      { ...base, connectionId: 'b' },
      { ...base, tableId: 3 },
      { ...base, snapshot: 4 },
    ].map((key) => JSON.stringify(documentAddress(key)));
    expect(new Set(addresses).size).toBe(4);
  });
});

describe('the words for one column change', () => {
  it('shows a hostile name or type as code that cannot end itself or start a block', () => {
    const change: ColumnChange = {
      id: 1,
      path: ['a``b', '# x\n\n- y'],
      change: 'added',
      type: 'struct(`z`)',
    };
    expect(describeColumnChange(change)).toBe('added ```a``b.# x - y``` (``struct(`z`)``)');
  });
});

/** The report of two snapshots, with the connection name as it is shown. */
async function report(
  source: CatalogReader,
  from: number,
  to: number,
  limits?: CompareLimits,
): Promise<string> {
  return comparisonMarkdown({
    connectionName: 'Lake',
    from: { id: from },
    to: { id: to },
    comparison: await compareCatalog(source, from, to, limits),
    ...(limits ? { limits } : {}),
  });
}

/** What changed between the entries, as `change kind schema.name`. */
const listed = (comparison: Awaited<ReturnType<typeof compareCatalog>>): string[] =>
  comparison.entries.map((entry) => `${entry.change} ${entry.kind} ${entry.schemaName}.${entry.name}`);

describe('the comparison of two snapshots of the history catalog', () => {
  it('lists the renamed table and its column changes, matched by id across the rename, as a report', async () => {
    const comparison = await compareCatalog(reader, 30, 35);
    expect(listed(comparison)).toEqual(['renamed table main.evolved']);
    expect(comparison.entries[0]).toMatchObject({ from: { schemaName: 'main', name: 'evolving' } });
    expect([comparison.compared, comparison.omitted, comparison.tables.length]).toEqual([6, 0, 1]);
    expect(comparison.tables[0]?.changes.map(({ change, path }) => [change, path.join('.')])).toEqual([
      ['added', 'info.c'],
      ['added', 'flag'],
      ['removed', 'extra'],
    ]);

    expect(await report(reader, 30, 35)).toBe(
      [
        '# Lake: @30 to @35',
        '',
        '- From: @30',
        '- To: @35',
        '',
        '## Tables and views',
        '',
        '### Renamed (1)',
        '',
        '- table `main.evolving` is now `main.evolved`',
        '',
        '## Columns',
        '',
        'Compared 6 tables that exist at both snapshots. 1 of them has column changes.',
        '',
        '### `main.evolved`',
        '',
        '- added `info.c` (`float64`)',
        '- added `flag` (`boolean`)',
        '- removed `extra` (`float64`)',
        '',
      ].join('\n'),
    );
  });

  it('finds a dropped table, nothing for two equal snapshots, and every kind of change in the order added, dropped, renamed', async () => {
    expect(listed(await compareCatalog(reader, 44, 46))).toEqual(['dropped table shop.old_stuff']);

    const same = await compareCatalog(reader, 51, 56);
    expect([same.entries, same.tables, same.compared]).toEqual([[], [], 7]);

    // shop.notes (table 10) is dropped at snapshot 40; between 34 and 46 the view big_events is added and evolving renamed.
    const dropped = await readerOf(
      historyFixture.sqlite,
      'UPDATE ducklake_table SET end_snapshot = 40 WHERE table_id = 10',
    );
    const all = await compareCatalog(dropped, 34, 46);
    expect(listed(all).sort()).toEqual([
      'added view shop.big_events',
      'dropped table shop.notes',
      'renamed table main.evolved',
    ]);
    // The report lists what was added, then what was dropped, then what was renamed.
    const headings = (await report(dropped, 34, 46)).split('\n').filter((line) => line.startsWith('### '));
    expect(headings.slice(0, 3)).toEqual(['### Added (1)', '### Dropped (1)', '### Renamed (1)']);
    expect(all.tables.map(({ entry, changes }) => [entry.name, changes.length])).toEqual([['customers', 1]]);
  });

  it('reads both snapshots of a table at once, and a few tables at a time, with the same result', async () => {
    let running = 0;
    let peak = 0;
    const overlapped = new Set<number>();
    const inFlight = new Map<number, number>();
    const watched: Pick<CatalogReader, 'entries' | 'columns'> = {
      entries: (snapshot) => reader.entries(snapshot),
      async columns(tableId, snapshot) {
        running++;
        peak = Math.max(peak, running);
        inFlight.set(tableId, (inFlight.get(tableId) ?? 0) + 1);
        if ((inFlight.get(tableId) ?? 0) > 1) overlapped.add(tableId);
        try {
          return await reader.columns(tableId, snapshot);
        } finally {
          running--;
          inFlight.set(tableId, (inFlight.get(tableId) ?? 0) - 1);
        }
      },
    };

    const comparison = await compareCatalog(watched, 30, 35);

    expect(comparison).toEqual(await compareCatalog(reader, 30, 35));
    expect(overlapped.size).toBe(comparison.compared);
    // Six tables, each read at two snapshots: never all twelve reads at once.
    expect(peak).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThan(2 * comparison.compared);
  });

  it('counts the omitted tables exactly, and omits nothing at the default limits of this catalog', async () => {
    const all = await compareCatalog(reader, 23, 56);
    expect([all.compared, all.omitted, all.tables.length, all.entries.length]).toEqual([4, 0, 1, 4]);
    const some = await compareCatalog(reader, 23, 56, { tables: 3, entries: 10, changes: 10 });
    expect([some.compared, some.omitted]).toEqual([3, 1]);
    const none = await compareCatalog(reader, 23, 56, { tables: 0, entries: 10, changes: 10 });
    expect([none.compared, none.omitted, none.tables]).toEqual([0, 4, []]);
  });

  it('adds the time of each of both snapshots to the report that the command opens, and none for one the list does not have', async () => {
    const snapshots = await reader.snapshots();
    const time = (id: number): string =>
      formatUtc(snapshots.find((snapshot) => snapshot.id === id)?.time ?? '');
    const text = await snapshotsReport(reader, 'Lake', snapshots, 30, 35);
    expect(text.split('\n').slice(2, 4)).toEqual([`- From: @30, ${time(30)}`, `- To: @35, ${time(35)}`]);
    expect(time(30)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/);

    const snapshot = (id: number, at: string): SnapshotInfo => ({
      id,
      time: at,
      changes: null,
      author: null,
      commitMessage: null,
      commitExtraInfo: null,
    });
    const explicit = await snapshotsReport(
      reader,
      'Lake',
      [snapshot(35, '2026-01-02T10:11:12.000Z'), snapshot(30, '2026-01-01T09:00:00.000Z')],
      30,
      35,
    );
    expect(explicit.split('\n').slice(2, 4)).toEqual([
      '- From: @30, 2026-01-01 09:00:00 UTC',
      '- To: @35, 2026-01-02 10:11:12 UTC',
    ]);
    const missing = await snapshotsReport(reader, 'Lake', [snapshot(30, '2026-01-01T09:00:00.000Z')], 30, 35);
    expect(missing.split('\n').slice(2, 4)).toEqual(['- From: @30, 2026-01-01 09:00:00 UTC', '- To: @35']);
  });
});

describe('the comparison of a catalog written for specification 1.0, without commit messages', () => {
  it('compares the main fixture: a view and a table added, and the comment on a column', async () => {
    const previous = await readerOf(FIXTURE_V1_0);
    // 2 -> 13: sales.orders is there from the start; big_orders (7) and main.plain (12) are added, tmp came and went.
    const comparison = await compareCatalog(previous, 2, 13);
    expect(listed(comparison).sort()).toEqual(['added table main.plain', 'added view sales.big_orders']);
    expect(comparison.compared).toBe(1);
    expect(
      comparison.tables.map(({ entry, changes }) => [entry.name, changes.map(({ change }) => change)]),
    ).toEqual([['orders', ['commentChanged']]]);
  });
});

describe('a catalog with hostile names', () => {
  it('shows names and values as code: nothing becomes a heading, a link, a list or a table', async () => {
    // Table 12 is `evolving` until snapshot 34 and `evolved` from 35 (two rows with the same id); column 9 is `flag`.
    const hostile = await readerOf(
      historyFixture.sqlite,
      "UPDATE ducklake_table SET table_name = 'a|b' || char(10) || char(10) || '# Fake heading' WHERE table_id = 12 AND begin_snapshot = 26",
      "UPDATE ducklake_table SET table_name = '``tick`` [l](http://evil)' WHERE table_id = 12 AND begin_snapshot = 35",
      "UPDATE ducklake_column SET column_name = '*bold*' || char(10) || '---' WHERE table_id = 12 AND column_id = 9",
      "UPDATE ducklake_column SET column_type = 'boolean`' WHERE table_id = 12 AND column_id = 9",
    );
    const text = comparisonMarkdown({
      connectionName: 'My *lake*\n# Not a heading',
      from: { id: 30 },
      to: { id: 35 },
      comparison: await compareCatalog(hostile, 30, 35),
    });

    const title = String.raw`# My \*lake\* \# Not a heading: @30 to @35`;
    expect(text).toContain('- table `main.a|b # Fake heading` is now ```main.``tick`` [l](http://evil)```');
    expect(text).toContain('- added `*bold* ---` (`` boolean` ``)');
    // Only the report itself makes headings.
    expect(text.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      title,
      '## Tables and views',
      '### Renamed (1)',
      '## Columns',
      '### ```main.``tick`` [l](http://evil)```',
    ]);
  });
});

describe('the limits of the report of a large catalog', () => {
  it('compares 200 tables and leaves out the 201st, lists 100 added tables and 50 column changes and counts the rest', async () => {
    // Snapshot 57 follows the latest one of the history catalog. 194 more tables exist at 56 and 57 (201 with the 7 of
    // the catalog), 101 tables begin at 57, and 51 columns begin at 57 on shop.customers (table 9, columns 1 to 3).
    const busy = await readerOf(
      historyFixture.sqlite,
      "INSERT INTO ducklake_snapshot VALUES (57, '2026-11-01 00:00:00+00', 36, 20, 28)",
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 193)
       INSERT INTO ducklake_table SELECT 1000 + i, 'old-' || i, 56, NULL, 1, printf('z%03d', i), 'z/', 1 FROM n`,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 100)
       INSERT INTO ducklake_table SELECT 2000 + i, 'new-' || i, 57, NULL, 1, printf('n%03d', i), 'n/', 1 FROM n`,
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 50)
       INSERT INTO ducklake_column SELECT 10 + i, 57, NULL, 9, 4 + i, printf('c%02d', i), 'int32', NULL, 'NULL', 1, NULL, 'literal', 'duckdb' FROM n`,
    );
    const comparison = await compareCatalog(busy, 56, 57);
    expect([comparison.compared, comparison.omitted, comparison.tables.length]).toEqual([200, 1, 1]);

    const text = await report(busy, 56, 57);
    expect(text).toContain('### Added (101)');
    expect(text.match(/^- table `shop\.n\d+`$/gm)).toHaveLength(100);
    expect(text).toContain('- table `shop.n099`\n- … 1 more omitted\n');
    const [, columns = ''] = text.split('### `shop.customers`');
    expect(columns.match(/^- added `c\d+` \(`int32`\)$/gm)).toHaveLength(50);
    expect(columns).toContain('- added `c49` (`int32`)\n- … 1 more omitted\n');

    // A smaller limit cuts the same lists shorter.
    const cut = await report(reader, 30, 35, { tables: 10, entries: 10, changes: 1 });
    expect(cut).toContain('- added `info.c` (`float64`)\n- … 2 more omitted\n');
    expect(cut).not.toContain('flag');
  });
});
