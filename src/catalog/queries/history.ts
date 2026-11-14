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

/**
 * The name of the schema of the object version `o` when that version began: the newest schema version up to then, so
 * a dropped schema keeps its name. DuckLake never renames a schema (it writes no `altered_schema` change), so a schema
 * id has one name, and the rule only decides for a catalog that was edited by hand. It is the rule that a whole range
 * of snapshots can share in one statement.
 */
function schemaNameOf(kind: ObjectKind): string {
  return kind === 'schema'
    ? 'CAST(NULL AS VARCHAR) AS schema_name'
    : `(SELECT s.schema_name FROM ducklake_schema s
    WHERE s.schema_id = o.schema_id AND s.begin_snapshot <= o.begin_snapshot
    ORDER BY s.begin_snapshot DESC LIMIT 1) AS schema_name`;
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

/**
 * Every version up to `upTo` of these ids; the caller takes, per snapshot, the newest version that began at or before
 * it, so an object dropped by the snapshot keeps its name.
 */
export function objectVersions(kind: ObjectKind, ids: readonly number[], upTo: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind)}, o.begin_snapshot
FROM ${table} o
WHERE o.${id} IN (${placeholders(ids)}) AND o.begin_snapshot <= ?`,
    params: [...ids, upTo],
  };
}

/**
 * Objects whose version begins at a snapshot from `from` to `to`, with the count of earlier versions (a rename starts
 * a new one); `begin_snapshot` tells the snapshots apart.
 */
export function objectsCreatedBetween(kind: ObjectKind, from: number, to: number): Query {
  const { table, id, name } = OBJECTS[kind];
  return {
    sql: `SELECT o.${id} AS object_id, o.${name} AS object_name, ${schemaNameOf(kind)}, o.begin_snapshot,
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

/** The kinds of objects that `droppedObjects` lists. */
export const DROPPED_KINDS = ['table', 'view', 'macro'] as const;

/**
 * The tables, views and macros of a schema whose last version ended: no version of the id is open or begins at its end
 * (a rename ends one version and begins the next). `last_snapshot` is the newest snapshot left at which it existed,
 * NULL when expiry took them all; `dropped_time` is NULL when the dropping snapshot expired.
 */
export function droppedObjects(schemaId: number): Query {
  const versions = DROPPED_KINDS.map((kind) => {
    const { table, id, name } = OBJECTS[kind];
    return `SELECT '${kind}' AS kind, o.${id} AS object_id, o.${name} AS object_name, o.begin_snapshot, o.end_snapshot
  FROM ${table} o
  WHERE o.schema_id = ? AND o.end_snapshot IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ${table} n
      WHERE n.${id} = o.${id} AND (n.end_snapshot IS NULL OR n.begin_snapshot >= o.end_snapshot))`;
  });
  return {
    sql: `SELECT d.kind, d.object_id, d.object_name, d.end_snapshot, d.last_snapshot, x.snapshot_time AS dropped_time
FROM (
  SELECT v.kind, v.object_id, v.object_name, v.end_snapshot,
    (SELECT CAST(MAX(s.snapshot_id) AS BIGINT) FROM ducklake_snapshot s
      WHERE s.snapshot_id >= v.begin_snapshot AND s.snapshot_id < v.end_snapshot) AS last_snapshot
  FROM (
  ${versions.join('\n  UNION ALL\n  ')}
  ) v
) d
LEFT JOIN ducklake_snapshot x ON x.snapshot_id = d.end_snapshot
WHERE d.last_snapshot IS NOT NULL
ORDER BY d.end_snapshot DESC, d.object_id DESC`,
    params: DROPPED_KINDS.map(() => schemaId),
  };
}

/** Every version (first snapshot, end, name, schema) of a table, oldest first. */
export function tableVersions(tableId: number): Query {
  return {
    sql: `SELECT o.begin_snapshot, o.end_snapshot, o.table_name AS object_name, ${schemaNameOf('table')}
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
