import type { HealthScopeRef } from '../model';
import { inlinedTable } from './maintenance';
import type { InlinedTable } from './maintenance';
import { inScope } from './shared';
import type { Query } from './shared';

// The earlier of two end snapshots; NULL means "not ended".
const earlierEnd = (own: string, other: string): string =>
  `CASE WHEN ${own} IS NULL THEN ${other}
    WHEN ${other} IS NULL OR ${own} < ${other} THEN ${own}
    ELSE ${other} END`;

// A delete file (`d`) ends at its own end or the end of its data file (`f`), whichever is earlier.
const DELETE_FILE_END = earlierEnd('d.end_snapshot', 'f.end_snapshot');

/** The ids of the tables the schema has or had. */
export function schemaTableIds(schemaId: number): Query {
  return {
    sql: 'SELECT DISTINCT table_id FROM ducklake_table WHERE schema_id = ?',
    params: [schemaId],
  };
}

/**
 * Files and bytes each snapshot up to `snapshot` added or removed, for the whole lake or the tables in `scope`. Rows
 * whose `changes_made` text matches `merge_adjacent` mark compactions; `changed` is 0 when only the text matched (a
 * table name can hold it, or the merge was of a table outside the scope), so `growthDeltasOf` confirms them.
 */
export function lakeGrowthDeltas(snapshot: number, scope: HealthScopeRef = {}): Query {
  const data = inScope('f.table_id', scope);
  const deletes = inScope('d.table_id', scope);
  const and = (only: Query | undefined): string => (only ? ` AND ${only.sql}` : '');
  const own = (only: Query | undefined): readonly Query['params'][number][] => only?.params ?? [];
  return {
    sql: `SELECT e.snapshot_id, s.snapshot_time, CAST(SUM(e.files) AS BIGINT) AS files, CAST(COALESCE(SUM(e.bytes), 0) AS BIGINT) AS bytes,
  CAST(SUM(e.changed) AS BIGINT) AS changed, c.changes_made
FROM (
  SELECT f.begin_snapshot AS snapshot_id, 1 AS files, f.file_size_bytes AS bytes, 1 AS changed
  FROM ducklake_data_file f WHERE f.begin_snapshot <= ?${and(data)}
  UNION ALL
  SELECT f.end_snapshot, -1, -f.file_size_bytes, 1
  FROM ducklake_data_file f WHERE f.end_snapshot <= ?${and(data)}
  UNION ALL
  SELECT d.begin_snapshot, 0, d.file_size_bytes, 1
  FROM ducklake_delete_file d WHERE d.begin_snapshot <= ?${and(deletes)}
  UNION ALL
  SELECT x.end_snapshot, 0, -x.file_size_bytes, 1
  FROM (
    SELECT d.file_size_bytes,
      ${DELETE_FILE_END} AS end_snapshot
    FROM ducklake_delete_file d JOIN ducklake_data_file f ON f.data_file_id = d.data_file_id${
      deletes
        ? `
    WHERE ${deletes.sql}`
        : ''
    }
  ) x WHERE x.end_snapshot <= ?
  UNION ALL
  SELECT c.snapshot_id, 0, 0, 0
  FROM ducklake_snapshot_changes c
  WHERE c.changes_made LIKE '%merge_adjacent:%' AND c.snapshot_id <= ?
) e
LEFT JOIN ducklake_snapshot s ON s.snapshot_id = e.snapshot_id
LEFT JOIN ducklake_snapshot_changes c ON c.snapshot_id = e.snapshot_id
GROUP BY e.snapshot_id, s.snapshot_time, c.changes_made
ORDER BY e.snapshot_id`,
    params: [
      snapshot,
      ...own(data),
      snapshot,
      ...own(data),
      snapshot,
      ...own(deletes),
      ...own(deletes),
      snapshot,
      snapshot,
    ],
  };
}

/** Snapshot of the rows that `growthChanges` and `inlinedGrowthChanges` sum up from before `first`. */
export const BEFORE_FIRST = -1;

// Wraps rows of `table_id`, `snapshot_id` and four deltas; snapshots before `first` sum up as `BEFORE_FIRST`.
function summedFrom(rows: string): string {
  return `SELECT e.table_id, e.bucket AS snapshot_id, CAST(SUM(e.rows_delta) AS BIGINT) AS rows_delta,
  CAST(SUM(e.bytes_delta) AS BIGINT) AS bytes_delta, CAST(SUM(e.files_delta) AS BIGINT) AS files_delta,
  CAST(SUM(e.partial_delta) AS BIGINT) AS partial_delta
FROM (
  SELECT u.table_id, CASE WHEN u.snapshot_id < CAST(? AS BIGINT) THEN ${BEFORE_FIRST} ELSE u.snapshot_id END AS bucket,
    u.rows_delta, u.bytes_delta, u.files_delta, u.partial_delta
  FROM (
${rows}
  ) u
) e
GROUP BY e.table_id, e.bucket
ORDER BY e.table_id, e.bucket`;
}

/** What each snapshot did to the live rows, bytes and data files of every table; sums up to what `tables` reads. */
export function growthChanges(first: number): Query {
  // Branches: data file begins, ends, stops being partial; delete file begins, ends, stops being partial.
  // A delete file whose data file is missing from the catalog is not counted, as in `tables`.
  return {
    sql: `WITH deletes AS (
  SELECT d.table_id, d.begin_snapshot, d.partial_max, d.delete_count, d.file_size_bytes,
    ${DELETE_FILE_END} AS end_snapshot
  FROM ducklake_delete_file d JOIN ducklake_data_file f ON f.data_file_id = d.data_file_id
)
${summedFrom(`    SELECT f.table_id, f.begin_snapshot AS snapshot_id, f.record_count AS rows_delta, f.file_size_bytes AS bytes_delta, 1 AS files_delta,
      CASE WHEN f.partial_max > f.begin_snapshot THEN 1 ELSE 0 END AS partial_delta
    FROM ducklake_data_file f
    UNION ALL
    SELECT f.table_id, f.end_snapshot, -f.record_count, -f.file_size_bytes, -1, 0
    FROM ducklake_data_file f WHERE f.end_snapshot IS NOT NULL
    UNION ALL
    SELECT f.table_id, CASE WHEN f.end_snapshot < f.partial_max THEN f.end_snapshot ELSE f.partial_max END, 0, 0, 0, -1
    FROM ducklake_data_file f WHERE f.partial_max > f.begin_snapshot
    UNION ALL
    SELECT d.table_id, d.begin_snapshot, -d.delete_count, d.file_size_bytes, 0,
      CASE WHEN d.partial_max > d.begin_snapshot THEN 1 ELSE 0 END
    FROM deletes d
    UNION ALL
    SELECT d.table_id, d.end_snapshot, d.delete_count, -d.file_size_bytes, 0, 0
    FROM deletes d WHERE d.end_snapshot IS NOT NULL
    UNION ALL
    SELECT d.table_id, CASE WHEN d.end_snapshot < d.partial_max THEN d.end_snapshot ELSE d.partial_max END, 0, 0, 0, -1
    FROM deletes d WHERE d.partial_max > d.begin_snapshot`)}`,
    params: [first],
  };
}

/**
 * `growthChanges` for inlined rows. DuckLake leaves the rows of a dropped table without an end snapshot, so they end
 * with the table. `inlinedTable` checks the names.
 */
export function inlinedGrowthChanges(inlined: readonly InlinedTable[], first: number): Query {
  // A table with a version lacking an end snapshot still exists; the versions of a renamed one end one after another.
  const ended = `SELECT table_id, MAX(end_snapshot) AS end_snapshot FROM ducklake_table GROUP BY table_id HAVING COUNT(*) = COUNT(end_snapshot)`;
  const end = earlierEnd('t._ducklake_end_snapshot', 'x.end_snapshot');
  const rows = inlined
    .map(({ tableId, name }) => {
      const id = Math.trunc(tableId);
      const table = inlinedTable(name);
      return `    SELECT ${id} AS table_id, t._ducklake_begin_snapshot AS snapshot_id, 1 AS rows_delta, 0 AS bytes_delta, 0 AS files_delta, 0 AS partial_delta FROM ${table} t
    UNION ALL
    SELECT ${id}, ${end}, -1, 0, 0, 0 FROM ${table} t LEFT JOIN ended x ON x.table_id = ${id} WHERE ${end} IS NOT NULL`;
    })
    .join('\n    UNION ALL\n');
  return { sql: `WITH ended AS (${ended})\n${summedFrom(rows)}`, params: [first] };
}
