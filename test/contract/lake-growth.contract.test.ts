import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../src/catalog/drivers/driver';
import { openSqlite } from '../../src/catalog/drivers/sqlite';
import type { CatalogReader, GrowthPoint } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { editedCatalogs } from '../support/edited-catalog';
import { ID, LATEST_SNAPSHOT } from '../support/expected';
import {
  HISTORY_LATEST_SNAPSHOT,
  HISTORY_SNAPSHOT,
  LAKE_DELETE_FILE_SNAPSHOT,
  LAKE_GROWTH,
  LAKE_SMALL_FILES,
} from '../support/expected-history';
import { fixturePath, wasmPath } from '../support/fixtures';
import { historyFixture, historySources } from '../support/sources/history';

const row = (point: GrowthPoint) => [point.snapshot, point.files, point.sizeBytes, point.compaction];

/** The last point of `lakeGrowth(snapshot)` must agree with the totals of `storage(snapshot)`. */
async function expectLastPointEqualsStorage(
  reader: CatalogReader,
  snapshots: readonly number[],
): Promise<void> {
  for (const snapshot of snapshots) {
    const { dataFiles, deleteFiles } = await reader.storage(snapshot);
    const last = (await reader.lakeGrowth(snapshot)).growth.at(-1);
    expect(last ? [last.files, last.sizeBytes] : [0, 0], `snapshot ${snapshot}`).toEqual([
      dataFiles.count,
      dataFiles.sizeBytes + deleteFiles.sizeBytes,
    ]);
  }
}

for (const source of historySources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `growth and small files of the whole lake on the history fixture, ${source.name}${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      let raw: Driver;
      let deleteBytes: number;

      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
        raw = await source.open();
        const [{ total }] = (await raw.query(
          'SELECT CAST(SUM(file_size_bytes) AS BIGINT) AS total FROM ducklake_delete_file',
        )) as [{ total: number }];
        deleteBytes = Number(total);
      });
      afterAll(async () => {
        await reader.close();
        await raw.close();
      });

      it('adds up the files of all tables after every snapshot that added or removed one, the delete file from its snapshot, the compaction marked, and stops at the snapshot asked for', async () => {
        const { growth, growthMerged } = await reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT);
        expect(growth.map(row)).toEqual(
          LAKE_GROWTH.map(([snapshot, files, bytes, compaction]) => [
            snapshot,
            files,
            bytes + (snapshot >= LAKE_DELETE_FILE_SNAPSHOT ? deleteBytes : 0),
            compaction,
          ]),
        );
        expect(growthMerged).toBeUndefined();
        expect(growth.every((point) => /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(point.time ?? ''))).toBe(true);
        expect(growth.filter((point) => point.compaction).map((point) => point.snapshot)).toEqual([
          HISTORY_SNAPSHOT.mergeLog,
        ]);

        expect((await reader.lakeGrowth(HISTORY_SNAPSHOT.insertEventsBulk)).growth.map(row)).toEqual([
          [6, 3, 1917, false],
          [7, 4, 2530, false],
          [8, 5, 3858, false],
        ]);
        expect((await reader.lakeGrowth(HISTORY_SNAPSHOT.createMain)).growth).toEqual([]);
      });

      it('equals the growth of the tables put together, dropped tables included, and ends with the storage totals of the same snapshot', async () => {
        const tables = (await raw.query(
          'SELECT DISTINCT table_id FROM ducklake_data_file ORDER BY table_id',
        )) as { table_id: number }[];
        expect(tables.length).toBeGreaterThan(5);
        const growthOf = await Promise.all(
          tables.map(
            async ({ table_id }) =>
              (await reader.tableStatistics(Number(table_id), HISTORY_LATEST_SNAPSHOT)).growth,
          ),
        );
        // Every table keeps its state until it changes again; the lake is the sum of the states of all tables.
        const changed = [...new Set(growthOf.flat().map((point) => point.snapshot))].toSorted(
          (a, b) => a - b,
        );
        const sum = changed.map((snapshot) =>
          growthOf.reduce<[number, number]>(
            ([files, bytes], growth) => {
              const state = growth.filter((point) => point.snapshot <= snapshot).at(-1);
              return [files + (state?.files ?? 0), bytes + (state?.sizeBytes ?? 0)];
            },
            [0, 0],
          ),
        );
        const lake = (await reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT)).growth;
        expect(lake.map((point) => point.snapshot)).toEqual(changed);
        expect(lake.map((point) => [point.files, point.sizeBytes])).toEqual(sum);

        await expectLastPointEqualsStorage(reader, [
          HISTORY_LATEST_SNAPSHOT,
          HISTORY_SNAPSHOT.deleteCustomer,
          HISTORY_SNAPSHOT.insertEventsBulk,
          HISTORY_SNAPSHOT.createMain,
        ]);
      });

      it('merges a long history into the number of points that was asked for, keeping the last state and the compaction', async () => {
        const merged = await reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT, 5);

        // 17 points in runs of 4: the run of snapshots 44..55 holds the compaction.
        expect(merged.growthMerged).toBe(true);
        expect(merged.growth.map(row)).toEqual([
          [10, 8, 5736, false],
          [23, 13, 8453 + deleteBytes, false],
          [36, 17, 10942 + deleteBytes, false],
          [55, 18, 11692 + deleteBytes, true],
          [56, 19, 12023 + deleteBytes, false],
        ]);
      });

      it('stops with ABORTED when the signal is aborted, and is usable afterwards', async () => {
        await expect(
          reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT, 500, AbortSignal.abort()),
        ).rejects.toMatchObject({ code: 'ABORTED' });
        await expect(reader.smallFiles(HISTORY_LATEST_SNAPSHOT, AbortSignal.abort())).rejects.toMatchObject({
          code: 'ABORTED',
        });
        expect((await reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT)).growth).toHaveLength(LAKE_GROWTH.length);
      });

      it('lists the tables with small files at a snapshot, most small files first, exactly as their statistics count them, and none before the first file', async () => {
        expect(
          (await reader.smallFiles(HISTORY_LATEST_SNAPSHOT)).map((t) => [t.tableId, t.files, t.small]),
        ).toEqual(LAKE_SMALL_FILES);

        for (const snapshot of [
          HISTORY_SNAPSHOT.insertEventsBulk,
          HISTORY_SNAPSHOT.updateCustomer,
          HISTORY_LATEST_SNAPSHOT,
        ]) {
          const small = await reader.smallFiles(snapshot);
          for (const schema of await reader.schemas(snapshot)) {
            for (const table of await reader.tables(schema.id, snapshot)) {
              const stats = await reader.tableStatistics(table.id, snapshot);
              const found = small.find((candidate) => candidate.tableId === table.id);
              expect(
                found ? [found.files, found.small] : [stats.files, 0],
                `${table.name} at snapshot ${snapshot}`,
              ).toEqual([stats.files, stats.smallFiles]);
            }
          }
        }

        expect(await reader.smallFiles(HISTORY_SNAPSHOT.createMain)).toEqual([]);
      });
    },
  );
}

describe('growth and small files of the whole lake in edited catalogs', () => {
  const edited = editedCatalogs();
  afterAll(() => edited.dispose());
  const main = fixturePath('ducklake.sqlite');
  const MIB = 1_048_576;

  const dataFile = (id: number, table: number, begin: number, size: number) =>
    `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start)
     VALUES (${id}, ${table}, ${begin}, NULL, ${id}, 'f${id}.parquet', 1, 'parquet', 10, ${size}, ${id * 10})`;
  const deleteFile = (id: number, ofFile: number, begin: number, end: number | null, size: number) =>
    `INSERT INTO ducklake_delete_file (delete_file_id, table_id, begin_snapshot, end_snapshot, data_file_id, path, path_is_relative, format, delete_count, file_size_bytes, footer_size)
     VALUES (${id}, 5, ${begin}, ${end ?? 'NULL'}, ${ofFile}, 'd${id}.parquet', 1, 'parquet', 2, ${size}, 0)`;

  /** The fixture's own files: orders has one data file and, from snapshot 6 until 11, one delete file; tmp has one until 11. */
  const BASELINE = [
    [4, 1, 1160, false],
    [5, 2, 1363, false],
    [6, 2, 2156, false],
    [11, 1, 1953, false],
  ];

  it('has the files of the main fixture as its baseline and counts two files of the same size that one snapshot added in two tables as two', async () => {
    expect((await (await edited.open(main)).lakeGrowth(LATEST_SNAPSHOT)).growth.map(row)).toEqual(BASELINE);

    const reader = await edited.open(
      main,
      dataFile(100, ID.plain, 13, 5000),
      dataFile(101, ID.orders, 13, 5000),
    );
    expect((await reader.lakeGrowth(LATEST_SNAPSHOT)).growth.map(row)).toEqual([
      ...BASELINE,
      [13, 3, 11953, false],
    ]);
  });

  it('lets a file end with its snapshot and a delete file end with its data file or earlier, and agrees with the storage totals wherever a file or delete file begins or ends', async () => {
    const reader = await edited.open(
      main,
      dataFile(100, ID.plain, 12, 5000),
      'UPDATE ducklake_data_file SET end_snapshot = 15 WHERE data_file_id = 100',
      deleteFile(101, 100, 12, 14, 2000),
      deleteFile(102, 100, 14, null, 3000),
    );
    // The catalog has 13 snapshots; asking for a later one is how a longer history is simulated.
    expect((await reader.lakeGrowth(20)).growth.map(row)).toEqual([
      ...BASELINE,
      [12, 2, 8953, false],
      [14, 2, 9953, false],
      [15, 1, 1953, false],
    ]);
    expect((await reader.lakeGrowth(13)).growth.at(-1)).toMatchObject({
      snapshot: 12,
      files: 2,
      sizeBytes: 8953,
    });

    // File 100 lives from 12 to 15 and has a delete file that is replaced at 14; file 103 never ends and has the same.
    const twoFiles = await edited.open(
      main,
      dataFile(100, ID.plain, 12, 5000),
      'UPDATE ducklake_data_file SET end_snapshot = 15 WHERE data_file_id = 100',
      deleteFile(101, 100, 12, 14, 2000),
      deleteFile(102, 100, 14, 15, 3000),
      dataFile(103, ID.plain, 12, 4000),
      deleteFile(104, 103, 12, 14, 700),
      deleteFile(105, 103, 14, null, 900),
    );
    await expectLastPointEqualsStorage(twoFiles, [11, 12, 13, 14, 15, 16, 20]);
  });

  const changesAt13 = (changes: string) =>
    `UPDATE ducklake_snapshot_changes SET changes_made = '${changes.replaceAll("'", "''")}' WHERE snapshot_id = 13`;

  it('marks a compaction of any table for the lake at the snapshot that did it, although it added no file, and of a table for that table only', async () => {
    const lake = await edited.open(main, changesAt13('altered_table:4,merge_adjacent:5'));
    expect((await lake.lakeGrowth(LATEST_SNAPSHOT)).growth.map(row)).toEqual([
      ...BASELINE,
      [13, 1, 1953, true],
    ]);

    const orders = await edited.open(main, changesAt13('altered_table:4,merge_adjacent:2'));
    expect(
      (await orders.tableStatistics(ID.orders, LATEST_SNAPSHOT)).growth.filter((point) => point.compaction),
    ).toMatchObject([{ snapshot: 13 }]);
    expect((await orders.tableStatistics(ID.plain, LATEST_SNAPSHOT)).growth).toEqual([]);
    expect((await orders.lakeGrowth(LATEST_SNAPSHOT)).growth.at(-1)).toMatchObject({
      snapshot: 13,
      compaction: true,
    });
  });

  it('does not take a table name that holds the compaction token for a compaction, of the lake or of the table', async () => {
    for (const changes of [
      'created_table:"main"."merge_adjacent:5"',
      'created_table:"main"."a,merge_adjacent:5"',
      'created_table:"main"."merge_adjacent:2,b"',
    ]) {
      const reader = await edited.open(main, changesAt13(changes));
      expect((await reader.lakeGrowth(LATEST_SNAPSHOT)).growth.map(row), changes).toEqual(BASELINE);
      const { growth } = await reader.tableStatistics(ID.orders, LATEST_SNAPSHOT);
      expect(
        growth.map((point) => point.compaction),
        changes,
      ).not.toContain(true);
      expect(growth.at(-1)?.snapshot, changes).toBeLessThan(13);
    }

    // A name in the snapshot holds the id of the table: still another table's compaction.
    const other = await edited.open(
      main,
      changesAt13('merge_adjacent:5,created_table:"main"."a merge_adjacent:2,b"'),
    );
    const { growth } = await other.tableStatistics(ID.orders, LATEST_SNAPSHOT);
    expect(growth.map((point) => point.snapshot)).toEqual([4, 6]);
    expect(growth.some((point) => point.compaction)).toBe(false);
  });

  it('leaves the time of an expired snapshot empty and keeps the time of the others', async () => {
    const reader = await edited.open(main, 'DELETE FROM ducklake_snapshot WHERE snapshot_id = 5');
    const { growth } = await reader.lakeGrowth(LATEST_SNAPSHOT);
    expect(growth.map((point) => [point.snapshot, point.time === null])).toEqual([
      [4, false],
      [5, true],
      [6, false],
      [11, false],
    ]);
  });

  it('keeps all 500 points of a history of 500 snapshots and merges 501 into 251', async () => {
    const snapshots = (count: number) =>
      `INSERT INTO ducklake_data_file (data_file_id, table_id, begin_snapshot, end_snapshot, file_order, path, path_is_relative, file_format, record_count, file_size_bytes, row_id_start)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${count})
       SELECT 1000 + i, 5, 100 + i, NULL, i, 'f' || i || '.parquet', 1, 'parquet', 1, 1000, i FROM n`;
    const exact = await (await edited.open(main, snapshots(496))).lakeGrowth(5000);
    const over = await (await edited.open(main, snapshots(497))).lakeGrowth(5000);

    expect(exact.growthMerged).toBeUndefined();
    expect(exact.growth).toHaveLength(500);
    expect(over.growthMerged).toBe(true);
    expect(over.growth).toHaveLength(251);
    expect(over.growth.at(-1)).toMatchObject({ snapshot: 597, files: 498 });
  });

  it('counts the files of the snapshot that was asked for, small ones below 16 MiB only, and leaves out a table without small files', async () => {
    const reader = await edited.open(
      main,
      dataFile(100, ID.plain, 12, MIB),
      dataFile(101, ID.plain, 12, 16 * MIB),
      dataFile(102, ID.plain, 12, 128 * MIB),
      dataFile(103, ID.plain, 12, 2 * MIB),
      'UPDATE ducklake_data_file SET end_snapshot = 13 WHERE data_file_id = 103',
    );
    // Table 5 has four files at snapshot 12 (the file of exactly 16 MiB is not small), table 2 has one small file.
    expect(await reader.smallFiles(12)).toEqual([
      { tableId: ID.plain, files: 4, small: 2 },
      { tableId: ID.orders, files: 1, small: 1 },
    ]);
    // Snapshot 13: the file of 2 MiB has ended; tables with the same number of small files are in the order of their ids.
    expect(await reader.smallFiles(LATEST_SNAPSHOT)).toEqual([
      { tableId: ID.orders, files: 1, small: 1 },
      { tableId: ID.plain, files: 3, small: 1 },
    ]);
    expect(await reader.smallFiles(11)).toEqual([{ tableId: ID.orders, files: 1, small: 1 }]);

    const large = await edited.open(
      main,
      dataFile(100, ID.plain, 12, 16 * MIB),
      dataFile(101, ID.plain, 12, 128 * MIB),
    );
    expect(await large.smallFiles(LATEST_SNAPSHOT)).toEqual([{ tableId: ID.orders, files: 1, small: 1 }]);
  });
});

describe('growth of the whole lake in the history fixture, expired copy', () => {
  it('leaves the time of an expired snapshot empty and keeps the points', async () => {
    const reader = createCatalogReader(await openSqlite({ path: historyFixture.expired, wasmPath }));
    try {
      const { growth } = await reader.lakeGrowth(HISTORY_LATEST_SNAPSHOT);
      // Expiring the snapshots of the dropped table took its files out of the catalog, so its two points are gone.
      expect(growth.map((point) => point.snapshot)).toEqual(
        LAKE_GROWTH.map(([snapshot]) => snapshot).filter((snapshot) => snapshot !== 44 && snapshot !== 45),
      );
      expect(growth.filter((point) => point.time !== null).map((point) => point.snapshot)).toEqual([
        HISTORY_SNAPSHOT.mergeLog,
        HISTORY_LATEST_SNAPSHOT,
      ]);
    } finally {
      await reader.close();
    }
  });
});
