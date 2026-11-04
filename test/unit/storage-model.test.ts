import { describe, expect, it } from 'vitest';
import {
  barEntries,
  lastGrowth,
  matchingTables,
  mergeCandidates,
  rowsText,
  scheduledOf,
  shareText,
  smallFilesText,
  sortedTables,
  storageCards,
} from '../../src/storage-report/model';
import type { SortKey } from '../../src/storage-report/model';
import { lakeWide } from '../../src/shell/scope';
import { historyStorage, sampleStorage, table } from './storage-support';

const BAR_LIMIT = 30;

describe('the storage figures', () => {
  it('warns about files scheduled for deletion only once the oldest has waited longer than 7 days', () => {
    const at = (readAt: string, oldestScheduledAt: string | null = '2026-10-25T00:00:00.000Z', count = 3) =>
      scheduledOf({
        readAt,
        storage: {
          ...sampleStorage().storage,
          scheduledForDeletion: { count, oldestScheduledAt, split: null },
        },
      });
    expect(at('2026-11-01T00:00:00.000Z').severity).toBe('ok');
    expect(at('2026-11-01T00:00:00.001Z').severity).toBe('warning');
    expect(at('2026-11-20T12:00:00.000Z')).toMatchObject({ severity: 'warning', age: '26 days' });
    expect(at('2030-01-01T00:00:00.000Z', null).severity).toBe('ok');
    expect(at('2030-01-01T00:00:00.000Z', null, 0).severity).toBe('ok');
  });

  it('gives the key figures with their values, and turns overdue files into a warning', () => {
    const values = (cards: ReturnType<typeof storageCards>) =>
      cards.map(({ value, detail, severity }) => [value, detail, severity]);
    expect(values(storageCards(sampleStorage()))).toEqual([
      ['/lake/data/', undefined, 'ok'],
      ['no', undefined, 'ok'],
      ['@12', undefined, 'ok'],
      ['12', '7 MB', 'ok'],
      ['1', '1 MB', 'ok'],
      ['~1,240', undefined, 'ok'],
      ['2', '1 ready now, 1 waiting', 'ok'],
      ['100', '20 younger than 30 days', 'ok'],
    ]);

    const overdue = storageCards(
      sampleStorage({
        readAt: '2026-12-01T00:00:00.000Z',
        approximate: undefined,
        storage: { ...sampleStorage().storage, dataPath: null, encrypted: true },
      }),
    );
    expect(values(overdue)).toEqual([
      ['not set', undefined, 'ok'],
      ['yes', undefined, 'ok'],
      ['@12', undefined, 'ok'],
      ['12', '7 MB', 'ok'],
      ['1', '1 MB', 'ok'],
      ['1,240', undefined, 'ok'],
      ['2', '1 ready now, 1 waiting', 'warning'],
      ['100', '20 younger than 30 days', 'ok'],
    ]);
  });

  it('shows the numbers of the history fixture', async () => {
    const cards = storageCards(await historyStorage());
    expect(cards.map(({ value }) => value)).toEqual([
      'sqlite-files/',
      'no',
      '@56',
      '19',
      '1',
      '69',
      '5',
      '0',
    ]);
    expect(cards.find(({ label }) => label === 'Scheduled for deletion')?.severity).toBe('warning');

    // In the report of one schema the figures of the whole lake say so, the snapshots to expire among them.
    const schema = storageCards({
      ...(await historyStorage()),
      scope: { kind: 'schema', id: 1, name: 'shop' },
    });
    const lakeWideLabels = ['Data path', 'Encrypted', 'Scheduled for deletion', 'Snapshots to expire'].map(
      (label) => lakeWide({ kind: 'schema', id: 1, name: 'shop' }, label),
    );
    expect(lakeWideLabels.filter((label) => !schema.some((card) => card.label === label))).toEqual([]);
  });
});

describe('the list of tables', () => {
  const tables = [
    table(1, 'events', { files: 10, sizeBytes: 600, rows: 1200, smallFiles: 8 }),
    table(2, 'Customers', { schema: 'crm', files: 2, sizeBytes: 600, rows: 40, smallFiles: 0 }),
    table(3, 'notes', { files: 0, sizeBytes: 0, rows: 0 }),
    table(4, 'log', { files: 4, sizeBytes: 90, rows: 7, smallFiles: 4 }),
  ];

  it('calls out tables with many small files: from 3 of 5 and half of the files, the largest first', () => {
    const rows: [number, number, boolean][] = [
      [4, 4, false],
      [5, 2, false],
      [5, 3, true],
      [10, 5, true],
      [10, 4, false],
      [100, 0, false],
      [0, 0, false],
    ];
    for (const [files, small, many] of rows) {
      expect(
        smallFilesText(table(1, 't', { files, smallFiles: small })).includes('⚠'),
        `${files}/${small}`,
      ).toBe(many);
    }
    expect(smallFilesText(table(1, 't', { files: 9, smallFiles: 5 }))).toContain('5 of 9 (55.6 %)');
    expect(
      mergeCandidates([
        table(1, 'few', { files: 5, smallFiles: 5 }),
        table(2, 'ok', { files: 20, smallFiles: 1 }),
        table(3, 'many', { files: 50, smallFiles: 40 }),
      ]).map(({ name }) => name),
    ).toEqual(['many', 'few']);
  });

  it('finds tables by a part of schema.table in any case, and sorts by each column with name as tie-break', () => {
    const matching = (text: string) => matchingTables(tables, text).map(({ name }) => name);
    expect(matching('crm.cust')).toEqual(['Customers']);
    expect(matching(' SHOP.E ')).toEqual(['events']);
    expect(matching('shop')).toEqual(['events', 'notes', 'log']);
    expect(matching('  ')).toHaveLength(4);
    expect(matching('x.y')).toEqual([]);

    const before = tables.map(({ id }) => id);
    const orders: [SortKey, boolean, string[]][] = [
      ['name', false, ['Customers', 'events', 'log', 'notes']],
      ['name', true, ['notes', 'log', 'events', 'Customers']],
      ['files', true, ['events', 'log', 'Customers', 'notes']],
      ['files', false, ['notes', 'Customers', 'log', 'events']],
      ['size', true, ['Customers', 'events', 'log', 'notes']],
      ['size', false, ['notes', 'log', 'Customers', 'events']],
      ['rows', true, ['events', 'Customers', 'log', 'notes']],
      ['small', true, ['log', 'events', 'Customers', 'notes']],
      ['small', false, ['notes', 'Customers', 'events', 'log']],
    ];
    for (const [key, descending, expected] of orders) {
      expect(
        sortedTables(tables, { key, descending }).map(({ name }) => name),
        `${key} ${descending}`,
      ).toEqual(expected);
    }
    expect(tables.map(({ id }) => id)).toEqual(before);
  });

  it('writes the share of the lake, rows with a tilde when approximate, and a dash without bytes', () => {
    const storage = sampleStorage().storage;
    expect(shareText(table(1, 't', { sizeBytes: 2 * 1024 * 1024 }), { storage })).toBe('25 %');
    const empty = { dataFiles: { count: 0, sizeBytes: 0 }, deleteFiles: { count: 0, sizeBytes: 0 } };
    expect(shareText(table(1, 't'), { storage: { ...storage, ...empty } })).toBe('–');
    expect(rowsText(table(1, 't', { rows: 1234, approximate: true }))).toBe('~1,234');
    expect(rowsText(table(1, 't', { rows: 1234 }))).toBe('1,234');
  });
});

describe('the bars of the chart', () => {
  const many = (count: number) =>
    sampleStorage({
      tables: Array.from({ length: count }, (_, index) =>
        table(index + 1, `t${index + 1}`, { sizeBytes: (index + 1) * 1000 }),
      ),
      tableCount: count,
      storage: {
        ...sampleStorage().storage,
        dataFiles: { count: count, sizeBytes: (count * (count + 1) * 1000) / 2 },
        deleteFiles: { count: 0, sizeBytes: 0 },
      },
    });

  it('has a bar for each of the largest tables and one for all the others with the rest of the bytes', () => {
    const entries = barEntries(many(35));
    expect(entries).toHaveLength(BAR_LIMIT + 1);
    expect(entries[0]).toMatchObject({ sizeBytes: 35_000, tableId: 35 });
    expect(entries[BAR_LIMIT - 1]).toMatchObject({ sizeBytes: 6000, tableId: 6 });
    // The five smallest tables hold 1000 + 2000 + 3000 + 4000 + 5000 bytes.
    expect(entries.at(-1)).toMatchObject({ sizeBytes: 15_000, manySmallFiles: false });
    expect(entries.at(-1)?.tableId).toBeUndefined();

    expect(barEntries(many(BAR_LIMIT))).toHaveLength(BAR_LIMIT);
    // Tables the page does not hold count among the others.
    const unheld = barEntries({ ...many(BAR_LIMIT), tableCount: BAR_LIMIT + 20 });
    expect(unheld).toHaveLength(BAR_LIMIT + 1);
  });

  it('marks a table with many small files', () => {
    const [entry, second] = barEntries(sampleStorage());
    expect(entry).toMatchObject({ sizeBytes: 6 * 1024 * 1024, tableId: 1, manySmallFiles: true });
    expect(second).toMatchObject({ tableId: 2, manySmallFiles: false });
  });
});

describe('the last points of the growth', () => {
  it('are the newest 20, newest first', () => {
    const growth = Array.from({ length: 30 }, (_, index) => ({
      snapshot: index + 1,
      time: null,
      files: index,
      sizeBytes: index,
      compaction: false,
    }));
    expect(lastGrowth(growth).map((point) => point.snapshot)).toEqual(
      Array.from({ length: 20 }, (_, index) => 30 - index),
    );
    expect(lastGrowth(growth.slice(0, 3)).map((point) => point.snapshot)).toEqual([3, 2, 1]);
    expect(lastGrowth([])).toEqual([]);
  });
});
