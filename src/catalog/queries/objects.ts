import type { HealthScopeRef } from '../model';
import { WITH_SNAPSHOT, commentJoin, inScope, visible } from './shared';
import type { Query } from './shared';

/** Specification version and latest snapshot in one query; fails when the ducklake tables are missing. */
export function info(): Query {
  return {
    sql: `SELECT
  (SELECT value FROM ducklake_metadata WHERE key = 'version') AS version,
  (SELECT CAST(MAX(snapshot_id) AS BIGINT) FROM ducklake_snapshot) AS latest_snapshot`,
    params: [],
  };
}

/** Snapshots newest first, the newest `limit` if given; `commitColumns` false for a catalog without commit columns. */
export function snapshots(limit?: number, commitColumns = true): Query {
  return {
    sql: `SELECT s.snapshot_id, s.snapshot_time, c.changes_made${
      commitColumns ? ', c.author, c.commit_message, c.commit_extra_info' : ''
    }
FROM ducklake_snapshot s
LEFT JOIN ducklake_snapshot_changes c ON c.snapshot_id = s.snapshot_id
ORDER BY s.snapshot_id DESC${limit === undefined ? '' : ' LIMIT ?'}`,
    params: limit === undefined ? [] : [limit],
  };
}

export function schemas(snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT s.schema_id, s.schema_name, c.value AS comment_text
FROM snap
CROSS JOIN ducklake_schema s
${commentJoin('s.schema_id')}
WHERE ${visible('s')}
ORDER BY s.schema_name`,
    params: [snapshot],
  };
}

/**
 * Tables of a schema with counts from the files visible at the snapshot (`ducklake_table_stats` ignores deletes and
 * history). `partial_files` counts files whose row count also covers later snapshots.
 */
export function tables(schemaId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT t.table_id, t.schema_id, t.table_name, c.value AS comment_text,
  CAST(COALESCE(SUM(f.record_count - COALESCE(d.delete_count, 0)), 0) AS BIGINT) AS row_count,
  CAST(COUNT(f.data_file_id) AS BIGINT) AS file_count,
  CAST(COALESCE(SUM(f.file_size_bytes + COALESCE(d.file_size_bytes, 0)), 0) AS BIGINT) AS size_bytes,
  CAST(COALESCE(SUM(CASE WHEN f.partial_max > snap.id OR d.partial_max > snap.id THEN 1 ELSE 0 END), 0) AS BIGINT) AS partial_files
FROM snap
CROSS JOIN ducklake_table t
${commentJoin('t.table_id')}
LEFT JOIN ducklake_data_file f ON f.table_id = t.table_id AND ${visible('f')}
LEFT JOIN ducklake_delete_file d ON d.data_file_id = f.data_file_id AND ${visible('d')}
WHERE t.schema_id = ? AND ${visible('t')}
GROUP BY t.table_id, t.schema_id, t.table_name, c.value
ORDER BY t.table_name`,
    params: [snapshot, schemaId],
  };
}

/** The views of a schema, or of every schema for `null`. */
export function views(schemaId: number | null, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT v.view_id, v.schema_id, v.view_name, v.dialect, v.sql, v.column_aliases, c.value AS comment_text
FROM snap
CROSS JOIN ducklake_view v
${commentJoin('v.view_id')}
WHERE ${schemaId === null ? '' : 'v.schema_id = ? AND '}${visible('v')}
ORDER BY v.view_name`,
    params: schemaId === null ? [snapshot] : [snapshot, schemaId],
  };
}

export function columns(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT c.column_id, c.parent_column, c.column_name, c.column_type, c.nulls_allowed,
  c.default_value, c.default_value_type, g.value AS comment_text
FROM snap
CROSS JOIN ducklake_column c
LEFT JOIN ducklake_column_tag g
  ON g.table_id = c.table_id AND g.column_id = c.column_id AND g.key = 'comment' AND ${visible('g')}
WHERE c.table_id = ? AND ${visible('c')}
ORDER BY c.column_order`,
    params: [snapshot, tableId],
  };
}

export function entries(snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT 'table' AS kind, t.table_id AS entry_id, t.table_name AS entry_name, s.schema_id, s.schema_name
FROM snap
CROSS JOIN ducklake_table t
JOIN ducklake_schema s ON s.schema_id = t.schema_id AND ${visible('s')}
WHERE ${visible('t')}
UNION ALL
SELECT 'view', v.view_id, v.view_name, s.schema_id, s.schema_name
FROM snap
CROSS JOIN ducklake_view v
JOIN ducklake_schema s ON s.schema_id = v.schema_id AND ${visible('s')}
WHERE ${visible('v')}
ORDER BY schema_name, entry_name`,
    params: [snapshot],
  };
}

export function metadata(): Query {
  return { sql: 'SELECT key, value, scope, scope_id FROM ducklake_metadata', params: [] };
}

export function snapshotSummary(): Query {
  return {
    sql: `SELECT CAST(COUNT(*) AS BIGINT) AS snapshot_count,
  (SELECT snapshot_time FROM ducklake_snapshot WHERE snapshot_id = (SELECT MIN(snapshot_id) FROM ducklake_snapshot)) AS first_time,
  (SELECT snapshot_time FROM ducklake_snapshot WHERE snapshot_id = (SELECT MAX(snapshot_id) FROM ducklake_snapshot)) AS latest_time
FROM ducklake_snapshot`,
    params: [],
  };
}

/** Data and delete files visible at the snapshot: of the whole lake, or of the tables in `scope`. */
export function fileTotals(snapshot: number, scope: HealthScopeRef = {}): Query {
  const data = inScope('f.table_id', scope);
  const deletes = inScope('d.table_id', scope);
  return {
    sql: `${WITH_SNAPSHOT}
SELECT 'data' AS kind, CAST(COUNT(*) AS BIGINT) AS file_count,
  CAST(COALESCE(SUM(f.file_size_bytes), 0) AS BIGINT) AS size_bytes
FROM snap
CROSS JOIN ducklake_data_file f
WHERE ${visible('f')}${data ? ` AND ${data.sql}` : ''}
UNION ALL
SELECT 'delete', CAST(COUNT(*) AS BIGINT), CAST(COALESCE(SUM(d.file_size_bytes), 0) AS BIGINT)
FROM snap
CROSS JOIN ducklake_delete_file d
WHERE ${visible('d')}${deletes ? ` AND ${deletes.sql}` : ''}`,
    params: [snapshot, ...(data?.params ?? []), ...(deletes?.params ?? [])],
  };
}

export function scheduledForDeletion(): Query {
  return {
    sql: `SELECT schedule_start, CAST(COUNT(*) AS BIGINT) AS file_count
FROM ducklake_files_scheduled_for_deletion
GROUP BY schedule_start`,
    params: [],
  };
}

/** The times of every snapshot but the newest, which no expiry takes. */
export function expirableSnapshotTimes(): Query {
  return {
    sql: `SELECT snapshot_time FROM ducklake_snapshot WHERE snapshot_id < (SELECT MAX(snapshot_id) FROM ducklake_snapshot)`,
    params: [],
  };
}

/** The partitioning visible at the snapshot, with its columns; one without columns is a reset. */
export function partitionings(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT p.partition_id, p.begin_snapshot, p.end_snapshot, c.column_id, c.transform
FROM snap
CROSS JOIN ducklake_partition_info p
LEFT JOIN ducklake_partition_column c ON c.partition_id = p.partition_id AND c.table_id = p.table_id
WHERE p.table_id = ? AND ${visible('p')}
ORDER BY p.begin_snapshot DESC, p.partition_id DESC, c.partition_key_index`,
    params: [snapshot, tableId],
  };
}

export function sortExpressions(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT i.sort_id, i.begin_snapshot, i.end_snapshot, e.expression, e.dialect, e.sort_direction, e.null_order
FROM snap
CROSS JOIN ducklake_sort_info i
LEFT JOIN ducklake_sort_expression e ON e.sort_id = i.sort_id AND e.table_id = i.table_id
WHERE i.table_id = ? AND ${visible('i')}
ORDER BY e.sort_key_index`,
    params: [snapshot, tableId],
  };
}

/** Tags of the table (no `column_id`) and its columns, except comments. */
export function tags(tableId: number, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT CAST(NULL AS BIGINT) AS column_id, g.key, g.value
FROM snap
CROSS JOIN ducklake_tag g
WHERE g.object_id = ? AND g.key <> 'comment' AND ${visible('g')}
UNION ALL
SELECT g.column_id, g.key, g.value
FROM snap
CROSS JOIN ducklake_column_tag g
WHERE g.table_id = ? AND g.key <> 'comment' AND ${visible('g')}`,
    params: [snapshot, tableId, tableId],
  };
}

/** One row per parameter of each macro implementation (one row if it has none). */
/** The macros of a schema, or of every schema for `null`, one row per parameter. */
export function macros(schemaId: number | null, snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT}
SELECT m.macro_id, m.schema_id, m.macro_name, i.impl_id, i.dialect, i.sql, i.type,
  p.parameter_name, p.parameter_type, p.default_value, p.default_value_type
FROM snap
CROSS JOIN ducklake_macro m
JOIN ducklake_macro_impl i ON i.macro_id = m.macro_id
LEFT JOIN ducklake_macro_parameters p ON p.macro_id = i.macro_id AND p.impl_id = i.impl_id
WHERE ${schemaId === null ? '' : 'm.schema_id = ? AND '}${visible('m')}
ORDER BY m.macro_name, m.macro_id, i.impl_id, p.column_id`,
    params: schemaId === null ? [snapshot] : [snapshot, schemaId],
  };
}
