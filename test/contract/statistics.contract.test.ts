import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, TableStatistics } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { editedCatalogs } from '../support/edited-catalog';
import { ID, LATEST_SNAPSHOT, SNAPSHOT } from '../support/expected';
import {
  CUSTOMERS_STATISTICS,
  EVENTS_FILE_SIZES,
  EVENTS_STATISTICS,
  HISTORY_ID,
  HISTORY_LATEST_SNAPSHOT,
  HISTORY_SNAPSHOT,
  LOG_GROWTH,
} from '../support/expected-history';
import { fixturePath, wasmPath } from '../support/fixtures';
import { catalogSources } from '../support/sources';
import { historyFixture, historySources } from '../support/sources/history';

/** Same statements as the main fixture, written by DuckDB 1.5 (DuckLake specification 1.0). */
const FIXTURE_V1_0 = fileURLToPath(new URL('../fixtures/ducklake-1.0.sqlite', import.meta.url));

const { events, customers, notes, log } = HISTORY_ID;

const range = (stats: TableStatistics, name: string): [string | null, string | null] => {
  const column = stats.columns.find((candidate) => candidate.path.join('.') === name);
  return [column?.min ?? null, column?.max ?? null];
};

const ranges = (stats: TableStatistics): Record<string, [string | null, string | null]> =>
  Object.fromEntries(
    stats.columns.map((column) => [column.path.join('.'), range(stats, column.path.join('.'))]),
  );

for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `table statistics on the history fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      let raw: Driver;

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
        raw = await source.open();
      });
      afterAll(async () => {
        await reader.close();
        await raw.close();
      });

      it('gives files, rows, bytes, bins, partitions, columns and growth of shop.events at the latest snapshot', async () => {
        const stats = await reader.tableStatistics(events, HISTORY_LATEST_SNAPSHOT);
        expect(EVENTS_FILE_SIZES.reduce((sum, size) => sum + size, 0)).toBe(EVENTS_STATISTICS.dataBytes);
        expect(stats).toMatchObject({
          snapshot: HISTORY_LATEST_SNAPSHOT,
          rows: EVENTS_STATISTICS.rows,
          files: EVENTS_STATISTICS.files,
          deleteFiles: 0,
          dataBytes: EVENTS_STATISTICS.dataBytes,
          deleteBytes: 0,
          largestFileBytes: EVENTS_STATISTICS.largestFileBytes,
        });
        expect(stats.approximate).toBeUndefined();

        // Every file lands in a bin of halves of the largest file.
        expect(stats.sizeHistogram.map((bin) => bin.files)).toEqual(EVENTS_STATISTICS.histogramFiles);
        expect(stats.sizeHistogram.map((bin) => bin.sizeBytes)).toEqual(EVENTS_STATISTICS.histogramBytes);
        expect([...stats.sizeHistogram.map((bin) => bin.fromBytes), stats.largestFileBytes]).toEqual(
          EVENTS_STATISTICS.histogramEdges,
        );
        expect(stats.sizeHistogram.map((bin) => bin.toBytes)).toEqual(
          EVENTS_STATISTICS.histogramEdges.slice(1),
        );
        expect(stats.smallFiles).toBe(EVENTS_STATISTICS.smallFiles);
        expect(stats.smallFileBytes).toBe(16 * 1024 * 1024);

        // The partitions of the current partitioning, largest first, with the files of the earlier one counted apart.
        expect(stats.partitioning?.partitioning).toMatchObject({ id: HISTORY_ID.eventsPartitionByMonth });
        expect(stats.partitioning?.partitions).toEqual(EVENTS_STATISTICS.partitions);
        expect(stats.partitioning?.rest).toBeUndefined();
        expect(stats.partitioning?.earlierFiles).toBe(EVENTS_STATISTICS.earlierFiles);
        expect(stats.partitioning?.partial).toBeUndefined();
        expect(stats.partitioning?.evenness?.coefficientOfVariation).toBeCloseTo(
          EVENTS_STATISTICS.evenness.coefficientOfVariation,
          6,
        );
        expect(stats.partitioning?.evenness?.gini).toBeCloseTo(EVENTS_STATISTICS.evenness.gini, 6);

        expect(
          stats.columns.map(({ path, type, nullable, nullRatio }) => [
            path.join('.'),
            type,
            nullable,
            nullRatio,
          ]),
        ).toEqual([
          ['id', 'int32', false, 0],
          ['kind', 'varchar', true, 0],
          ['ts', 'timestamp', true, 0],
          ['amount', 'decimal(10,2)', true, 0],
        ]);
        expect(ranges(stats)).toEqual(EVENTS_STATISTICS.ranges);
        expect(stats.columnsPartial).toBeUndefined();

        expect(stats.growth.map((point) => [point.snapshot, point.files, point.sizeBytes])).toEqual(
          EVENTS_STATISTICS.growth,
        );
        expect(stats.growth.every((point) => !point.compaction)).toBe(true);
        expect(stats.growth.every((point) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(point.time ?? ''))).toBe(true);
        expect(stats.growthMerged).toBeUndefined();
      });

      it('shows the files, partitions, evenness and ranges of shop.events at snapshot 8 only', async () => {
        const stats = await reader.tableStatistics(events, HISTORY_SNAPSHOT.insertEventsBulk);
        expect(stats).toMatchObject({
          snapshot: HISTORY_SNAPSHOT.insertEventsBulk,
          rows: 47,
          files: 5,
          dataBytes: 3858,
          largestFileBytes: 1328,
        });
        expect(stats.partitioning?.partitioning).toMatchObject({ id: HISTORY_ID.eventsPartitionByYear });
        expect(stats.partitioning?.partitions).toEqual(EVENTS_STATISTICS.partitionsAtSnapshot8);
        expect(stats.partitioning?.earlierFiles).toBe(0);
        expect(stats.growth.map((point) => point.snapshot)).toEqual([6, 7, 8]);
        // One partition holds 43 of the 47 rows: more uneven than the finished table.
        expect(stats.partitioning?.evenness?.coefficientOfVariation).toBeCloseTo(
          EVENTS_STATISTICS.evennessAtSnapshot8.coefficientOfVariation,
          6,
        );
        expect(stats.partitioning?.evenness?.gini).toBeCloseTo(EVENTS_STATISTICS.evennessAtSnapshot8.gini, 6);
        expect(ranges(stats)).toEqual(EVENTS_STATISTICS.rangesAtSnapshot8);
      });

      it('shows no partitioning for unpartitioned tables and counts the delete files of shop.customers', async () => {
        expect(
          (await reader.tableStatistics(customers, HISTORY_LATEST_SNAPSHOT)).partitioning,
        ).toBeUndefined();
        expect(
          (await reader.tableStatistics(events, HISTORY_SNAPSHOT.createEvents)).partitioning,
        ).toBeUndefined();

        const stats = await reader.tableStatistics(customers, HISTORY_LATEST_SNAPSHOT);
        const [{ total }] = (await raw.query(
          'SELECT CAST(SUM(file_size_bytes) AS BIGINT) AS total FROM ducklake_delete_file WHERE end_snapshot IS NULL',
        )) as [{ total: number }];
        expect(stats).toMatchObject({ ...CUSTOMERS_STATISTICS, deleteBytes: total });
        expect(stats.growth.at(-1)?.sizeBytes).toBe(CUSTOMERS_STATISTICS.dataBytes + total);
      });

      it('marks the snapshot that compacted shop.log and flags numbers that cover more than the snapshot', async () => {
        const stats = await reader.tableStatistics(log, HISTORY_LATEST_SNAPSHOT);
        expect(
          stats.growth.map((point) => [point.snapshot, point.files, point.sizeBytes, point.compaction]),
        ).toEqual(LOG_GROWTH);
        expect(stats.approximate).toBeUndefined();

        const mergedFile = await reader.tableStatistics(log, HISTORY_SNAPSHOT.insertLog3);
        expect(mergedFile).toMatchObject({ files: 1, rows: 4, approximate: true });
      });

      it('agrees with the numbers of the explorer tree for every table at three snapshots', async () => {
        const snapshots = [
          HISTORY_SNAPSHOT.updateCustomer,
          HISTORY_SNAPSHOT.insertLog3,
          HISTORY_LATEST_SNAPSHOT,
        ];
        for (const snapshot of snapshots) {
          for (const schema of [HISTORY_ID.mainSchema, HISTORY_ID.shopSchema]) {
            for (const table of await reader.tables(schema, snapshot)) {
              const stats = await reader.tableStatistics(table.id, snapshot);
              expect(
                {
                  rows: stats.rows,
                  files: stats.files,
                  sizeBytes: stats.dataBytes + stats.deleteBytes,
                  approximate: stats.approximate,
                },
                `${table.name} at snapshot ${snapshot}`,
              ).toEqual({
                rows: table.stats.rows,
                files: table.stats.files,
                sizeBytes: table.stats.sizeBytes,
                approximate: table.stats.approximate,
              });
            }
          }
        }
      });

      it('shows a table with only inlined rows as empty, lists nested columns in table order and gives nothing for a missing table', async () => {
        const inlined = await reader.tableStatistics(notes, HISTORY_LATEST_SNAPSHOT);
        expect(inlined).toMatchObject({
          rows: 0,
          files: 0,
          deleteFiles: 0,
          dataBytes: 0,
          smallFiles: 0,
          sizeHistogram: [],
          growth: [],
        });
        expect(inlined.columns.map((column) => [column.path.join('.'), column.nullRatio])).toEqual([
          ['id', null],
          ['body', null],
        ]);
        expect(range(inlined, 'id')).toEqual(['1', '3']);

        const nested = await reader.tableStatistics(HISTORY_ID.evolving, HISTORY_LATEST_SNAPSHOT);
        expect(nested.columns.map((column) => column.path.join('.'))).toEqual([
          'id',
          'title',
          'info',
          'info.a',
          'info.b',
          'info.c',
          'n',
          'flag',
        ]);
        expect(range(nested, 'info')).toEqual([null, null]);
        expect(range(nested, 'info.c')).toEqual(['2.5', '2.5']);

        const missing = await reader.tableStatistics(9999, HISTORY_LATEST_SNAPSHOT);
        expect(missing).toMatchObject({ rows: 0, files: 0, columns: [], growth: [], sizeHistogram: [] });
        expect(missing.partitioning).toBeUndefined();
      });

      it('stops with ABORTED when the signal is aborted and hands the signal to every statement, so that Cancel stops the heaviest one too', async () => {
        await expect(
          reader.tableStatistics(events, HISTORY_LATEST_SNAPSHOT, AbortSignal.abort()),
        ).rejects.toMatchObject({ code: 'ABORTED' });
        // The reader is still usable afterwards.
        expect((await reader.tableStatistics(events, HISTORY_LATEST_SNAPSHOT)).files).toBe(9);

        for (const snapshot of [HISTORY_LATEST_SNAPSHOT, HISTORY_SNAPSHOT.insertEventsBulk]) {
          const controller = new AbortController();
          const signals: (AbortSignal | undefined)[] = [];
          const spied = createCatalogReader({
            query: (sql, params, options) => {
              signals.push(options?.signal);
              return raw.query(sql, params, options);
            },
            close: () => Promise.resolve(),
          });
          await spied.tableStatistics(events, snapshot, controller.signal);
          // a partitioned table: summary, bins, partitionings, columns, nulls, info, growth, ranges, buckets, earlier files
          expect(signals.length, `statements at snapshot ${snapshot}`).toBeGreaterThanOrEqual(10);
          expect(signals.filter((signal) => signal !== controller.signal)).toEqual([]);
        }
      });
    },
  );
}

for (const source of catalogSources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `table statistics on the main fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      let raw: Driver;
      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
        raw = await source.open();
      });
      afterAll(async () => {
        await reader.close();
        await raw.close();
      });

      it('counts the files of sales.orders with their sizes from the catalog, and gives null ratios and ranges of its columns', async () => {
        const stats = await reader.tableStatistics(ID.orders, LATEST_SNAPSHOT);
        const sizeOf = async (table: string): Promise<number> =>
          Number(
            (
              (
                await raw.query(
                  `SELECT CAST(SUM(file_size_bytes) AS BIGINT) AS total FROM ${table} WHERE table_id = ${ID.orders}`,
                )
              )[0] as { total: number }
            ).total,
          );
        expect(stats).toMatchObject({ rows: 2, files: 1, deleteFiles: 1, snapshot: LATEST_SNAPSHOT });
        expect(stats.dataBytes).toBe(await sizeOf('ducklake_data_file'));
        expect(stats.deleteBytes).toBe(await sizeOf('ducklake_delete_file'));
        expect(stats.growth.map((point) => [point.snapshot, point.files])).toEqual([
          [SNAPSHOT.insertOrders, 1],
          [SNAPSHOT.deleteOrder2, 1],
        ]);
        expect(stats.growth.at(-1)?.sizeBytes).toBe(stats.dataBytes + stats.deleteBytes);

        // DuckLake counts a missing parent (a NULL struct, an empty or NULL list or map) as NULL for the fields below it:
        // attrs.key is 2/3 although a key is never NULL. So there is none below a parent that can be missing.
        expect(stats.columns.map((column) => [column.path.join('.'), column.type, column.nullRatio])).toEqual(
          [
            ['id', 'int32', 0],
            ['customer', 'struct', null],
            ['customer.name', 'varchar', null],
            ['customer.tags', 'list', null],
            ['customer.tags.element', 'varchar', null],
            ['attrs', 'map', null],
            ['attrs.key', 'varchar', null],
            ['attrs.value', 'int32', null],
            ['amount', 'decimal(10,2)', 0],
            ['created', 'timestamp', 0],
          ],
        );
        expect(ranges(stats)).toMatchObject({
          id: ['1', '3'],
          'customer.name': ['a', 'b'],
          amount: ['1.50', '3.00'],
          created: ['2026-01-01 00:00:00', '2026-01-03 00:00:00'],
          customer: [null, null],
        });
      });

      it('lists the columns of the snapshot and none that a later snapshot added', async () => {
        const names = async (snapshot: number) =>
          (await reader.tableStatistics(ID.plain, snapshot)).columns.map((column) => column.path.join('.'));
        expect(await names(SNAPSHOT.createPlain)).toEqual(['x', 'y']);
        expect(await names(LATEST_SNAPSHOT)).toEqual(['x', 'y', 'z']);
      });
    },
  );
}

describe('table statistics of catalogs of other generations', () => {
  it('reads the same numbers from a catalog of specification 1.0 as the current specification gives', async () => {
    const reader = createCatalogReader(await openSqlite({ path: FIXTURE_V1_0, wasmPath }));
    try {
      const stats = await reader.tableStatistics(ID.orders, LATEST_SNAPSHOT);
      expect(stats).toMatchObject({ rows: 2, files: 1, deleteFiles: 1 });
      expect(stats.columns.map((column) => column.nullRatio)).toEqual([
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        0,
      ]);
      expect(range(stats, 'id')).toEqual(['1', '3']);
    } finally {
      await reader.close();
    }
  });

  it('leaves the time of an expired snapshot empty in the history fixture', async () => {
    const reader = createCatalogReader(await openSqlite({ path: historyFixture.expired, wasmPath }));
    try {
      const stats = await reader.tableStatistics(events, HISTORY_LATEST_SNAPSHOT);
      expect(stats.growth.map((point) => point.snapshot)).toEqual([6, 7, 8, 10, 23]);
      expect(stats.growth.every((point) => point.time === null)).toBe(true);
    } finally {
      await reader.close();
    }
  });
});

describe('table statistics of edited catalogs', () => {
  const edited = editedCatalogs();
  afterAll(() => edited.dispose());
  const main = fixturePath('ducklake.sqlite');
  const MIB = 1_048_576;

  const dataFile = (id: number, table: number, begin: number, size: number, extra = '') =>
    `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start${extra ? ', partition_id' : ''})
     VALUES (${id}, ${table}, ${begin}, NULL, ${id}, 'f${id}.parquet', 1, 'parquet', 10, ${size}, ${id * 10}${extra ? `, ${extra}` : ''})`;

  const deleteFile = (
    id: number,
    ofFile: number,
    begin: number,
    end: number | null,
    size: number,
    deleted: number,
  ) =>
    `INSERT INTO ducklake_delete_file (delete_file_id, table_id, begin_snapshot, end_snapshot, data_file_id, path, path_is_relative, format, delete_count, file_size_bytes, footer_size)
     VALUES (${id}, 5, ${begin}, ${end ?? 'NULL'}, ${ofFile}, 'd${id}.parquet', 1, 'parquet', ${deleted}, ${size}, 0)`;
  const endFile = (id: number, snapshot: number) =>
    `UPDATE ducklake_data_file SET end_snapshot = ${snapshot} WHERE data_file_id = ${id}`;
  /** Statistics of one column in one file; `null` counts are what DuckLake writes for an INTERVAL column. */
  const fileStat = (file: number, column: number, values: number | null, nulls: number | null) =>
    `INSERT INTO ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value)
     VALUES (${file}, 5, ${column}, 1, ${values ?? 'NULL'}, ${nulls ?? 'NULL'}, NULL, NULL)`;
  const growthOf = (stats: TableStatistics) =>
    stats.growth.map((point) => [point.snapshot, point.files, point.sizeBytes]);

  it('counts the files that snapshots add and remove, also of the same size, and files without a size as empty', async () => {
    // Two files of the same size that one snapshot added count as two.
    const same = await edited.open(main, dataFile(100, 5, 13, 5000), dataFile(101, 5, 13, 5000));
    const sameStats = await same.tableStatistics(ID.plain, LATEST_SNAPSHOT);
    expect(growthOf(sameStats)).toEqual([[13, 2, 10_000]]);
    expect(sameStats.files).toBe(2);

    // A removed file leaves the count at the snapshot that ended it.
    const removed = await edited.open(
      main,
      dataFile(100, 5, 12, 5000),
      dataFile(101, 5, 12, 7000),
      'UPDATE ducklake_data_file SET end_snapshot = 13 WHERE data_file_id = 100',
    );
    const removedStats = await removed.tableStatistics(ID.plain, LATEST_SNAPSHOT);
    expect(growthOf(removedStats)).toEqual([
      [12, 2, 12_000],
      [13, 1, 7000],
    ]);
    expect(removedStats).toMatchObject({ files: 1, dataBytes: 7000 });

    // Files without a size do not fail and count as empty.
    const unsized = await edited.open(
      main,
      dataFile(100, 5, 13, 5000),
      'UPDATE ducklake_data_file SET file_size_bytes = NULL',
    );
    const unsizedStats = await unsized.tableStatistics(ID.plain, LATEST_SNAPSHOT);
    expect(unsizedStats).toMatchObject({ files: 1, rows: 10, dataBytes: 0, largestFileBytes: 0 });
    expect(unsizedStats.sizeHistogram.map((bin) => bin.sizeBytes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(growthOf(unsizedStats)).toEqual([[13, 1, 0]]);
  });

  it('follows a delete file that a newer one replaced, and one that ends with its data file or earlier', async () => {
    const replaced = await edited.open(
      main,
      dataFile(100, 5, 12, 5000),
      deleteFile(101, 100, 12, 13, 2000, 2),
      deleteFile(102, 100, 13, null, 3000, 4),
    );
    const now = await replaced.tableStatistics(ID.plain, LATEST_SNAPSHOT);
    expect(now).toMatchObject({ rows: 6, files: 1, dataBytes: 5000, deleteFiles: 1, deleteBytes: 3000 });
    expect(growthOf(now)).toEqual([
      [12, 1, 7000],
      [13, 1, 8000],
    ]);
    const before = await replaced.tableStatistics(ID.plain, 12);
    expect(before).toMatchObject({ rows: 8, deleteFiles: 1, deleteBytes: 2000 });

    const ended = await edited.open(
      main,
      dataFile(100, 5, 12, 5000),
      endFile(100, 15),
      deleteFile(101, 100, 12, 14, 2000, 2),
      deleteFile(102, 100, 14, null, 3000, 4),
    );
    // The catalog has 13 snapshots; asking for a later one is how a longer history is simulated.
    const stats = await ended.tableStatistics(ID.plain, 20);
    expect(growthOf(stats)).toEqual([
      [12, 1, 7000],
      [14, 1, 8000],
      [15, 0, 0],
    ]);
    expect(stats).toMatchObject({ files: 0, rows: 0, deleteFiles: 0, deleteBytes: 0 });
  });

  it('marks a compaction by the id of the table at the snapshot that did it, and calls rows approximate only beyond a file', async () => {
    const compactionsOf = async (changes: string) => {
      const reader = await edited.open(
        main,
        dataFile(100, 5, 12, 5000),
        `UPDATE ducklake_snapshot_changes SET changes_made = '${changes}' WHERE snapshot_id = 13`,
      );
      return (await reader.tableStatistics(ID.plain, LATEST_SNAPSHOT)).growth.map((point) => [
        point.snapshot,
        point.files,
        point.sizeBytes,
        point.compaction,
      ]);
    };
    // The snapshot added no file, yet it is marked.
    expect(await compactionsOf('merge_adjacent:5')).toEqual([
      [12, 1, 5000, false],
      [13, 1, 5000, true],
    ]);
    // Snapshot 13 names the table with the id 50: that is another table.
    expect((await compactionsOf('merge_adjacent:50,altered_table:5')).map((point) => point[3])).toEqual([
      false,
    ]);
    expect((await compactionsOf('altered_table:5,merge_adjacent:5')).map((point) => point[3])).toEqual([
      false,
      true,
    ]);

    const partial = await edited.open(
      main,
      dataFile(100, 5, 12, 5000),
      'UPDATE ducklake_data_file SET partial_max = 13 WHERE data_file_id = 100',
    );
    expect((await partial.tableStatistics(ID.plain, 12)).approximate).toBe(true);
    expect((await partial.tableStatistics(ID.plain, 13)).approximate).toBeUndefined();
  });

  it('sorts files into bins by the largest file at the snapshot, counts the small ones and draws the small file limit', async () => {
    // plain (table 5) gets 30 files: twenty of 1 MiB, ten of 128 MiB.
    const many = await edited.open(
      main,
      `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
       SELECT 100 + i, 5, 13, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 1000, CASE WHEN i <= 20 THEN ${MIB} ELSE ${128 * MIB} END, i * 1000 FROM n`,
    );
    const stats = await many.tableStatistics(ID.plain, LATEST_SNAPSHOT);
    expect(stats).toMatchObject({
      files: 30,
      rows: 30_000,
      dataBytes: 20 * MIB + 10 * 128 * MIB,
      smallFiles: 20,
    });
    expect(stats.largestFileBytes).toBe(128 * MIB);
    // 1 MiB is exactly a 128th of the largest file: the lower edge of bin 1 belongs to the bin.
    expect(stats.sizeHistogram.map((bin) => bin.files)).toEqual([0, 20, 0, 0, 0, 0, 0, 10]);
    expect(stats.sizeHistogram[1]).toMatchObject({ fromBytes: MIB, toBytes: 2 * MIB, sizeBytes: 20 * MIB });
    expect(stats.sizeHistogram[7]).toMatchObject({ fromBytes: 64 * MIB, toBytes: 128 * MIB });

    // A tiny file beside a huge one goes into the first bin, not into the next.
    const tiny = await edited.open(main, dataFile(100, 5, 13, 100), dataFile(101, 5, 13, 1_000_000));
    expect(
      (await tiny.tableStatistics(ID.plain, LATEST_SNAPSHOT)).sizeHistogram.map((bin) => bin.files),
    ).toEqual([1, 0, 0, 0, 0, 0, 0, 1]);

    // The bins are scaled by the largest file that exists at the snapshot, not by a later one.
    const later = await edited.open(main, dataFile(100, 5, 12, 1000), dataFile(101, 5, 13, 1_000_000));
    const earlier = await later.tableStatistics(ID.plain, 12);
    expect(earlier.largestFileBytes).toBe(1000);
    expect(earlier.sizeHistogram.map((bin) => bin.files)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);

    // A file of exactly the small file limit is not small.
    const limit = await edited.open(main, dataFile(100, 5, 13, 16 * MIB - 1), dataFile(101, 5, 13, 16 * MIB));
    expect((await limit.tableStatistics(ID.plain, LATEST_SNAPSHOT)).smallFiles).toBe(1);
  });

  it('merges the points of a very long history and keeps the last state, with all 500 points kept and 501 merged', async () => {
    const manySnapshots = (count: number) =>
      `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
       SELECT 1000 + i, 5, 100 + i, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 1, 1000, i FROM n`;
    // 1200 snapshots that each add one 1000 byte file; their rows in ducklake_snapshot are gone, as after an expiry.
    const stats = await (await edited.open(main, manySnapshots(1200))).tableStatistics(ID.plain, 5000);
    expect(stats.growthMerged).toBe(true);
    expect(stats.growth.length).toBe(400);
    expect(stats.growth[0]).toEqual({
      snapshot: 103,
      time: null,
      files: 3,
      sizeBytes: 3000,
      compaction: false,
    });
    expect(stats.growth.at(-1)).toMatchObject({ snapshot: 1300, files: 1200, sizeBytes: 1_200_000 });

    const exact = await (await edited.open(main, manySnapshots(500))).tableStatistics(ID.plain, 5000);
    expect(exact.growthMerged).toBeUndefined();
    expect(exact.growth).toHaveLength(500);
    const over = await (await edited.open(main, manySnapshots(501))).tableStatistics(ID.plain, 5000);
    expect(over.growthMerged).toBe(true);
    expect(over.growth).toHaveLength(251);
    expect(over.growth.at(-1)).toMatchObject({ snapshot: 601, files: 501 });
  });

  describe('partitions', () => {
    // 60 partitions by the value of column x; partition i holds one file of i * 1000 bytes and i rows
    const partitioned = [
      'INSERT INTO ducklake_partition_info (partition_id, table_id, begin_snapshot, end_snapshot) VALUES (20, 5, 12, NULL)',
      "INSERT INTO ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (20, 5, 0, 1, 'identity')",
      `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start, partition_id)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       SELECT 200 + i, 5, 12, NULL, i, 'f' || i || '.parquet', 1, 'parquet', i, i * 1000, i, 20 FROM n`,
      `INSERT INTO ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 60)
       SELECT 200 + i, 5, 0, 'p' || i FROM n`,
    ];
    const valueOf = (value: string | null): string => (value === null ? 'NULL' : `'${value}'`);
    /** A data file of the partitioning 20 with the value of its one key. */
    const inPartition = (id: number, begin: number, size: number, value: string | null) => [
      dataFile(id, 5, begin, size, '20'),
      `INSERT INTO ducklake_file_partition_value VALUES (${id}, 5, 0, ${valueOf(value)})`,
    ];

    it('names the largest 50 partitions, sums up the rest and measures the evenness over all of them', async () => {
      const reader = await edited.open(main, ...partitioned);
      const { partitioning } = await reader.tableStatistics(ID.plain, LATEST_SNAPSHOT);
      expect(partitioning?.partitions).toHaveLength(50);
      expect(partitioning?.partitions[0]).toEqual({ values: ['p60'], files: 1, sizeBytes: 60_000, rows: 60 });
      expect(partitioning?.partitions.at(-1)).toMatchObject({ values: ['p11'], sizeBytes: 11_000 });
      // partitions 1..10 are the rest: 55 000 bytes and 55 rows in ten files
      expect(partitioning?.rest).toEqual({ partitions: 10, files: 10, sizeBytes: 55_000, rows: 55 });
      expect(partitioning?.partial).toBeUndefined();
      // Sizes 1..n (times 1000): CV = sqrt((n^2 - 1) / 12) / ((n + 1) / 2) and Gini = (n - 1) / (3n).
      expect(partitioning?.evenness?.coefficientOfVariation).toBeCloseTo(
        Math.sqrt((3600 - 1) / 12) / 30.5,
        9,
      );
      expect(partitioning?.evenness?.gini).toBeCloseTo(59 / 180, 9);

      // The rest sums up the files of the partitions beyond the 50 largest, not only their number.
      const twoFiles = await edited.open(
        main,
        ...partitioned.slice(0, 2),
        `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start, partition_id)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 104)
         SELECT 300 + i, 5, 12, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 10, ((i + 1) / 2) * 1000, i, 20 FROM n`,
        `INSERT INTO ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 104)
         SELECT 300 + i, 5, 0, 'p' || ((i + 1) / 2) FROM n`,
      );
      // 52 partitions of two files each: the partitions 1 and 2 are the rest
      const beyond = (await twoFiles.tableStatistics(ID.plain, LATEST_SNAPSHOT)).partitioning;
      expect(beyond?.partitions[0]).toEqual({ values: ['p52'], files: 2, sizeBytes: 104_000, rows: 20 });
      expect(beyond?.rest).toEqual({ partitions: 2, files: 4, sizeBytes: 6000, rows: 40 });
    });

    it('counts the files of a partition, the empty ones, the ended ones and the delete files, and has no evenness for one partition', async () => {
      const head = partitioned.slice(0, 2);
      const statsOf = async (...statements: string[]) =>
        (await (await edited.open(main, ...head, ...statements)).tableStatistics(ID.plain, LATEST_SNAPSHOT))
          .partitioning;

      const single = await statsOf(
        dataFile(300, 5, 12, 5000, '20'),
        `INSERT INTO ducklake_file_partition_value VALUES (300, 5, 0, 'only')`,
      );
      expect(single?.partitions).toHaveLength(1);
      expect(single?.evenness).toBeNull();

      // Every file counts, also when the files have the same size.
      const same = await statsOf(
        ...inPartition(300, 12, 500, 'a'),
        ...inPartition(301, 12, 500, 'a'),
        ...inPartition(302, 12, 700, 'b'),
      );
      expect(same?.partitions).toEqual([
        { values: ['a'], files: 2, sizeBytes: 1000, rows: 20 },
        { values: ['b'], files: 1, sizeBytes: 700, rows: 10 },
      ]);

      // A partition whose files have no size is empty instead of failing.
      const unsized = await statsOf(
        ...inPartition(300, 12, 500, 'a'),
        'UPDATE ducklake_data_file SET file_size_bytes = NULL',
      );
      expect(unsized?.partitions).toEqual([{ values: ['a'], files: 1, sizeBytes: 0, rows: 10 }]);

      // Files that ended are left out; files of no or of another partitioning are earlier ones.
      const ended = await statsOf(
        ...inPartition(300, 12, 500, 'a'),
        ...inPartition(301, 12, 900, 'a'),
        endFile(301, 13),
        dataFile(302, 5, 12, 100),
        dataFile(303, 5, 12, 100, '19'),
      );
      expect(ended?.partitions).toEqual([{ values: ['a'], files: 1, sizeBytes: 500, rows: 10 }]);
      expect(ended?.earlierFiles).toBe(2);

      // The delete file that is in force counts with its bytes and deleted rows.
      const deleted = await statsOf(
        ...inPartition(300, 12, 5000, 'a'),
        deleteFile(101, 300, 12, 13, 2000, 2),
        deleteFile(102, 300, 13, null, 3000, 4),
      );
      expect(deleted?.partitions).toEqual([{ values: ['a'], files: 1, sizeBytes: 8000, rows: 6 }]);
    });

    it('reads 10 000 partitions completely, and says when there are more', { timeout: 120_000 }, async () => {
      /** `count` partitions p1..pN of N * 10 bytes. */
      const manyPartitions = (count: number) => [
        ...partitioned.slice(0, 2),
        `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start, partition_id)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         SELECT 300 + i, 5, 12, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 1, i * 10, i, 20 FROM n`,
        `INSERT INTO ducklake_file_partition_value (data_file_id, table_id, partition_key_index, partition_value)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         SELECT 300 + i, 5, 0, 'p' || i FROM n`,
      ];
      const exact = (await (await edited.open(main, ...manyPartitions(10_000))).tableStatistics(ID.plain, 12))
        .partitioning;
      expect(exact?.partial).toBeUndefined();
      expect(exact?.rest?.partitions).toBe(9950);

      // 10 002 partitions: the two smallest are not read, the largest one is
      const more = (await (await edited.open(main, ...manyPartitions(10_002))).tableStatistics(ID.plain, 12))
        .partitioning;
      expect(more?.partial).toBe(true);
      expect(more?.partitions[0]).toMatchObject({ values: ['p10002'], sizeBytes: 100_020 });
      expect(more?.partitions).toHaveLength(50);
      // p3..p9952 are the rest: 10 * (3 + ... + 9952) bytes
      expect(more?.rest).toEqual({
        partitions: 9950,
        files: 9950,
        sizeBytes: 10 * ((9952 * 9953) / 2 - 3),
        rows: 9950,
      });
    });

    it('orders partitions of the same size by their values with NULL last, and survives a missing table of partition values', async () => {
      const reader = await edited.open(
        main,
        'INSERT INTO ducklake_partition_info (partition_id, table_id, begin_snapshot, end_snapshot) VALUES (21, 5, 12, NULL)',
        "INSERT INTO ducklake_partition_column (partition_id, table_id, partition_key_index, column_id, transform) VALUES (21, 5, 0, 1, 'identity'), (21, 5, 1, 2, 'identity')",
        ...[
          [400, 'a', '2'],
          [401, 'a', '1'],
          [402, null, '1'],
          [403, 'b', '0'],
        ].flatMap(([id, first, second]) => [
          dataFile(Number(id), 5, 12, 1000, '21'),
          `INSERT INTO ducklake_file_partition_value VALUES (${id}, 5, 0, ${valueOf(first as string | null)}), (${id}, 5, 1, ${valueOf(second as string)})`,
        ]),
      );
      const { partitioning } = await reader.tableStatistics(ID.plain, LATEST_SNAPSHOT);
      expect(partitioning?.partitions.map((partition) => partition.values)).toEqual([
        ['a', '1'],
        ['a', '2'],
        ['b', '0'],
        [null, '1'],
      ]);

      const missing = await edited.open(
        main,
        ...partitioned.slice(0, 3),
        'DROP TABLE ducklake_file_partition_value',
      );
      const shown = (await missing.tableStatistics(ID.plain, LATEST_SNAPSHOT)).partitioning;
      expect(shown?.partitioning.columns).toHaveLength(1);
      expect(shown?.partitions).toEqual([]);
    });
  });

  describe('column statistics', () => {
    const columns: readonly (readonly [string, string])[] = [
      ['i', 'int64'],
      ['big', 'uint64'],
      ['d', 'decimal(10,2)'],
      ['day', 'date'],
      ['tz', 'timestamptz'],
      ['s', 'varchar'],
      ['f', 'float64'],
      ['blobby', 'blob'],
      ['allnull', 'int32'],
    ];
    // Per column and per file: [values, nulls, min, max]. Text order and the order of the type differ for most of them.
    const stat = (
      values: number,
      nulls: number,
      min: string | null,
      max: string | null = min,
    ): [number, number, string | null, string | null] => [values, nulls, min, max];
    const fileStats: Record<string, [number, number, string | null, string | null][]> = {
      i: [stat(8, 2, '9'), stat(10, 0, '10', '100'), stat(2, 8, '2', '30')],
      big: [stat(10, 0, '18446744073709551614'), stat(10, 0, '18446744073709551615'), stat(10, 0, '5')],
      d: [stat(10, 0, '9.50'), stat(10, 0, '10.25'), stat(10, 0, '-3.10')],
      day: [stat(10, 0, '2025-12-31'), stat(10, 0, '2026-01-02'), stat(10, 0, '2025-03-01')],
      tz: [
        stat(10, 0, '2026-01-01 10:00:00+00'),
        stat(10, 0, '2026-01-01 11:00:00+02'),
        stat(10, 0, '2026-01-01 08:30:00+00'),
      ],
      s: [stat(5, 5, '～'), stat(5, 5, '😀'), stat(5, 5, 'a')],
      f: [stat(10, 0, '2.5'), stat(10, 0, '10'), stat(10, 0, '-0.5')],
      blobby: [stat(10, 0, 'x'), stat(10, 0, 'y'), stat(10, 0, 'z')],
      allnull: [stat(0, 10, null), stat(0, 10, null), stat(0, 10, null)],
    };
    const quote = (value: string | null): string =>
      value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
    const mixed = [
      'DELETE FROM ducklake_column WHERE table_id = 5',
      'DELETE FROM ducklake_table_column_stats WHERE table_id = 5',
      `INSERT INTO ducklake_column (column_id, begin_snapshot, end_snapshot, table_id, column_order, column_name, column_type, nulls_allowed, parent_column) VALUES ${columns
        .map(
          ([name, type], index) =>
            `(${index + 1}, 12, NULL, 5, ${index + 1}, '${name}', '${type}', ${name === 'i' ? 0 : 1}, NULL)`,
        )
        .join(', ')}`,
      ...[200, 201, 202].map((id) => dataFile(id, 5, 12, MIB)),
      `INSERT INTO ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value) VALUES ${columns
        .flatMap(([name], column) =>
          (fileStats[name] ?? []).map(
            ([values, nulls, min, max], file) =>
              `(${200 + file}, 5, ${column + 1}, 10, ${values}, ${nulls}, ${quote(min)}, ${quote(max)})`,
          ),
        )
        .join(', ')}`,
      // The table statistics of the latest state differ on purpose from what the files give.
      `INSERT INTO ducklake_table_column_stats (table_id, column_id, contains_null, min_value, max_value) VALUES (5, 1, 1, '-100', '1000'), (5, 6, 0, 'first', 'last')`,
    ];

    it('compares ranges by the order of each type, derives null ratios from all files and takes the whole-table range at the latest snapshot', async () => {
      const reader = await edited.open(main, ...mixed);
      // Snapshot 12 is not the latest one: the ranges of the three files are combined.
      const stats = await reader.tableStatistics(ID.plain, 12);
      expect(ranges(stats)).toEqual({
        i: ['2', '100'],
        big: ['5', '18446744073709551615'],
        d: ['-3.10', '10.25'],
        day: ['2025-03-01', '2026-01-02'],
        // 11:00 at +02:00 is 09:00 UTC: the text order would call it the latest.
        tz: ['2026-01-01 08:30:00+00', '2026-01-01 10:00:00+00'],
        // By bytes: 'a' < the character U+FF5E < the emoji, although a UTF-16 order puts the emoji first.
        s: ['a', '😀'],
        f: ['-0.5', '10'],
        // A blob has no order that the text gives: no range instead of a wrong one.
        blobby: [null, null],
        allnull: [null, null],
      });
      expect(stats.columns.map((column) => [column.path[0], column.nullRatio])).toEqual([
        ['i', 10 / 30],
        ['big', 0],
        ['d', 0],
        ['day', 0],
        ['tz', 0],
        ['s', 0.5],
        ['f', 0],
        ['blobby', 0],
        ['allnull', 1],
      ]);

      const latest = await reader.tableStatistics(ID.plain, LATEST_SNAPSHOT);
      expect(range(latest, 'i')).toEqual(['-100', '1000']);
      expect(range(latest, 's')).toEqual(['first', 'last']);
      // No row in the table statistics, no range, even though the files have one.
      expect(range(latest, 'd')).toEqual([null, null]);
      expect(latest.columns.map((column) => column.nullable)).toEqual([
        false,
        ...Array.from({ length: 8 }, () => true),
      ]);
    });

    it('derives null shares only from complete counts of the files that exist at the snapshot, and shows columns without statistics', async () => {
      // Only the files that exist at the snapshot count.
      const timed = await edited.open(
        main,
        dataFile(200, 5, 12, 100),
        dataFile(201, 5, 13, 100),
        fileStat(200, 1, 10, 0),
        fileStat(201, 1, 0, 10),
      );
      const share = async (snapshot: number) =>
        (await timed.tableStatistics(ID.plain, snapshot)).columns[0]?.nullRatio;
      expect(await share(12)).toBe(0);
      expect(await share(LATEST_SNAPSHOT)).toBe(0.5);

      // No share for a column whose counts the catalog leaves empty, as DuckLake does for INTERVAL.
      const interval = await edited.open(
        main,
        dataFile(200, 5, 12, 100),
        dataFile(201, 5, 12, 100),
        fileStat(200, 1, null, null),
        fileStat(201, 1, null, null),
        fileStat(200, 2, 10, 5),
        fileStat(201, 2, 10, 5),
      );
      for (const snapshot of [12, LATEST_SNAPSHOT]) {
        const stats = await interval.tableStatistics(ID.plain, snapshot);
        expect(stats.columns.map((column) => [column.path[0], column.nullRatio])).toEqual([
          ['x', null],
          ['y', 1 / 3],
          ...(snapshot === 12 ? [] : [['z', null]]),
        ]);
      }

      // None either when only some files lack the counts, instead of one from the others.
      const some = await edited.open(
        main,
        dataFile(200, 5, 12, 100),
        dataFile(201, 5, 12, 100),
        fileStat(200, 1, 10, 0),
        fileStat(201, 1, null, null),
      );
      expect((await some.tableStatistics(ID.plain, 12)).columns[0]?.nullRatio).toBeNull();

      // customer (a struct), its tags (a list) and attrs (a map) cannot be NULL themselves; an empty list or map still has no element
      const notNull = await edited.open(
        main,
        'UPDATE ducklake_column SET nulls_allowed = 0 WHERE table_id = 2 AND column_id IN (2, 4, 6)',
      );
      const orders = await notNull.tableStatistics(ID.orders, LATEST_SNAPSHOT);
      expect(orders.columns.map((column) => [column.path.join('.'), column.nullRatio])).toEqual([
        ['id', 0],
        ['customer', null],
        ['customer.name', 1 / 3],
        ['customer.tags', null],
        ['customer.tags.element', null],
        ['attrs', null],
        ['attrs.key', null],
        ['attrs.value', null],
        ['amount', 0],
        ['created', 0],
      ]);

      // Without the tables of statistics the columns still show.
      const bare = await edited.open(
        main,
        'DROP TABLE ducklake_file_column_stats',
        'DROP TABLE ducklake_table_column_stats',
      );
      for (const snapshot of [12, LATEST_SNAPSHOT]) {
        const stats = await bare.tableStatistics(ID.orders, snapshot);
        expect(stats.columns.map((column) => column.path[0])).toContain('amount');
        expect(stats.columns.every((column) => column.nullRatio === null && column.min === null)).toBe(true);
        expect(stats.files).toBe(1);
      }
    });

    it(
      'says when the ranges come from part of the file statistics, and not for exactly 50 000 rows',
      { timeout: 120_000 },
      async () => {
        /** `count` files with one statistics row each: the last file has the smallest value. */
        const manyRanges = (count: number) => [
          `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         SELECT 1000 + i, 5, 12, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 1, 100, i FROM n`,
          `INSERT INTO ducklake_file_column_stats (data_file_id, table_id, column_id, column_size_bytes, value_count, null_count, min_value, max_value)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
         SELECT 1000 + i, 5, 1, 1, 1, 0, CASE WHEN i = ${count} THEN '-1' ELSE CAST(i AS VARCHAR) END, CAST(i AS VARCHAR) FROM n`,
        ];
        // 50 001 rows: the last one has the smallest value but is not read.
        const over = await (await edited.open(main, ...manyRanges(50_001))).tableStatistics(ID.plain, 12);
        expect(over.columnsPartial).toBe(true);
        expect(range(over, 'x')).toEqual(['1', '50000']);

        const exact = await (await edited.open(main, ...manyRanges(50_000))).tableStatistics(ID.plain, 12);
        expect(exact.columnsPartial).toBeUndefined();
        expect(range(exact, 'x')).toEqual(['-1', '50000']);
      },
    );
  });
});
