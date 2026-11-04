import { describe, expect, it } from 'vitest';
import { inlinedGrowthChanges } from '../../src/catalog/queries/growth';
import { inlinedRows } from '../../src/catalog/queries/maintenance';
import { MAX_PARTITION_KEYS, partitionBuckets } from '../../src/catalog/queries/statistics';
import { lakeBackends } from './lake-backends';

describe('the statements for the inlined tables of a catalog', () => {
  it('quote the name of a valid inlined table and refuse any other name themselves, before anything is built', () => {
    expect(inlinedRows('ducklake_inlined_data_12_3').sql).toBe(
      'SELECT CAST(COUNT(*) AS BIGINT) AS row_count FROM "ducklake_inlined_data_12_3" WHERE _ducklake_end_snapshot IS NULL',
    );
    const sql = inlinedGrowthChanges([{ tableId: 12, name: 'ducklake_inlined_data_12_3' }], 4).sql;
    expect(sql.match(/FROM "ducklake_inlined_data_12_3" t/g)).toHaveLength(2);

    for (const name of [
      'x"; DROP TABLE ducklake_table; --',
      'ducklake_inlined_data_1_2" t; --',
      'ducklake_inlined_data_1',
      '',
    ]) {
      expect(() => inlinedRows(name), name).toThrow();
      expect(() => inlinedGrowthChanges([{ tableId: 1, name }], 0), name).toThrow();
      expect(
        () =>
          inlinedGrowthChanges(
            [
              { tableId: 1, name: 'ducklake_inlined_data_1_1' },
              { tableId: 2, name },
            ],
            0,
          ),
        name,
      ).toThrow();
    }
  });
});

describe('the statement for the partitions of a table', () => {
  const joins = (keys: number): number =>
    (partitionBuckets(1, 5, 2, keys, 10).sql.match(/LEFT JOIN ducklake_file_partition_value/g) ?? []).length;

  it('has one join per partition key, but no more than MAX_PARTITION_KEYS however many keys the catalog claims', () => {
    expect([joins(1), joins(3), joins(MAX_PARTITION_KEYS)]).toEqual([1, 3, MAX_PARTITION_KEYS]);
    expect(joins(MAX_PARTITION_KEYS + 1)).toBe(MAX_PARTITION_KEYS);
    expect(joins(100_000)).toBe(MAX_PARTITION_KEYS);
  });
});

const backends = await lakeBackends();

describe.each(backends)('partitions of a real lake with $name metadata', (backend) => {
  describe.skipIf(backend.skipReason !== undefined)('against the lake', () => {
    it('reads the first keys of a partitioning with more keys than the limit and says how many were left out', async () => {
      const lake = await backend.create();
      try {
        const columns = Array.from({ length: MAX_PARTITION_KEYS + 2 }, (_, index) => `c${index}`);
        const run = async (sql: string): Promise<void> => void (await lake.connection.run(sql));
        await run(`CREATE TABLE t (${columns.map((name) => `${name} INTEGER`).join(', ')})`);
        await run(`ALTER TABLE t SET PARTITIONED BY (${columns.join(', ')})`);
        await run(`INSERT INTO t SELECT ${columns.map(() => '1').join(', ')} FROM range(3)`);
        const scalar = async (sql: string): Promise<number> =>
          Number((await lake.connection.runAndReadAll(sql)).getRowsJson()[0]?.[0]);
        const tableId = await scalar('SELECT max(table_id) FROM __ducklake_metadata_lake.ducklake_table');
        const snapshot = await scalar('SELECT max(snapshot_id) FROM lake.snapshots()');

        const reader = await lake.reader();
        try {
          const partitioning = (await reader.tableStatistics(tableId, snapshot)).partitioning;

          expect(partitioning?.partitioning.columns).toHaveLength(MAX_PARTITION_KEYS + 2);
          expect(partitioning?.keysLeftOut).toBe(2);
          expect(partitioning?.partitions).toHaveLength(1);
          expect(partitioning?.partitions[0]?.values).toHaveLength(MAX_PARTITION_KEYS);
          expect(partitioning?.partitions[0]?.files).toBe(1);
        } finally {
          await reader.close();
        }
      } finally {
        await lake.remove();
      }
    });
  });
});
