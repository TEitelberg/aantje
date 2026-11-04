import { placeholders } from './shared';
import type { Query } from './shared';

export function changesOf(snapshot: number): Query {
  return {
    sql: 'SELECT changes_made FROM ducklake_snapshot_changes WHERE snapshot_id = ?',
    params: [snapshot],
  };
}

const OBJECTS = {
  schema: { table: 'ducklake_schema', id: 'schema_id', name: 'schema_name' },
  table: { table: 'ducklake_table', id: 'table_id', name: 'table_name' },
  view: { table: 'ducklake_view', id: 'view_id', name: 'view_name' },
  macro: { table: 'ducklake_macro', id: 'macro_id', name: 'macro_name' },
} as const;

export type ObjectKind = keyof typeof OBJECTS;

// Newest schema version up to the snapshot expression `at`, so a dropped schema keeps its name.
function schemaNameOf(kind: ObjectKind, at: string): string {
  return kind === 'schema'
    ? 'CAST(NULL AS VARCHAR) AS schema_name'
    : `(SELECT s.schema_name FROM ducklake_schema s
    WHERE s.schema_id = o.schema_id AND s.begin_snapshot <= ${at}
    ORDER BY s.begin_snapshot DESC LIMIT 1) AS schema_name`;
}

/** Objects by id at their newest version up to the snapshot, so an object dropped in it keeps its name. */
export function objectsById(kind: ObjectKind, ids: readonly number[], snapshot: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind, '?')}
FROM ${table} o
WHERE o.${id} IN (${placeholders(ids)}) AND o.begin_snapshot <= ?
  AND NOT EXISTS (
    SELECT 1 FROM ${table} n WHERE n.${id} = o.${id} AND n.begin_snapshot > o.begin_snapshot AND n.begin_snapshot <= ?)`,
    params: [...(kind === 'schema' ? [] : [snapshot]), ...ids, snapshot, snapshot],
  };
}

/** Objects whose version begins at the snapshot, with the count of earlier versions (a rename starts a new one). */
export function objectsCreatedAt(kind: ObjectKind, snapshot: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind, 'o.begin_snapshot')},
  CAST((SELECT COUNT(*) FROM ${table} e WHERE e.${id} = o.${id} AND e.begin_snapshot < o.begin_snapshot) AS BIGINT) AS earlier
FROM ${table} o
WHERE o.begin_snapshot = ?`,
    params: [snapshot],
  };
}

/** The snapshots of a range (both ends inclusive), newest first, with commit data and the text of their changes. */
export function snapshotActivity(from: number, to: number, limit: number, commitColumns = true): Query {
  return {
    sql: `SELECT s.snapshot_id, s.snapshot_time, c.changes_made${commitColumns ? ', c.author, c.commit_message' : ''}
FROM ducklake_snapshot s
LEFT JOIN ducklake_snapshot_changes c ON c.snapshot_id = s.snapshot_id
WHERE s.snapshot_id >= ? AND s.snapshot_id <= ?
ORDER BY s.snapshot_id DESC
LIMIT ?`,
    params: [from, to, limit],
  };
}

/** Every version up to `upTo` of these ids; the caller applies the rule of `objectsById` per snapshot. */
export function objectVersions(kind: ObjectKind, ids: readonly number[], upTo: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind, 'o.begin_snapshot')}, o.begin_snapshot
FROM ${table} o
WHERE o.${id} IN (${placeholders(ids)}) AND o.begin_snapshot <= ?`,
    params: [...ids, upTo],
  };
}

/** `objectsCreatedAt` for every snapshot from `from` to `to` at once; `begin_snapshot` tells the rows apart. */
export function objectsCreatedBetween(kind: ObjectKind, from: number, to: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind, 'o.begin_snapshot')}, o.begin_snapshot,
  CAST((SELECT COUNT(*) FROM ${table} e WHERE e.${id} = o.${id} AND e.begin_snapshot < o.begin_snapshot) AS BIGINT) AS earlier
FROM ${table} o
WHERE o.begin_snapshot >= ? AND o.begin_snapshot <= ?`,
    params: [from, to],
  };
}

/** First snapshot, last end and open version count of a table or view; a NULL first snapshot means an unknown id. */
export function lifetime(kind: 'table' | 'view', id: number): Query {
  const { table, id: idColumn } = OBJECTS[kind];
  return {
    sql: `SELECT CAST(MIN(begin_snapshot) AS BIGINT) AS first_snapshot, CAST(MAX(end_snapshot) AS BIGINT) AS last_end,
  CAST(COUNT(*) - COUNT(end_snapshot) AS BIGINT) AS open_versions
FROM ${table}
WHERE ${idColumn} = ?`,
    params: [id],
  };
}

/** Every version (first snapshot, end, name, schema) of a table, oldest first. */
export function tableVersions(tableId: number): Query {
  return {
    sql: `SELECT o.begin_snapshot, o.end_snapshot, o.table_name AS object_name, ${schemaNameOf('table', 'o.begin_snapshot')}
FROM ducklake_table o
WHERE o.table_id = ?
ORDER BY o.begin_snapshot`,
    params: [tableId],
  };
}

/** Every `ducklake_column` row of a table, any version, with its snapshot range. */
export function columnRows(tableId: number): Query {
  return {
    sql: `SELECT column_id, parent_column, column_name, column_type, nulls_allowed, default_value, default_value_type,
  column_order, begin_snapshot, end_snapshot
FROM ducklake_column
WHERE table_id = ?`,
    params: [tableId],
  };
}

/** Every column comment of a table, any version, with its snapshot range. */
export function columnCommentRows(tableId: number): Query {
  return {
    sql: `SELECT column_id, value AS comment_text, begin_snapshot, end_snapshot
FROM ducklake_column_tag
WHERE table_id = ? AND key = 'comment'`,
    params: [tableId],
  };
}

/** Time and commit data of the snapshots with these ids; a snapshot that expired has no row. */
export function snapshotCommits(ids: readonly number[], commitColumns = true): Query {
  return {
    sql: `SELECT s.snapshot_id, s.snapshot_time${commitColumns ? ', c.author, c.commit_message' : ''}
FROM ducklake_snapshot s
LEFT JOIN ducklake_snapshot_changes c ON c.snapshot_id = s.snapshot_id
WHERE s.snapshot_id IN (${placeholders(ids)})`,
    params: ids,
  };
}

/** Id and name of every top-level column of a table in any of its versions. */
export function columnHistory(tableId: number): Query {
  return {
    sql: `SELECT DISTINCT column_id, column_name FROM ducklake_column
WHERE table_id = ? AND parent_column IS NULL
ORDER BY column_id, column_name`,
    params: [tableId],
  };
}
