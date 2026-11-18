// When each table last changed, from what the catalog keeps of it: its versions, its columns, the snapshots of its
// files. Snapshots that only maintained files (merge, rewrite, flush, expire) are left out by their change kinds.
import { INLINED_TABLE, inlinedTable } from './maintenance';
import { WITH_SNAPSHOT, visible } from './shared';
import type { Query } from './shared';

// The change kinds that change what a table holds or how it is defined. A snapshot whose `changes_made` names none of
// them only maintained files; a snapshot without a row of changes (expired) is not known to be maintenance.
const LOGICAL_TOKENS = [
  'inserted_into_table:',
  'deleted_from_table:',
  'inlined_insert:',
  'inlined_delete:',
  'altered_table:',
  'created_table:',
  'dropped_table:',
];

const MAINTENANCE_ONLY = `NOT (${LOGICAL_TOKENS.map((token) => `m.changes_made LIKE '%${token}%'`).join(' OR ')})`;

/** Keeps the evidence `e` that is no snapshot of maintenance only; `e.logical` marks definitions, which always count. */
const NOT_MAINTENANCE = `(e.logical = 1 OR NOT EXISTS (SELECT 1 FROM ducklake_snapshot_changes m WHERE m.snapshot_id = e.snapshot_id AND ${MAINTENANCE_ONLY}))`;

/**
 * The newest snapshot up to `snapshot` that changed each table visible at it: a version of the table (created,
 * renamed), a column (added, changed, dropped), a comment, or its files: a data file by the newest snapshot of its rows
 * (`partial_max` of a merged or flushed file), the end of a data file, a delete file and its end. File snapshots that
 * only maintained files do not count.
 */
export function lastChanges(snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT},
evidence AS (
  SELECT v.table_id, v.begin_snapshot AS snapshot_id, 1 AS logical FROM ducklake_table v
  UNION ALL SELECT c.table_id, c.begin_snapshot, 1 FROM ducklake_column c
  UNION ALL SELECT c.table_id, c.end_snapshot, 1 FROM ducklake_column c WHERE c.end_snapshot IS NOT NULL
  UNION ALL SELECT g.object_id, g.begin_snapshot, 1 FROM ducklake_tag g
  UNION ALL SELECT f.table_id, COALESCE(f.partial_max, f.begin_snapshot), 0 FROM ducklake_data_file f
  UNION ALL SELECT f.table_id, f.end_snapshot, 0 FROM ducklake_data_file f WHERE f.end_snapshot IS NOT NULL
  UNION ALL SELECT d.table_id, d.begin_snapshot, 0 FROM ducklake_delete_file d
  UNION ALL SELECT d.table_id, d.end_snapshot, 0 FROM ducklake_delete_file d WHERE d.end_snapshot IS NOT NULL
)
SELECT t.table_id, CAST(MAX(e.snapshot_id) AS BIGINT) AS last_change
FROM snap
CROSS JOIN ducklake_table t
JOIN evidence e ON e.table_id = t.table_id
WHERE ${visible('t')} AND e.snapshot_id <= snap.id AND ${NOT_MAINTENANCE}
GROUP BY t.table_id`,
    params: [snapshot],
  };
}

/**
 * The newest change of the partitioning, the sort order and the column comments of each table; a catalog without these
 * tables fails it.
 */
export function layoutChanges(snapshot: number): Query {
  return {
    sql: `${WITH_SNAPSHOT},
evidence AS (
  SELECT p.table_id, p.begin_snapshot AS snapshot_id FROM ducklake_partition_info p
  UNION ALL SELECT p.table_id, p.end_snapshot FROM ducklake_partition_info p WHERE p.end_snapshot IS NOT NULL
  UNION ALL SELECT s.table_id, s.begin_snapshot FROM ducklake_sort_info s
  UNION ALL SELECT s.table_id, s.end_snapshot FROM ducklake_sort_info s WHERE s.end_snapshot IS NOT NULL
  UNION ALL SELECT ct.table_id, ct.begin_snapshot FROM ducklake_column_tag ct
  UNION ALL SELECT ct.table_id, ct.end_snapshot FROM ducklake_column_tag ct WHERE ct.end_snapshot IS NOT NULL
)
SELECT e.table_id, CAST(MAX(e.snapshot_id) AS BIGINT) AS last_change
FROM snap
CROSS JOIN evidence e
WHERE e.snapshot_id <= snap.id
GROUP BY e.table_id`,
    params: [snapshot],
  };
}

/**
 * The newest snapshot of the rows still inlined in each of these tables: rows inserted, or deleted (their end), up
 * to `snapshot`. `inlinedTable` checks the names; the list must not be empty.
 */
export function inlinedChanges(
  tables: readonly { readonly tableId: number; readonly name: string }[],
  snapshot: number,
): Query {
  const at = Math.trunc(snapshot);
  return {
    sql: tables
      .filter(({ name }) => INLINED_TABLE.test(name))
      .map(
        ({ tableId, name }) =>
          `SELECT ${Math.trunc(tableId)} AS table_id, CAST(MAX(CASE WHEN _ducklake_end_snapshot IS NOT NULL AND _ducklake_end_snapshot <= ${at} THEN _ducklake_end_snapshot ELSE _ducklake_begin_snapshot END) AS BIGINT) AS last_change FROM ${inlinedTable(name)} WHERE _ducklake_begin_snapshot <= ${at}`,
      )
      .join('\nUNION ALL\n'),
    params: [],
  };
}

/** The first snapshot after `snapshot` that still exists, with its time: a change in an expired one was before it. */
export function nextSnapshot(snapshot: number): Query {
  return {
    sql: `SELECT snapshot_id, snapshot_time FROM ducklake_snapshot WHERE snapshot_id > ? ORDER BY snapshot_id LIMIT 1`,
    params: [snapshot],
  };
}
