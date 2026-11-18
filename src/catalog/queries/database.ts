// The statements of the Catalog Dashboard: what the database of a catalog tells about itself. Each engine has its own
// statistics views, so these statements are written per engine; they read views and pragmas only.
import { quoteIdentifier } from '../ddl';
import type { Query } from './shared';

/** The names of catalog tables that a statement may name: lower case, as DuckLake creates them. */
export const CATALOG_TABLE = /^ducklake_[a-z0-9_]+$/;

/** The tables of a DuckLake catalog of specification 1.x; a catalog of 1.0 lacks some, which are left out. */
export const DUCKLAKE_TABLES = [
  'ducklake_metadata',
  'ducklake_snapshot',
  'ducklake_snapshot_changes',
  'ducklake_schema',
  'ducklake_table',
  'ducklake_view',
  'ducklake_tag',
  'ducklake_column_tag',
  'ducklake_data_file',
  'ducklake_delete_file',
  'ducklake_column',
  'ducklake_table_stats',
  'ducklake_table_column_stats',
  'ducklake_file_column_stats',
  'ducklake_file_partition_value',
  'ducklake_files_scheduled_for_deletion',
  'ducklake_inlined_data_tables',
  'ducklake_column_mapping',
  'ducklake_name_mapping',
  'ducklake_partition_info',
  'ducklake_partition_column',
  'ducklake_schema_versions',
  'ducklake_macro',
  'ducklake_macro_impl',
  'ducklake_macro_parameters',
  'ducklake_sort_info',
  'ducklake_sort_expression',
] as const;

const query = (sql: string, params: Query['params'] = []): Query => ({ sql, params });

/** PostgreSQL: the schema of the catalog, the size of the database, the server version and whether TLS is in use. */
export const postgresDatabase = (): Query =>
  query(`SELECT current_schema() AS schema_name,
  CAST(pg_database_size(current_database()) AS BIGINT) AS database_bytes,
  current_setting('server_version') AS version,
  (SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()) AS ssl`);

/** PostgreSQL: the `ducklake_*` tables of the schema of the catalog, with their sizes and vacuum state. */
export const postgresTables = (): Query =>
  query(`SELECT c.relname AS table_name,
  CAST(c.reltuples AS BIGINT) AS row_estimate,
  CAST(pg_total_relation_size(c.oid) AS BIGINT) AS total_bytes,
  CAST(pg_relation_size(c.oid) AS BIGINT) AS table_bytes,
  CAST(pg_indexes_size(c.oid) AS BIGINT) AS index_bytes,
  CAST(CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END AS BIGINT) AS toast_bytes,
  CAST(s.n_live_tup AS BIGINT) AS live_rows,
  CAST(s.n_dead_tup AS BIGINT) AS dead_rows,
  CAST(s.n_tup_ins AS BIGINT) AS inserted_rows,
  CAST(s.n_tup_del AS BIGINT) AS deleted_rows,
  s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND left(CAST(c.relname AS TEXT), 9) = 'ducklake_'
ORDER BY total_bytes DESC, c.relname`);

/** SQLite: pages, free pages and the library version. */
export const sqliteDatabase = (): Query =>
  query(`SELECT (SELECT page_size FROM pragma_page_size()) AS page_size,
  (SELECT page_count FROM pragma_page_count()) AS page_count,
  (SELECT freelist_count FROM pragma_freelist_count()) AS free_pages,
  sqlite_version() AS version`);

/** SQLite: the tables of the file. */
export const sqliteTables = (): Query =>
  query(`SELECT name AS table_name FROM sqlite_master WHERE type = 'table' ORDER BY name`);

/** SQLite with `dbstat`: the bytes of each table with its indexes. Fails where the library lacks the table. */
export const sqliteTableBytes = (): Query =>
  query(`SELECT m.tbl_name AS table_name, CAST(SUM(d.pgsize) AS BIGINT) AS total_bytes
FROM dbstat d
JOIN sqlite_master m ON m.name = d.name
GROUP BY m.tbl_name`);

/** DuckDB: the blocks of the file and the engine version. */
export const duckdbDatabase = (): Query =>
  query(`SELECT CAST(block_size AS BIGINT) AS block_size, CAST(total_blocks AS BIGINT) AS total_blocks,
  CAST(free_blocks AS BIGINT) AS free_blocks, version() AS version
FROM pragma_database_size()
WHERE database_name = current_database()`);

/** DuckDB: the tables of the file with the rows DuckDB keeps for each. */
export const duckdbTables = (): Query =>
  query(`SELECT table_name, CAST(estimated_size AS BIGINT) AS row_count
FROM duckdb_tables()
WHERE database_name = current_database()
ORDER BY table_name`);

/** The rows of one catalog table; the name is checked against `CATALOG_TABLE`, so a foreign name throws. */
export function tableRows(name: string): Query {
  if (!CATALOG_TABLE.test(name)) {
    throw new Error('Not the name of a table of a DuckLake catalog.');
  }
  return query(`SELECT CAST(COUNT(*) AS BIGINT) AS row_count FROM ${quoteIdentifier(name)}`);
}

/** The inlined data tables the catalog lists, with the table whose rows each holds. */
export const inlinedDataTables = (): Query =>
  query(`SELECT table_id, table_name FROM ducklake_inlined_data_tables ORDER BY table_id, schema_version`);
