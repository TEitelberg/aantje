import type { Value } from '../drivers/driver';
import type { HealthScopeRef } from '../model';

/**
 * A statement for `Driver.query`, identical on SQLite, DuckDB, PostgreSQL and Quack. `?` stands only where a value goes,
 * never in a string literal or a comment: PostgreSQL rewrites each, and the Quack driver replaces each by its value as
 * a literal. SUM/COUNT/MAX are cast to BIGINT because PostgreSQL returns NUMERIC and DuckDB HUGEINT.
 */
export interface Query {
  readonly sql: string;
  readonly params: readonly Value[];
}

/** Exposes the requested snapshot as `snap.id`; its placeholder comes first in every statement that uses it. */
export const WITH_SNAPSHOT = 'WITH snap AS (SELECT CAST(? AS BIGINT) AS id)';

/**
 * Condition for a versioned row existing at the snapshot (`begin_snapshot` inclusive, `end_snapshot` exclusive, NULL
 * while valid). `snapshot` is an SQL expression; the default needs `snap` joined. The data guard uses it too.
 */
export function visible(alias: string, snapshot = 'snap.id'): string {
  return `${snapshot} >= ${alias}.begin_snapshot AND (${snapshot} < ${alias}.end_snapshot OR ${alias}.end_snapshot IS NULL)`;
}

/** Joins the comment (`ducklake_tag`, key `comment`) of a schema, table or view as `c.value`. */
export function commentJoin(objectId: string): string {
  return `LEFT JOIN ducklake_tag c ON c.object_id = ${objectId} AND c.key = 'comment' AND ${visible('c')}`;
}

/**
 * Keeps the rows of the tables in the scope: one table, or every table the schema ever had (a dropped one still has
 * its files until cleanup). Undefined for the whole lake. `column` holds a table id.
 */
export function inScope(column: string, scope: HealthScopeRef): Query | undefined {
  if (scope.tableId !== undefined) {
    return { sql: `${column} = ?`, params: [scope.tableId] };
  }
  if (scope.schemaId !== undefined) {
    return {
      sql: `${column} IN (SELECT st.table_id FROM ducklake_table st WHERE st.schema_id = ?)`,
      params: [scope.schemaId],
    };
  }
  return undefined;
}

export function placeholders(ids: readonly unknown[]): string {
  return ids.map(() => '?').join(', ');
}
