import { describe, expect, it } from 'vitest';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { SchemaInfo, TableInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { storageMarkdown } from '../../src/storage-report/markdown';
import { TABLE_LIMIT } from '../../src/storage-report/model';
import { readStorage } from '../../src/storage-report/read';
import type { StorageReader } from '../../src/storage-report/read';
import {
  EVENTS_STATISTICS,
  HISTORY_DATA_PATH,
  HISTORY_ID,
  LAKE_GROWTH,
  LAKE_SMALL_FILES,
  SCHEDULED_FOR_DELETION,
} from '../support/expected-history';
import { wasmPath } from '../support/fixtures';
import { historyFixture, historySources } from '../support/sources/history';
import { READ_AT, historyStorage, sampleStorage, table } from './storage-support';

/** The rows of a table of the document, header and separator left out. */
function rowsAfter(markdown: string, header: string): string[] {
  const lines = markdown.split('\n');
  const start = lines.indexOf(header);
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('| ')) break;
    rows.push(line);
  }
  return rows;
}

describe('reading the storage of the history fixture', () => {
  for (const source of historySources) {
    const skipReason = source.skipReason();

    it.skipIf(skipReason !== undefined)(
      `reads the totals, every table with its small files, the growth, and the snapshot that is shown, ${source.name}`,
      async () => {
        const reader = createCatalogReader(await source.open());
        let data;
        let first;
        try {
          data = await readStorage(reader, 'History lake', 56, READ_AT);
          first = await readStorage(reader, 'History lake', 0, READ_AT);
        } finally {
          await reader.close();
        }

        expect(data).toMatchObject({
          connection: 'History lake',
          snapshot: 56,
          readAt: READ_AT.toISOString(),
          smallFileBytes: 16 * 1024 * 1024,
          rows: 69,
          tableCount: 7,
          storage: {
            dataPath: HISTORY_DATA_PATH[source.name],
            encrypted: false,
            dataFiles: { count: 19 },
            deleteFiles: { count: 1 },
            scheduledForDeletion: { count: SCHEDULED_FOR_DELETION.length },
          },
        });
        expect(data.approximate).toBeUndefined();
        expect(
          data.tables.map(({ schema, name, files, rows, smallFiles }) => [
            `${schema}.${name}`,
            files,
            rows,
            smallFiles,
          ]),
        ).toEqual([
          ['shop.events', 9, 52, 9],
          ['shop.customers', 4, 5, 4],
          ['main.evolved', 2, 2, 2],
          ['shop.log', 2, 5, 2],
          ['shop.readings', 1, 4, 1],
          ['shop.audit', 1, 1, 1],
          ['shop.notes', 0, 0, 0],
        ]);
        expect(data.tables[0]).toMatchObject({
          id: HISTORY_ID.events,
          schemaId: HISTORY_ID.shopSchema,
          sizeBytes: EVENTS_STATISTICS.dataBytes,
        });
        expect(data.tables.filter((candidate) => candidate.smallFiles > 0)).toHaveLength(
          LAKE_SMALL_FILES.length,
        );
        for (const [id, files, small] of LAKE_SMALL_FILES) {
          expect(data.tables.find((candidate) => candidate.id === id)).toMatchObject({
            files,
            smallFiles: small,
          });
        }
        expect(data.growth.map((point) => point.snapshot)).toEqual(LAKE_GROWTH.map(([snapshot]) => snapshot));
        expect(data.growth.at(-1)).toMatchObject({
          files: data.storage.dataFiles.count,
          sizeBytes: data.storage.dataFiles.sizeBytes + data.storage.deleteFiles.sizeBytes,
        });
        expect(data.growthMerged).toBeUndefined();

        expect(first).toMatchObject({ snapshot: 0, rows: 0, tableCount: 0, tables: [], growth: [] });
        expect(first.storage.dataFiles).toEqual({ count: 0, sizeBytes: 0 });
        expect(first.storage.scheduledForDeletion.count).toBe(SCHEDULED_FOR_DELETION.length);
      },
    );
  }

  it('shows the numbers of the history fixture in the document and calls the rows approximate when any table is', async () => {
    const markdown = storageMarkdown(await historyStorage());
    const lines = markdown.split('\n');

    expect(lines[0]).toBe('# Storage of History lake');
    expect(lines).toContain('| Snapshot | @56 |');
    expect(lines).toContain('| Data files | 19 files, 11.7 KB |');
    expect(lines).toContain('| Delete files | 1 file, 954 B |');
    expect(lines).toContain('| Rows | 69 |');
    expect(lines).toContain('| Points | 17 (@6 to @56) |');
    expect(rowsAfter(markdown, '| Table | Files | Size | Rows |')).toEqual([
      '| `shop.events` | 9 | 6.2 KB | 52 |',
      '| `shop.customers` | 4 | 2.9 KB | 5 |',
      '| `main.evolved` | 2 | 1.5 KB | 2 |',
      '| `shop.log` | 2 | 1.1 KB | 5 |',
      '| `shop.readings` | 1 | 545 B | 4 |',
      '| `shop.audit` | 1 | 480 B | 1 |',
      '| `shop.notes` | 0 | 0 B | 0 |',
    ]);
    expect(rowsAfter(markdown, '| Table | Files | Small files |')).toEqual([
      '| `shop.events` | 9 | 9 of 9 (100 %) ⚠ many small files |',
    ]);
    expect(rowsAfter(markdown, '| Snapshot | Time | Size | Files | Note |')).toHaveLength(17);

    const older = await historyStorage(53);
    expect(older.tables.find((candidate) => candidate.name === 'log')).toMatchObject({ approximate: true });
    expect(older.approximate).toBe(true);
  });
});

describe('reading many tables', () => {
  /** A reader with schemas that hold the given tables; it records the snapshots it was asked for and how many schemas run at the same time. */
  function fakeReader(schemas: Record<string, TableInfo[]>, atOnce = { running: 0, most: 0 }) {
    const list: SchemaInfo[] = Object.keys(schemas).map((name, index) => ({
      id: index,
      name,
      comment: null,
    }));
    const asked: number[] = [];
    const reader: StorageReader = {
      schemas: (snapshot) => {
        asked.push(snapshot);
        return Promise.resolve(list);
      },
      tables: async (schemaId, snapshot) => {
        asked.push(snapshot);
        atOnce.running++;
        atOnce.most = Math.max(atOnce.most, atOnce.running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        atOnce.running--;
        return schemas[list[schemaId]?.name ?? ''] ?? [];
      },
      storage: (snapshot) => {
        asked.push(snapshot);
        return Promise.resolve(sampleStorage().storage);
      },
      smallFiles: (snapshot) => {
        asked.push(snapshot);
        return Promise.resolve([]);
      },
      lakeGrowth: (snapshot) => {
        asked.push(snapshot);
        return Promise.resolve({ growth: [] });
      },
    };
    return { reader, asked, atOnce };
  }

  const info = (id: number, name: string, sizeBytes: number): TableInfo => ({
    id,
    schemaId: 0,
    name,
    comment: null,
    stats: { rows: 5, files: 1, sizeBytes },
  });
  const twelve = () =>
    Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`s${index}`, [info(index, `t${index}`, 10)]]),
    );

  it('reads everything at the shown snapshot, a few schemas at a time, keeps the largest tables and counts the small files per table', async () => {
    const { reader, asked, atOnce } = fakeReader(twelve());
    const data = await readStorage(reader, 'Lake', 7, READ_AT);
    expect(new Set(asked)).toEqual(new Set([7]));
    expect(atOnce.most).toBe(4);
    expect(data.tableCount).toBe(12);

    const all = Array.from({ length: TABLE_LIMIT + 5 }, (_, index) =>
      info(index, `t${index}`, (index + 1) * 10),
    );
    const large = fakeReader({
      a: all.filter((_, index) => index % 2 === 0),
      b: all.filter((_, index) => index % 2 === 1),
    });
    const big = await readStorage(large.reader, 'Lake', 3, READ_AT);
    expect(big.tableCount).toBe(TABLE_LIMIT + 5);
    expect(big.tables).toHaveLength(TABLE_LIMIT);
    expect(big.tables[0]).toMatchObject({ name: `t${TABLE_LIMIT + 4}`, sizeBytes: (TABLE_LIMIT + 5) * 10 });
    expect(big.tables.at(-1)).toMatchObject({ name: 't5' });
    expect(big.rows).toBe((TABLE_LIMIT + 5) * 5);

    const small = fakeReader({
      a: [
        { ...info(1, 'many', 30), stats: { rows: 5, files: 9, sizeBytes: 30 } },
        { ...info(2, 'large', 20), stats: { rows: 5, files: 4, sizeBytes: 20 } },
      ],
    });
    small.reader.smallFiles = () => Promise.resolve([{ tableId: 1, files: 9, small: 2 }]);
    const withSmall = await readStorage(small.reader, 'Lake', 3, READ_AT);
    expect(withSmall.tables.map((t) => [t.name, t.files, t.smallFiles])).toEqual([
      ['many', 9, 2],
      ['large', 4, 0],
    ]);
  });

  it('stops with ABORTED instead of reading the next schemas when the signal is aborted, whatever the reader does with it', async () => {
    const controller = new AbortController();
    const { reader, asked } = fakeReader(twelve());
    const tables = reader.tables;
    reader.tables = async (...args) => {
      controller.abort();
      return tables(...args);
    };

    await expect(readStorage(reader, 'Lake', 7, READ_AT, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    // The first four schemas were being read; the other eight never were.
    expect(asked.filter((snapshot) => snapshot === 7).length).toBeLessThan(12);

    const real = createCatalogReader(await openSqlite({ path: historyFixture.sqlite, wasmPath }));
    try {
      await expect(readStorage(real, 'History lake', 56, READ_AT, AbortSignal.abort())).rejects.toMatchObject(
        { code: 'ABORTED' },
      );
    } finally {
      await real.close();
    }
  });
});

describe('the document', () => {
  it('lists the storage, the largest tables, the tables with many small files and the growth', () => {
    expect(storageMarkdown(sampleStorage()).split('\n')).toEqual([
      '# Storage of Lake',
      '',
      'Files that are visible at the shown snapshot; the figures of a table cover its data files and delete files.',
      '',
      '| Property | Value |',
      '| --- | --- |',
      '| Data path | `/lake/data/` |',
      '| Encrypted | no |',
      '| Snapshot | @12 |',
      '| Data files | 12 files, 7 MB |',
      '| Delete files | 1 file, 1 MB |',
      '| Rows | ~1,240 |',
      '| Scheduled for deletion | 2 files scheduled: 1 file ready to delete now, 1 file waiting until 2026-11-01 08:00:00 UTC; oldest scheduled 2026-10-30 08:00:00 UTC |',
      '| Snapshots to expire | 100 snapshots expirable now, 20 younger than 30 days (the default of aantje; the lake sets no expire_older_than) |',
      '',
      'Expire Snapshots as generated names an age of 30 days, because a call without older_than expires nothing when the lake sets no expire_older_than.',
      '',
      '## Largest tables',
      '',
      '| Table | Files | Size | Rows |',
      '| --- | --- | --- | --- |',
      '| `shop.events` | 10 | 6 MB | 1,200 |',
      '| `shop.customers` | 2 | 2 MB | ~40 |',
      '| `shop.notes` | 0 | 0 B | 0 |',
      '',
      'Rows are those of the data files; inlined rows are not included, and `~` marks a count that is only approximate.',
      '',
      '## Tables with many small files',
      '',
      'At least 5 data files, 50 % or more of them under 16 MB; merging adjacent files compacts them.',
      '',
      '| Table | Files | Small files |',
      '| --- | --- | --- |',
      '| `shop.events` | 10 | 8 of 10 (80 %) ⚠ many small files |',
      '',
      '## Growth',
      '',
      '| Property | Value |',
      '| --- | --- |',
      '| Points | 3 (@3 to @12) |',
      '| Latest | 13 files, 8 MB |',
      '| Largest | 8 MB at @12 |',
      '',
      'The state after each snapshot that added or removed files, newest first. `Compaction` marks a snapshot that merged adjacent files.',
      '',
      '| Snapshot | Time | Size | Files | Note |',
      '| --- | --- | --- | --- | --- |',
      '| @12 | expired | 8 MB | 13 | Compaction |',
      '| @7 | 2026-10-15 10:00:00 UTC | 7 MB | 12 |  |',
      '| @3 | 2026-10-01 10:00:00 UTC | 3 MB | 4 |  |',
      '',
    ]);
  });

  it('warns once the oldest scheduled file has waited longer than the cleanup threshold, and not before', () => {
    const waiting = (readAt: string) =>
      storageMarkdown(sampleStorage({ readAt })).includes('Clean Up Old Files is due');

    expect(waiting('2026-11-06T08:00:00.000Z')).toBe(false);
    expect(waiting('2026-11-06T08:00:01.000Z')).toBe(true);
  });

  it('filters and limits the tables, the small files and the growth', () => {
    const filtered = storageMarkdown(sampleStorage(), { filter: ' EVENT ' });
    expect(filtered).toContain('Filter: `EVENT`. 1 of 3 tables match.');
    expect(rowsAfter(filtered, '| Table | Files | Size | Rows |')).toEqual([
      '| `shop.events` | 10 | 6 MB | 1,200 |',
    ]);
    expect(storageMarkdown(sampleStorage(), { filter: 'customers' })).not.toContain(
      '## Tables with many small files',
    );

    const sixty = Array.from({ length: 60 }, (_, index) =>
      table(index, `t${index + 1}`, {
        sizeBytes: (index + 1) * 1000,
        files: 10 + index,
        smallFiles: 10 + index,
      }),
    );
    const matching = storageMarkdown(sampleStorage({ tables: sixty, tableCount: 60 }), { filter: 't' });
    expect(matching).toContain('Filter: `t`. 60 of 60 tables match.');
    expect(rowsAfter(matching, '| Table | Files | Size | Rows |')).toHaveLength(50);

    const markdown = storageMarkdown(sampleStorage({ tables: sixty, tableCount: 60 }));
    const rows = rowsAfter(markdown, '| Table | Files | Size | Rows |');
    expect(rows).toHaveLength(50);
    expect(rows[0]).toBe('| `shop.t60` | 69 | 58.6 KB | 5 |');
    expect(rows.at(-1)).toBe('| `shop.t11` | 20 | 10.7 KB | 5 |');
    const candidates = rowsAfter(markdown, '| Table | Files | Small files |');
    expect(candidates).toHaveLength(50);
    expect(candidates[0]).toBe('| `shop.t60` | 69 | 69 of 69 (100 %) ⚠ many small files |');
    expect(markdown.split('\n').filter((line) => line === '… 10 more omitted (limit: 50).')).toHaveLength(2);
    expect(storageMarkdown(sampleStorage({ tables: sixty.slice(0, 50), tableCount: 50 }))).not.toContain(
      'more omitted (limit: 50)',
    );
    expect(storageMarkdown(sampleStorage({ tableCount: 1001 }))).toContain('998');

    const point = (snapshot: number, sizeBytes: number) => ({
      snapshot,
      time: null,
      files: snapshot,
      sizeBytes,
      compaction: false,
    });
    const summary = storageMarkdown(
      sampleStorage({ growth: [point(1, 1024), point(2, 9 * 1024), point(3, 9 * 1024), point(4, 3 * 1024)] }),
    );
    expect(summary).toContain('| Latest | 4 files, 3 KB |');
    expect(summary).toContain('| Largest | 9 KB at @2 |');

    const growth = Array.from({ length: 25 }, (_, index) => point(index + 1, (index + 1) * 100));
    const long = storageMarkdown(sampleStorage({ growth, growthMerged: true }));
    const growthRows = rowsAfter(long, '| Snapshot | Time | Size | Files | Note |');
    expect(growthRows).toHaveLength(20);
    expect(growthRows[0]).toBe('| @25 | expired | 2.4 KB | 25 |  |');
    expect(long).toContain('… 5 more omitted (limit: 20).');
  });

  it('shows catalog text literally: no Markdown, no extra table cell, no line break', () => {
    const markdown = storageMarkdown({
      ...sampleStorage(),
      connection: 'My *lake*\nx',
      storage: { ...sampleStorage().storage, dataPath: '`/p|a`th\n# h' },
      tables: [
        table(1, 'x\n\n[l](http://evil)', { schema: 'a|b' }),
        table(2, '**<b>**|', { schema: 's`', sizeBytes: 10 }),
      ],
      tableCount: 2,
    });

    const lines = markdown.split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        String.raw`# Storage of My \*lake\* x`,
        '| Data path | `` `/p\\|a`th # h `` |',
        '| `a\\|b.x [l](http://evil)` | 1 | 1 KB | 5 |',
        '| ``s`.**<b>**\\|`` | 1 | 10 B | 5 |',
      ]),
    );
    expect(lines.filter((line) => line.startsWith('# '))).toEqual([String.raw`# Storage of My \*lake\* x`]);
    for (const row of rowsAfter(markdown, '| Table | Files | Size | Rows |')) {
      // Four cells: the pipes of the names are escaped.
      expect(row.replaceAll('\\|', '').split('|')).toHaveLength(6);
    }
  });
});
