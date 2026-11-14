import type { ConsistencyCheck, HealthScopeRef } from '../model';
import { SMALL_FILES, SMALL_FILE_BYTES } from '../thresholds';
import { WITH_SNAPSHOT, inScope, placeholders, visible } from './shared';
import type { Query } from './shared';

/** Tables with data files below `SMALL_FILE_BYTES` at the snapshot, with their file count and small file count. */
export function smallFilesAt(snapshot: number): Query {
  const small = 'CASE WHEN f.file_size_bytes < ? THEN 1 ELSE 0 END';
  return {
    sql: `${WITH_SNAPSHOT}
SELECT f.table_id, CAST(COUNT(*) AS BIGINT) AS file_count, CAST(SUM(${small}) AS BIGINT) AS small_count
FROM snap
CROSS JOIN ducklake_data_file f
WHERE ${visible('f')}
GROUP BY f.table_id
HAVING SUM(${small}) > 0`,
    params: [snapshot, SMALL_FILE_BYTES, SMALL_FILE_BYTES],
  };
}

// Rows that break each check as `table_id`, `kind`, `id`, `value` (see `ConsistencySample`); `lakeOnly` cannot be
// scoped to a table.
const CONSISTENCY_SQL: Record<ConsistencyCheck, { readonly rows: string; readonly lakeOnly?: true }> = {
  'files-without-table': {
    rows: `SELECT f.table_id AS table_id, 'data-file' AS kind, f.data_file_id AS id, CAST(NULL AS BIGINT) AS value
FROM ducklake_data_file f
WHERE NOT EXISTS (SELECT 1 FROM ducklake_table t WHERE t.table_id = f.table_id)
UNION ALL
SELECT d.table_id, 'delete-file', d.delete_file_id, CAST(NULL AS BIGINT)
FROM ducklake_delete_file d
WHERE NOT EXISTS (SELECT 1 FROM ducklake_table t WHERE t.table_id = d.table_id)`,
  },
  'files-unknown-partitioning': {
    rows: `SELECT f.table_id AS table_id, 'data-file' AS kind, f.data_file_id AS id, f.partition_id AS value
FROM ducklake_data_file f
WHERE f.partition_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ducklake_partition_info p WHERE p.table_id = f.table_id AND p.partition_id = f.partition_id)`,
  },
  'delete-files-without-data-file': {
    rows: `SELECT d.table_id AS table_id, 'delete-file' AS kind, d.delete_file_id AS id, d.data_file_id AS value
FROM ducklake_delete_file d
WHERE NOT EXISTS (SELECT 1 FROM ducklake_data_file f WHERE f.data_file_id = d.data_file_id)`,
  },
  'stats-without-column': {
    rows: `SELECT s.table_id AS table_id, 'data-file' AS kind, s.data_file_id AS id, s.column_id AS value
FROM ducklake_file_column_stats s
WHERE NOT EXISTS (SELECT 1 FROM ducklake_column c WHERE c.table_id = s.table_id AND c.column_id = s.column_id)`,
  },
  'partition-values-without-partitioning': {
    rows: `SELECT v.table_id AS table_id, 'data-file' AS kind, v.data_file_id AS id, v.partition_key_index AS value
FROM ducklake_file_partition_value v
LEFT JOIN ducklake_data_file f ON f.data_file_id = v.data_file_id
WHERE f.data_file_id IS NULL OR f.partition_id IS NULL`,
  },
  'partition-columns-without-partitioning': {
    rows: `SELECT c.table_id AS table_id, 'partitioning' AS kind, c.partition_id AS id, c.column_id AS value
FROM ducklake_partition_column c
WHERE NOT EXISTS (SELECT 1 FROM ducklake_partition_info p WHERE p.table_id = c.table_id AND p.partition_id = c.partition_id)`,
  },
  'sort-expressions-without-sort-order': {
    rows: `SELECT e.table_id AS table_id, 'sort-order' AS kind, e.sort_id AS id, e.sort_key_index AS value
FROM ducklake_sort_expression e
WHERE NOT EXISTS (SELECT 1 FROM ducklake_sort_info i WHERE i.table_id = e.table_id AND i.sort_id = e.sort_id)`,
  },
  'tables-without-schema': {
    rows: `SELECT DISTINCT t.table_id AS table_id, 'table' AS kind, t.table_id AS id, t.schema_id AS value
FROM ducklake_table t
WHERE NOT EXISTS (SELECT 1 FROM ducklake_schema s WHERE s.schema_id = t.schema_id)`,
  },
  'views-without-schema': {
    lakeOnly: true,
    rows: `SELECT DISTINCT CAST(NULL AS BIGINT) AS table_id, 'view' AS kind, v.view_id AS id, v.schema_id AS value
FROM ducklake_view v
WHERE NOT EXISTS (SELECT 1 FROM ducklake_schema s WHERE s.schema_id = v.schema_id)`,
  },
  'tables-without-columns': {
    rows: `SELECT t.table_id AS table_id, 'table' AS kind, t.table_id AS id, CAST(NULL AS BIGINT) AS value
FROM snap
CROSS JOIN ducklake_table t
WHERE ${visible('t')}
  AND NOT EXISTS (SELECT 1 FROM ducklake_column c WHERE c.table_id = t.table_id AND ${visible('c')})`,
  },
  'negative-counts': {
    rows: `SELECT f.table_id AS table_id, 'data-file' AS kind, f.data_file_id AS id, f.record_count AS value
FROM ducklake_data_file f
WHERE f.record_count < 0 OR f.file_size_bytes < 0
UNION ALL
SELECT d.table_id, 'delete-file', d.delete_file_id, d.delete_count
FROM ducklake_delete_file d
WHERE d.delete_count < 0 OR d.file_size_bytes < 0`,
  },
  'delete-count-over-records': {
    rows: `SELECT d.table_id AS table_id, 'delete-file' AS kind, d.delete_file_id AS id, d.delete_count AS value
FROM ducklake_delete_file d
JOIN ducklake_data_file f ON f.data_file_id = d.data_file_id
WHERE d.delete_count > f.record_count`,
  },
  'files-without-size': {
    rows: `SELECT f.table_id AS table_id, 'data-file' AS kind, f.data_file_id AS id, f.file_size_bytes AS value
FROM ducklake_data_file f
WHERE f.file_size_bytes IS NULL OR f.file_size_bytes <= 0
UNION ALL
SELECT d.table_id, 'delete-file', d.delete_file_id, d.file_size_bytes
FROM ducklake_delete_file d
WHERE d.file_size_bytes IS NULL OR d.file_size_bytes <= 0`,
  },
  'snapshot-range-invalid': {
    rows: `SELECT f.table_id AS table_id, 'data-file' AS kind, f.data_file_id AS id, f.begin_snapshot AS value
FROM snap
CROSS JOIN ducklake_data_file f
WHERE f.end_snapshot < f.begin_snapshot OR f.begin_snapshot > snap.id
UNION ALL
SELECT d.table_id, 'delete-file', d.delete_file_id, d.begin_snapshot
FROM snap
CROSS JOIN ducklake_delete_file d
WHERE d.end_snapshot < d.begin_snapshot OR d.begin_snapshot > snap.id`,
  },
  // Files of the newest state must not claim the same row ids. Skipped: merged files (no start), replaced files (an
  // end)
  // and files that flushed inlined rows of several snapshots (`partial_max`), which hold a row id once per version.
  'row-ids-overlap': {
    rows: `SELECT y.table_id AS table_id, 'data-file' AS kind, y.data_file_id AS id, y.previous_end AS value
FROM (
  SELECT f.table_id, f.data_file_id, f.row_id_start,
    CAST(MAX(f.row_id_start + f.record_count) OVER (
      PARTITION BY f.table_id ORDER BY f.row_id_start, f.data_file_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS BIGINT) AS previous_end
  FROM ducklake_data_file f
  WHERE f.end_snapshot IS NULL AND f.row_id_start IS NOT NULL AND f.partial_max IS NULL
) y
WHERE y.previous_end > y.row_id_start`,
  },
};

/** First `limit` rows by id that break a check, with the total in `total`; undefined when meaningless for a table. */
export function consistency(
  check: ConsistencyCheck,
  snapshot: number,
  scope: HealthScopeRef,
  limit: number,
): Query | undefined {
  const { rows, lakeOnly } = CONSISTENCY_SQL[check];
  const only = inScope('x.table_id', scope);
  if (only && lakeOnly) {
    return undefined;
  }
  return {
    sql: `${WITH_SNAPSHOT}
SELECT x.table_id, x.kind, x.id, x.value, CAST(COUNT(*) OVER () AS BIGINT) AS total
FROM (${rows}) x${only ? `\nWHERE ${only.sql}` : ''}
ORDER BY x.id, x.kind, x.value
LIMIT ${limit}`,
    params: [snapshot, ...(only?.params ?? [])],
  };
}

/**
 * Holes in the snapshot numbering (expired snapshots), oldest first, with the hole count and the missing ids in all.
 */
export function snapshotGaps(limit: number): Query {
  return {
    sql: `SELECT g.after_id, g.next_id, CAST(COUNT(*) OVER () AS BIGINT) AS total,
  CAST(SUM(g.next_id - g.after_id - 1) OVER () AS BIGINT) AS missing
FROM (
  SELECT s.snapshot_id AS after_id, LEAD(s.snapshot_id) OVER (ORDER BY s.snapshot_id) AS next_id
  FROM ducklake_snapshot s
) g
WHERE g.next_id > g.after_id + 1
ORDER BY g.after_id
LIMIT ${limit}`,
    params: [],
  };
}

// The data files that have a delete file at the newest state, once each, as `d.data_file_id`. A delete file counts
// only through a data file that is valid too: a catalog can keep a delete file open whose data file has ended.
const DELETED = `(SELECT DISTINCT od.data_file_id FROM ducklake_delete_file od WHERE od.end_snapshot IS NULL) d
  ON d.data_file_id = f.data_file_id`;

// `DeletedFiles` of the files `f` joined to `DELETED`; its one placeholder is `SMALL_FILE_BYTES`. A size below 1 byte
// adds nothing, so a broken size cannot make the sum negative.
const DELETED_COLUMNS = `CAST(SUM(CASE WHEN f.file_size_bytes < ? THEN 1 ELSE 0 END) AS BIGINT) AS deleted_small,
  CAST(COUNT(*) AS BIGINT) AS deleted_files,
  CAST(SUM(CASE WHEN f.file_size_bytes > 0 THEN f.file_size_bytes ELSE 0 END) AS BIGINT) AS deleted_bytes`;

/**
 * Tables of small files (`SMALL_FILES`) at the newest state; thresholds sit in the SQL because `limit` cuts the list.
 */
export function smallFileTables(scope: HealthScopeRef, limit: number): Query {
  const small = 'CASE WHEN f.file_size_bytes < ? THEN 1 ELSE 0 END';
  const only = inScope('f.table_id', scope);
  return {
    sql: `SELECT f.table_id, CAST(COUNT(*) AS BIGINT) AS file_count, CAST(SUM(${small}) AS BIGINT) AS small_count,
  CAST(SUM(CASE WHEN f.file_size_bytes < ? THEN f.file_size_bytes ELSE 0 END) AS BIGINT) AS small_bytes
FROM ducklake_data_file f
WHERE f.end_snapshot IS NULL${only ? ` AND ${only.sql}` : ''}
GROUP BY f.table_id
HAVING COUNT(*) >= ? AND SUM(${small}) * 10000 >= ? * COUNT(*)
ORDER BY small_count DESC, f.table_id
LIMIT ${limit}`,
    params: [
      SMALL_FILE_BYTES,
      SMALL_FILE_BYTES,
      ...(only?.params ?? []),
      SMALL_FILES.minFiles,
      SMALL_FILE_BYTES,
      Math.round(SMALL_FILES.ratio * 10_000),
    ],
  };
}

/**
 * The data files of these tables that have a delete file at the newest state, as `DeletedFiles`; a table without
 * such a file has no row. It serves the tables of `smallFileTables`.
 */
export function tableDeletedFiles(tableIds: readonly number[]): Query {
  return {
    sql: `SELECT f.table_id,
  ${DELETED_COLUMNS}
FROM ducklake_data_file f
JOIN ${DELETED}
WHERE f.end_snapshot IS NULL AND f.table_id IN (${placeholders(tableIds)})
GROUP BY f.table_id`,
    params: [SMALL_FILE_BYTES, ...tableIds],
  };
}

/**
 * Tables with small data files that have a delete file at the newest state, with their names then; whatever the
 * number of their files. A merge leaves such files alone.
 */
export function deletedSmallFiles(scope: HealthScopeRef, limit: number): Query {
  const only = inScope('f.table_id', scope);
  return {
    sql: `SELECT f.table_id, s.schema_name, t.table_name,
  ${DELETED_COLUMNS}
FROM ducklake_data_file f
JOIN ${DELETED}
JOIN ducklake_table t ON t.table_id = f.table_id AND t.end_snapshot IS NULL
JOIN ducklake_schema s ON s.schema_id = t.schema_id AND s.end_snapshot IS NULL
WHERE f.end_snapshot IS NULL${only ? ` AND ${only.sql}` : ''}
GROUP BY f.table_id, s.schema_name, t.table_name
HAVING SUM(CASE WHEN f.file_size_bytes < ? THEN 1 ELSE 0 END) > 0
ORDER BY f.table_id
LIMIT ${limit}`,
    params: [SMALL_FILE_BYTES, ...(only?.params ?? []), SMALL_FILE_BYTES],
  };
}

/**
 * Tables with data files that have at least `floorBasisPoints` / 10000 of their rows deleted, and how many reach
 * `thresholdBasisPoints`. Whole numbers keep integer arithmetic identical on every engine.
 */
export function deleteHeavyTables(
  scope: HealthScopeRef,
  floorBasisPoints: number,
  thresholdBasisPoints: number,
  limit: number,
): Query {
  const only = inScope('f.table_id', scope);
  return {
    sql: `SELECT f.table_id, CAST(COUNT(*) AS BIGINT) AS heavy_files,
  CAST(SUM(CASE WHEN d.delete_count * 10000 >= ? * f.record_count THEN 1 ELSE 0 END) AS BIGINT) AS threshold_files,
  CAST(SUM(f.record_count) AS BIGINT) AS records, CAST(SUM(d.delete_count) AS BIGINT) AS deleted,
  CAST(SUM(f.file_size_bytes) AS BIGINT) AS size_bytes
FROM ducklake_data_file f
JOIN ducklake_delete_file d ON d.data_file_id = f.data_file_id AND d.end_snapshot IS NULL
WHERE f.end_snapshot IS NULL AND f.record_count > 0 AND d.delete_count * 10000 >= ? * f.record_count${only ? ` AND ${only.sql}` : ''}
GROUP BY f.table_id
ORDER BY heavy_files DESC, f.table_id
LIMIT ${limit}`,
    params: [thresholdBasisPoints, floorBasisPoints, ...(only?.params ?? [])],
  };
}

/** The catalog tables that hold inlined rows, one per table and schema version. */
export function inlinedTables(scope: HealthScopeRef, limit: number): Query {
  const only = inScope('table_id', scope);
  return {
    sql: `SELECT table_id, table_name
FROM ducklake_inlined_data_tables${only ? `\nWHERE ${only.sql}` : ''}
ORDER BY table_id, schema_version
LIMIT ${limit}`,
    params: only?.params ?? [],
  };
}

/** Shape of inlined table names: `ducklake_inlined_data_<table id>_<schema version>`. */
export const INLINED_TABLE = /^ducklake_inlined_data_\d+_\d+$/;

/**
 * Quotes an inlined table name; it comes from the catalog and is the only non-fixed identifier, so a foreign name
 * throws.
 */
export function inlinedTable(name: string): string {
  if (!INLINED_TABLE.test(name)) {
    throw new Error('Not the name of an inlined table of DuckLake.');
  }
  return `"${name}"`;
}

/** An inlined table as the catalog lists it: the table whose rows it holds, and its name. */
export interface InlinedTable {
  readonly tableId: number;
  readonly name: string;
}

/**
 * The still valid rows of each of these inlined tables in one statement: one row per inlined table, with `table_id`
 * and `row_count`. `inlinedTable` checks the names; the list must not be empty.
 */
export function inlinedRows(tables: readonly InlinedTable[]): Query {
  return {
    sql: tables
      .map(
        ({ tableId, name }) =>
          `SELECT ${Math.trunc(tableId)} AS table_id, CAST(COUNT(*) AS BIGINT) AS row_count FROM ${inlinedTable(name)} WHERE _ducklake_end_snapshot IS NULL`,
      )
      .join('\nUNION ALL\n'),
    params: [],
  };
}

const STORED_FILES = `SELECT x.kind, x.file_id, x.table_id, x.begin_snapshot, x.end_snapshot, x.path, x.path_is_relative,
  x.file_size_bytes, x.records, x.encrypted, x.format,
  t.table_name, t.path AS table_path, t.path_is_relative AS table_relative,
  s.schema_name, s.path AS schema_path, s.path_is_relative AS schema_relative
FROM (
  SELECT 'data' AS kind, f.data_file_id AS file_id, f.table_id, f.begin_snapshot, f.end_snapshot, f.path, f.path_is_relative,
    f.file_size_bytes, f.record_count AS records, CASE WHEN f.encryption_key IS NULL THEN 0 ELSE 1 END AS encrypted,
    COALESCE(f.file_format, 'parquet') AS format
  FROM ducklake_data_file f
  UNION ALL
  SELECT 'delete', d.delete_file_id, d.table_id, d.begin_snapshot, d.end_snapshot, d.path, d.path_is_relative,
    d.file_size_bytes, d.delete_count, CASE WHEN d.encryption_key IS NULL THEN 0 ELSE 1 END, COALESCE(d.format, 'parquet')
  FROM ducklake_delete_file d
) x
LEFT JOIN ducklake_table t ON t.table_id = x.table_id
  AND t.begin_snapshot = (SELECT MAX(v.begin_snapshot) FROM ducklake_table v WHERE v.table_id = x.table_id)
LEFT JOIN ducklake_schema s ON s.schema_id = t.schema_id
  AND s.begin_snapshot = (SELECT MAX(w.begin_snapshot) FROM ducklake_schema w WHERE w.schema_id = t.schema_id)`;

/**
 * Every data and delete file with the stored paths that locate it, its format and the newest table and schema names
 * (NULL if missing).
 */
export function storedFiles(scope: HealthScopeRef, limit: number): Query {
  const only = inScope('x.table_id', scope);
  return {
    sql: `${STORED_FILES}${only ? `\nWHERE ${only.sql}` : ''}
ORDER BY x.kind, x.file_id
LIMIT ${limit}`,
    params: only?.params ?? [],
  };
}

/**
 * Files of other tables in a table's directory; a dropped and re-created table keeps its directory and old files until
 * cleanup.
 */
export function sharedFiles(tableId: number, limit: number): Query {
  return {
    sql: `${STORED_FILES}
JOIN (${tableLocation(tableId).sql}) me ON me.table_path = t.path AND me.table_relative = t.path_is_relative
  AND me.schema_path = s.path AND me.schema_relative = s.path_is_relative
WHERE x.table_id <> ?
ORDER BY x.kind, x.file_id
LIMIT ${limit}`,
    params: [tableId, tableId],
  };
}

/** The stored path of the newest version of a schema, which locates its directory. */
export function schemaLocation(schemaId: number): Query {
  return {
    sql: `SELECT s.path AS schema_path, s.path_is_relative AS schema_relative
FROM ducklake_schema s
WHERE s.schema_id = ? AND s.begin_snapshot = (SELECT MAX(v.begin_snapshot) FROM ducklake_schema v WHERE v.schema_id = s.schema_id)`,
    params: [schemaId],
  };
}

/** The newest table version with its schema's stored paths, which locate its directory. */
export function tableLocation(tableId: number): Query {
  return {
    sql: `SELECT t.path AS table_path, t.path_is_relative AS table_relative, s.path AS schema_path, s.path_is_relative AS schema_relative
FROM ducklake_table t
LEFT JOIN ducklake_schema s ON s.schema_id = t.schema_id
  AND s.begin_snapshot = (SELECT MAX(w.begin_snapshot) FROM ducklake_schema w WHERE w.schema_id = t.schema_id)
WHERE t.table_id = ? AND t.begin_snapshot = (SELECT MAX(v.begin_snapshot) FROM ducklake_table v WHERE v.table_id = t.table_id)`,
    params: [tableId],
  };
}

/** Files the cleanup of old files will delete; paths are relative to the data path unless marked absolute. */
export function scheduledFiles(limit: number): Query {
  return {
    sql: `SELECT path, path_is_relative FROM ducklake_files_scheduled_for_deletion ORDER BY data_file_id LIMIT ${limit}`,
    params: [],
  };
}
