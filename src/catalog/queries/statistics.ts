import { SMALL_FILE_BYTES } from '../thresholds';
import { WITH_SNAPSHOT, visible } from './shared';
import type { Query } from './shared';

/** Number of file size bins; bin `k` starts at `largest / 2^(SIZE_BINS - k)`, bin 0 at zero. */
export const SIZE_BINS = 8;

/** Totals of the table's data and delete files visible at the snapshot, counted like `tables`. */
export function fileSummary(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT CAST(COUNT(f.data_file_id) AS BIGINT) AS file_count,
  CAST(COALESCE(SUM(f.file_size_bytes), 0) AS BIGINT) AS data_bytes,
  CAST(COALESCE(SUM(f.record_count - COALESCE(d.delete_count, 0)), 0) AS BIGINT) AS row_count,
  CAST(COUNT(d.delete_file_id) AS BIGINT) AS delete_files,
  CAST(COALESCE(SUM(d.file_size_bytes), 0) AS BIGINT) AS delete_bytes,
  CAST(COALESCE(MAX(f.file_size_bytes), 0) AS BIGINT) AS largest,
  CAST(COALESCE(SUM(CASE WHEN f.file_size_bytes < ? THEN 1 ELSE 0 END), 0) AS BIGINT) AS small_files,
  CAST(COALESCE(SUM(CASE WHEN f.partial_max > snap.id OR d.partial_max > snap.id THEN 1 ELSE 0 END), 0) AS BIGINT) AS partial_files
FROM snap
CROSS JOIN ducklake_data_file f
LEFT JOIN ducklake_delete_file d ON d.data_file_id = f.data_file_id AND ${visible('d')}
WHERE f.table_id = ? AND ${visible('f')}`,
    params: [snapshot, SMALL_FILE_BYTES, tableId],
  };
}

/**
 * Visible data files grouped by size, one row per non-empty bin; integer comparisons only, so all engines pick the
 * same bin.
 */
export function fileSizeBins(tableId: number, snapshot: number): Query {
  const bin = Array.from(
    { length: SIZE_BINS - 1 },
    (_, index) => `WHEN f.file_size_bytes * ${2 ** (index + 1)} >= big.largest THEN ${SIZE_BINS - 1 - index}`,
  ).join(' ');
  return {
    sql: `${WITH_SNAPSHOT},
big AS (
  SELECT MAX(f.file_size_bytes) AS largest
  FROM snap CROSS JOIN ducklake_data_file f
  WHERE f.table_id = ? AND ${visible('f')}
)
SELECT b.bin, CAST(COUNT(*) AS BIGINT) AS file_count, CAST(COALESCE(SUM(b.size), 0) AS BIGINT) AS size_bytes
FROM (
  SELECT CASE ${bin} ELSE 0 END AS bin, f.file_size_bytes AS size
  FROM snap CROSS JOIN big CROSS JOIN ducklake_data_file f
  WHERE f.table_id = ? AND ${visible('f')}
) b
GROUP BY b.bin
ORDER BY b.bin`,
    params: [snapshot, tableId, tableId],
  };
}

/** Most partition keys `partitionBuckets` joins (one join per key); the caller reports a partitioning with more. */
export const MAX_PARTITION_KEYS = 32;

/** Visible data files of a partitioning grouped by partition values (a `keyN` column per key), largest first. */
export function partitionBuckets(
  tableId: number,
  snapshot: number,
  partitionId: number,
  keyCount: number,
  limit: number,
): Query {
  const keys = Array.from({ length: Math.min(keyCount, MAX_PARTITION_KEYS) }, (_, index) => index);
  return {
    sql: `${WITH_SNAPSHOT}
SELECT ${keys.map((key) => `v${key}.partition_value AS key${key}`).join(', ')},
  CAST(COUNT(*) AS BIGINT) AS file_count,
  CAST(COALESCE(SUM(f.file_size_bytes + COALESCE(d.file_size_bytes, 0)), 0) AS BIGINT) AS size_bytes,
  CAST(COALESCE(SUM(f.record_count - COALESCE(d.delete_count, 0)), 0) AS BIGINT) AS row_count
FROM snap
CROSS JOIN ducklake_data_file f
LEFT JOIN ducklake_delete_file d ON d.data_file_id = f.data_file_id AND ${visible('d')}
${keys
  .map(
    (key) => `LEFT JOIN ducklake_file_partition_value v${key}
  ON v${key}.data_file_id = f.data_file_id AND v${key}.table_id = f.table_id AND v${key}.partition_key_index = ${key}`,
  )
  .join('\n')}
WHERE f.table_id = ? AND f.partition_id = ? AND ${visible('f')}
GROUP BY ${keys.map((key) => `v${key}.partition_value`).join(', ')}
ORDER BY size_bytes DESC
LIMIT ${limit}`,
    params: [snapshot, tableId, partitionId],
  };
}

/** Visible data files written under another partitioning than `partitionId`, or none. */
export function otherPartitionFiles(tableId: number, snapshot: number, partitionId: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT CAST(COUNT(*) AS BIGINT) AS file_count
FROM snap
CROSS JOIN ducklake_data_file f
WHERE f.table_id = ? AND ${visible('f')} AND (f.partition_id IS NULL OR f.partition_id <> ?)`,
    params: [snapshot, tableId, partitionId],
  };
}

/**
 * Null and value counts per column over the visible data files, plus files without counts (INTERVAL), which the sums
 * omit.
 */
export function columnNulls(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT s.column_id, CAST(SUM(s.null_count) AS BIGINT) AS null_count, CAST(SUM(s.value_count) AS BIGINT) AS value_count,
  CAST(SUM(CASE WHEN s.null_count IS NULL OR s.value_count IS NULL THEN 1 ELSE 0 END) AS BIGINT) AS uncounted_files
FROM snap
CROSS JOIN ducklake_data_file f
JOIN ducklake_file_column_stats s ON s.data_file_id = f.data_file_id AND s.table_id = f.table_id
WHERE f.table_id = ? AND ${visible('f')}
GROUP BY s.column_id`,
    params: [snapshot, tableId],
  };
}

/** Current minimum and maximum of every column; DuckLake keeps no history of them. */
export function tableColumnRanges(tableId: number): Query {
  return {
    sql: 'SELECT column_id, min_value, max_value FROM ducklake_table_column_stats WHERE table_id = ?',
    params: [tableId],
  };
}

/** Minimum and maximum of every column per visible data file; the caller compares them by type. */
export function fileColumnRanges(tableId: number, snapshot: number, limit: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT s.column_id, s.min_value, s.max_value
FROM snap
CROSS JOIN ducklake_data_file f
JOIN ducklake_file_column_stats s ON s.data_file_id = f.data_file_id AND s.table_id = f.table_id
WHERE f.table_id = ? AND ${visible('f')} AND (s.min_value IS NOT NULL OR s.max_value IS NOT NULL)
ORDER BY f.data_file_id, s.column_id
LIMIT ${limit}`,
    params: [snapshot, tableId],
  };
}
