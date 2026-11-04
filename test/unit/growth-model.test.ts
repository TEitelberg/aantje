import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CatalogReader } from '../../src/catalog/model';
import {
  formatDelta,
  formatMetric,
  formatStep,
  growthCards,
  hasExpired,
  growthModelOf,
  growthScopeLabel,
  seriesOf,
  summarizeGrowth,
  growthTableChoices,
} from '../../src/growth/model';
import type { GrowthData, Step } from '../../src/growth/model';
import { readGrowth } from '../../src/growth/read';
import { editedCatalogs } from '../support/edited-catalog';
import { HISTORY_ID, HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT } from '../support/expected-history';
import { historyFixture } from '../support/sources/history';
import { historyGrowth } from './growth-support';
import { snapshot, tableChange } from './snapshot-report-support';

const catalogs = editedCatalogs();
afterAll(() => catalogs.dispose());

let data: GrowthData;
let reader: CatalogReader;
beforeAll(async () => {
  reader = await catalogs.open(historyFixture.sqlite);
  data = await readGrowth(reader, 'History', null);
});

/** `[snapshot, rows, bytes, files]` of the chosen steps. */
const marks = (steps: readonly Step[], only: readonly number[]): number[][] =>
  steps
    .filter(({ id }) => only.includes(id))
    .map((step) => [step.id, step.total.rows, step.total.bytes, step.total.files]);

describe('reading the growth of the history fixture', () => {
  it('reads all 57 snapshots and the tables of the newest one, or only the newest snapshots with the changes before them summed up', async () => {
    expect(data.snapshots).toHaveLength(HISTORY_LATEST_SNAPSHOT + 1);
    expect([
      data.connection,
      data.focus,
      data.latest,
      data.more,
      data.inlinedMore,
      data.inlinedFailed,
    ]).toEqual(['History', null, HISTORY_LATEST_SNAPSHOT, false, false, false]);
    expect(data.tables.map(({ id, schema, name }) => [id, `${schema}.${name}`])).toEqual([
      [HISTORY_ID.evolving, 'main.evolved'],
      [HISTORY_ID.audit, 'shop.audit'],
      [HISTORY_ID.customers, 'shop.customers'],
      [HISTORY_ID.events, 'shop.events'],
      [HISTORY_ID.log, 'shop.log'],
      [HISTORY_ID.notes, 'shop.notes'],
      [HISTORY_ID.readings, 'shop.readings'],
    ]);
    expect(data.changes.every(({ snapshot: at }) => at !== null)).toBe(true);

    const newest = await readGrowth(reader, 'History', HISTORY_ID.events, undefined, 10);
    expect(newest.snapshots.map(({ id }) => id)).toEqual(
      Array.from({ length: 10 }, (_, index) => HISTORY_LATEST_SNAPSHOT - index),
    );
    expect([newest.more, newest.focus]).toEqual([true, HISTORY_ID.events]);
    expect(newest.changes.filter(({ snapshot: at }) => at === null).length).toBeGreaterThan(0);
    expect(newest.changes.every(({ snapshot: at }) => at === null || at >= 47)).toBe(true);
    // The state after a snapshot is the same whether or not older snapshots were read.
    expect(marks(seriesOf(newest, growthModelOf(newest), undefined), [47, 56])).toEqual(
      marks(seriesOf(data, growthModelOf(data), undefined), [47, 56]),
    );
    // The change of the oldest snapshot read is its own, not the whole state.
    expect(seriesOf(newest, growthModelOf(newest), undefined)[0]?.delta).toEqual({
      rows: 0,
      bytes: 0,
      files: 0,
    });
    expect((await historyGrowth(catalogs, { limit: 5 })).snapshots).toHaveLength(5);
  });

  it('says that inlined tables were left out beyond 200, and that the inlined rows could not be read', async () => {
    const copies = (extra: number): string[] =>
      Array.from(
        { length: extra },
        (_, i) =>
          `INSERT INTO ducklake_inlined_data_tables VALUES (${1000 + i}, 'ducklake_inlined_data_10_12', 12)`,
      );
    const exact = await readGrowth(
      await catalogs.open(historyFixture.sqlite, ...copies(199)),
      'History',
      null,
    );
    const more = await readGrowth(
      await catalogs.open(historyFixture.sqlite, ...copies(200)),
      'History',
      null,
    );
    const failed = await readGrowth(
      await catalogs.open(
        historyFixture.sqlite,
        "INSERT INTO ducklake_inlined_data_tables VALUES (11, 'ducklake_inlined_data_11_1', 1)",
      ),
      'History',
      null,
    );

    expect([exact.inlinedMore, exact.inlinedFailed]).toEqual([false, false]);
    expect([more.inlinedMore, more.inlinedFailed]).toEqual([true, false]);
    expect([failed.inlinedMore, failed.inlinedFailed]).toEqual([false, true]);
    expect(failed.changes.length).toBeGreaterThan(0);
  });
});

describe('the state after each snapshot', () => {
  it('follows the rows, bytes and files of a table, with delete files, inlined rows, dropped tables and compactions', () => {
    const events = seriesOf(data, growthModelOf(data), HISTORY_ID.events);
    expect(marks(events, [5, 6, 7, 8, 9, 10, 22, 23, 56])).toEqual([
      [5, 0, 0, 0],
      [6, 6, 1917, 3],
      [7, 7, 2530, 4],
      [8, 47, 3858, 5],
      [9, 47, 3858, 5],
      [10, 51, 5736, 8],
      [22, 51, 5736, 8],
      [23, 52, 6349, 9],
      [56, 52, 6349, 9],
    ]);
    expect(events.filter(({ changed }) => changed).map(({ id }) => id)).toEqual([4, 5, 6, 7, 8, 9, 10, 23]);
    expect(events.find(({ id }) => id === 8)?.delta).toEqual({ rows: 40, bytes: 1328, files: 1 });
    expect(events.find(({ id }) => id === 9)?.delta).toEqual({ rows: 0, bytes: 0, files: 0 });

    // The delete file counts the deletes of snapshots 17 and 18, so 17 is not exact.
    const customers = seriesOf(data, growthModelOf(data), HISTORY_ID.customers);
    expect(marks(customers, [15, 16, 17, 18, 23, 25, 56])).toEqual([
      [15, 0, 0, 0],
      [16, 4, 495, 1],
      [17, 3, 2066, 2],
      [18, 3, 2066, 2],
      [23, 4, 2513, 3],
      [25, 5, 2960, 4],
      [56, 5, 2960, 4],
    ]);
    expect(customers.filter(({ approximate }) => approximate).map(({ id }) => id)).toEqual([17]);

    const notes = seriesOf(data, growthModelOf(data), HISTORY_ID.notes);
    expect(marks(notes, [19, 20, 21, 22, 56])).toEqual([
      [19, 0, 0, 0],
      [20, 3, 0, 0],
      [21, 3, 0, 0],
      [22, 2, 0, 0],
      [56, 2, 0, 0],
    ]);
    expect(notes.find(({ id }) => id === 21)?.changed).toBe(true);

    const old = seriesOf(data, growthModelOf(data), HISTORY_ID.oldStuff);
    expect(marks(old, [43, 44, 45, 56])).toEqual([
      [43, 0, 0, 0],
      [44, 2, 207, 1],
      [45, 0, 0, 0],
      [56, 0, 0, 0],
    ]);
    const log = seriesOf(data, growthModelOf(data), HISTORY_ID.log);
    expect(marks(log, [50, 51, 54, 55, 56])).toEqual([
      [50, 0, 0, 0],
      [51, 4, 750, 1],
      [54, 4, 750, 1],
      [55, 4, 750, 1],
      [56, 5, 1081, 2],
    ]);
    expect(log.filter(({ approximate }) => approximate).map(({ id }) => id)).toEqual([51, 52, 53]);
  });

  it('is the sum of all tables for the whole lake, equals what the tree reads, and marks changes for the tables of the selection only', async () => {
    const lake = seriesOf(data, growthModelOf(data), undefined);

    for (const step of lake) {
      let rows = 0;
      let bytes = 0;
      let files = 0;
      for (const schema of await reader.schemas(step.id)) {
        for (const table of await reader.tables(schema.id, step.id)) {
          rows += table.stats.rows + (table.id === HISTORY_ID.notes ? inlinedAt(step.id) : 0);
          bytes += table.stats.sizeBytes;
          files += table.stats.files;
        }
      }
      expect([step.total.rows, step.total.bytes, step.total.files], `snapshot ${step.id}`).toEqual([
        rows,
        bytes,
        files,
      ]);
    }
    expect(marks(lake, [6, 17, 45, 56])).toEqual([
      [6, 6, 1917, 3],
      [17, 58, 8347, 11],
      [45, 66, 11896, 17],
      [56, 71, 12977, 19],
    ]);

    const readings = seriesOf(data, growthModelOf(data), HISTORY_ID.readings);
    expect(readings.filter(({ changed }) => changed).map(({ id }) => id)).toEqual([11, 12, 13, 14]);
    // A snapshot of a macro changes no table.
    expect(lake.find(({ id }) => id === 46)?.changed).toBe(false);
    expect(lake.find(({ id }) => id === 23)?.changed).toBe(true);
    expect(lake.find(({ id }) => id === HISTORY_SNAPSHOT.createMain)?.changed).toBe(false);

    // Changes at a snapshot that is not among those read go into the next snapshot that is.
    const small: GrowthData = {
      ...data,
      snapshots: [snapshot(12, [tableChange(1, 'inserted')]), snapshot(10, [])],
      changes: [
        { tableId: 1, snapshot: null, rows: 5, sizeBytes: 50, files: 1, partialFiles: 0 },
        { tableId: 1, snapshot: 11, rows: 2, sizeBytes: 20, files: 1, partialFiles: 0 },
        { tableId: 2, snapshot: 12, rows: -1, sizeBytes: -10, files: 0, partialFiles: 0 },
      ],
    };
    expect(
      seriesOf(small, growthModelOf(small), undefined).map((step) => [
        step.id,
        step.total.rows,
        step.delta.rows,
      ]),
    ).toEqual([
      [10, 5, 0],
      [12, 6, 1],
    ]);
  });
});

/** A step of a series with a total and a change of the rows. */
const stepOf = (id: number, rows: number, delta: number, approximate = false): Step => ({
  id,
  time: '2026-10-20T10:00:00.000Z',
  author: null,
  message: null,
  changed: true,
  approximate,
  total: { rows, bytes: 0, files: 0 },
  delta: { rows: delta, bytes: 0, files: 0 },
});

describe('the table choices and the key figures', () => {
  it('lists the tables of the newest snapshot and the dropped ones that the snapshots name, tells dropped twins apart by id', () => {
    const choices = growthTableChoices(data, growthModelOf(data));
    expect(choices.map(({ id, label }) => [id, label])).toEqual([
      [HISTORY_ID.evolving, 'main.evolved'],
      [HISTORY_ID.audit, 'shop.audit'],
      [HISTORY_ID.customers, 'shop.customers'],
      [HISTORY_ID.events, 'shop.events'],
      [HISTORY_ID.log, 'shop.log'],
      [HISTORY_ID.notes, 'shop.notes'],
      [HISTORY_ID.oldStuff, 'shop.old_stuff (dropped)'],
      [HISTORY_ID.readings, 'shop.readings'],
    ]);
    expect(growthScopeLabel(choices, HISTORY_ID.events)).toBe('shop.events');
    expect(growthScopeLabel(choices, 999)).toContain('999');

    const twins: GrowthData = {
      ...data,
      tables: [],
      snapshots: [
        snapshot(2, [tableChange(9, 'deleted', 'shop', 'tmp'), tableChange(4, 'deleted', 'shop', 'tmp')]),
        snapshot(1, [tableChange(5, 'deleted', 'shop', 'only')]),
      ],
    };
    const twinChoices = growthTableChoices(twins, growthModelOf(twins)).map(({ id, label }) => [id, label]);
    expect(twinChoices.map(([id]) => id)).toEqual([5, 4, 9]);
    expect(new Set(twinChoices.map(([, label]) => label)).size).toBe(3);
  });

  it('finds the first highest value and the largest increase and decrease of a metric, and shows them as cards', () => {
    const steps = seriesOf(data, growthModelOf(data), HISTORY_ID.events);
    const summary = summarizeGrowth(steps, 'rows');
    expect([summary?.first.id, summary?.last.id, summary?.highest.id]).toEqual([0, 56, 23]);
    expect([summary?.increase?.id, summary?.increase?.delta.rows]).toEqual([8, 40]);
    expect(summary?.decrease).toBeUndefined();

    const customers = seriesOf(data, growthModelOf(data), HISTORY_ID.customers);
    const people = summarizeGrowth(customers, 'rows');
    expect([people?.highest.id, people?.decrease?.id, people?.decrease?.delta.rows]).toEqual([25, 17, -1]);

    const falling = [stepOf(0, 5, 0), stepOf(1, 3, -2)];
    expect(summarizeGrowth(falling, 'rows')?.increase).toBeUndefined();
    expect(growthCards(falling, 'rows')[2]?.value).toBe('none');
    expect(summarizeGrowth([stepOf(0, 0, 0), stepOf(1, 5, 5), stepOf(2, 10, 5)], 'rows')?.increase?.id).toBe(
      1,
    );
    expect(summarizeGrowth([], 'rows')).toBeUndefined();

    expect(growthCards([stepOf(0, 1, 1), stepOf(1, 3, 2, true)], 'rows')[0]?.value).toBe('~3');
    expect(growthCards(customers, 'rows').map(({ value }) => value)).toEqual(['5', '5', '+4', '-1', '57']);
    // The delete file of snapshot 17 is the largest increase (+1571 bytes); the size never falls.
    expect(growthCards(customers, 'bytes').map(({ value }) => value)).toEqual([
      '2.9 KB',
      '2.9 KB',
      '+1.5 KB',
      'none',
      '57',
    ]);
    expect(growthCards([], 'rows').map(({ value }) => value)).toEqual(['none', 'none', 'none', 'none', '0']);

    const at = (id: number) => customers.find((step) => step.id === id) as Step;
    expect(formatMetric('rows', 1234567)).toBe('1,234,567');
    expect(formatMetric('bytes', 2048)).toBe('2 KB');
    expect(formatDelta('rows', 0)).toBe('0');
    expect(formatDelta('files', -2)).toBe('-2');
    expect(formatDelta('bytes', 1536)).toBe('+1.5 KB');
    expect(formatStep('rows', at(17))).toBe('~3');
    expect(formatStep('rows', at(18))).toBe('3');

    const only = (ids: readonly number[], more = false): GrowthData => ({
      ...data,
      more,
      snapshots: data.snapshots.filter(({ id }) => ids.includes(id)),
    });
    expect(hasExpired(only([5, 4, 3]))).toBe(true);
    expect(hasExpired(only([56, 55, 54, 0]))).toBe(true);
    expect(hasExpired(only([3, 2, 1, 0]))).toBe(false);
    expect(hasExpired(only([]))).toBe(false);
  });
});

/** Inlined rows of shop.notes that are valid at a snapshot, from the begin and end snapshots in the fixture. */
function inlinedAt(at: number): number {
  const rows: [number, number | null][] = [
    [20, 21],
    [20, null],
    [20, 22],
    [21, null],
  ];
  return rows.filter(([begin, end]) => at >= begin && (end === null || at < end)).length;
}
