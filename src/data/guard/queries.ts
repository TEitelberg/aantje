import { quoteLiteral } from '../../catalog/ddl';
import { LEADING_BLANKS, NETWORK_HOST } from '../../catalog/locations';
import { visible } from '../../catalog/queries/shared';
import { LAKE } from '../attach';
import type { TableRef } from '../types';

// The statements of the guard; none of them runs the SQL that a catalog stores.

export type Rows = (sql: string) => Promise<unknown[][]>;

// The catalog database the DuckLake extension attaches next to the lake; it holds `ducklake_view` and `ducklake_macro`.
export const METADATA = `__ducklake_metadata_${LAKE}`;

// DuckDB folds the case of ASCII letters only when it looks a name up (`T` finds `t`, `É` does not find `é`).
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const foldAscii = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
// The same fold in SQL; `lower()` would also fold other letters and report names as equal that DuckDB tells apart.
const foldSql = (expression: string): string =>
  `translate(${expression}, '${UPPER}', '${UPPER.toLowerCase()}')`;

export const sameName = (a: string, b: string): boolean => foldAscii(a) === foldAscii(b);

// Every function of the DuckLake extension, `ducklake_<name>`. The lake catalog offers some of them as `lake.<name>()`
// (DuckDB 2.0.0 lists only the macros of the lake under its database name, not these), so each `<name>` may be a
// maintenance call when it is not read-only. The set is a superset of what the lake offers: refusing more is safe.
export function lakeFunctionsQuery(): string {
  return `SELECT DISTINCT function_name FROM duckdb_functions() WHERE starts_with(function_name, 'ducklake_')`;
}

// The versions of the engine and of the DuckLake extension: the functions the engine lists depend on nothing else.
export function engineVersionQuery(): string {
  return `SELECT v.library_version, e.extension_version FROM pragma_version() v LEFT JOIN duckdb_extensions() e ON e.extension_name = 'ducklake'`;
}

const inNames = (expression: string, names: ReadonlySet<string>): string =>
  `${foldSql(expression)} IN (${[...names].map(quoteLiteral).join(', ')})`;

// The tables and views that DuckDB resolves a request to: it folds the case of ASCII letters in schema and name, so
// these are all the relations of that name. More than one is a lake DuckDB itself cannot create; only a hand-written
// catalog has it.
export function relationsQuery(table: TableRef, snapshot: string): string {
  const found = (kind: string, relation: string, column: string): string =>
    `SELECT '${kind}' FROM ${METADATA}.${relation} r JOIN ${METADATA}.ducklake_schema s ON s.schema_id = r.schema_id WHERE ${foldSql('s.schema_name')} = ${quoteLiteral(foldAscii(table.schema))} AND ${foldSql(`r.${column}`)} = ${quoteLiteral(foldAscii(table.table))} AND ${visible('r', snapshot)} AND ${visible('s', snapshot)}`;
  return `${found('view', 'ducklake_view', 'view_name')} UNION ALL ${found('table', 'ducklake_table', 'table_name')}`;
}

// The views of the lake visible at the snapshot whose folded name is one of `names` (every schema; which one DuckDB
// resolves a reference to depends on the view that holds it, so all of them are followed, which can only refuse more).
export function viewsQuery(snapshot: string, names: ReadonlySet<string>): string {
  return `SELECT 'view', s.schema_name, v.view_name, json_serialize_sql(v.sql) FROM ${METADATA}.ducklake_view v JOIN ${METADATA}.ducklake_schema s ON s.schema_id = v.schema_id WHERE ${inNames('v.view_name', names)} AND ${visible('v', snapshot)} AND ${visible('s', snapshot)}`;
}

// A scalar macro stores an expression, a table macro a query.
export function macrosQuery(snapshot: string, names: ReadonlySet<string>): string {
  return `SELECT 'macro', s.schema_name, m.macro_name, json_serialize_sql(CASE WHEN i.type = 'scalar' THEN 'SELECT ' || i.sql ELSE i.sql END) FROM ${METADATA}.ducklake_macro m JOIN ${METADATA}.ducklake_macro_impl i ON i.macro_id = m.macro_id JOIN ${METADATA}.ducklake_schema s ON s.schema_id = m.schema_id WHERE ${inNames('m.macro_name', names)} AND ${visible('m', snapshot)} AND ${visible('s', snapshot)}`;
}

// The tables of the lake visible at the snapshot whose folded name is one of `names`, as schema and table.
export function tablesQuery(snapshot: string, names: ReadonlySet<string>): string {
  return `SELECT s.schema_name, t.table_name FROM ${METADATA}.ducklake_table t JOIN ${METADATA}.ducklake_schema s ON s.schema_id = t.schema_id WHERE ${inNames('t.table_name', names)} AND ${visible('t', snapshot)} AND ${visible('s', snapshot)}`;
}

// A scheme (`x://`) or a network path (`//host`, `\\host`) at the start; used in SQL to list only the files that could
// leave this machine. `translate` lower-cases the ASCII letters of a scheme without folding the rest.
const hasOrigin = String.raw`^${LEADING_BLANKS}(?:[a-z][a-z0-9+.-]*://|${NETWORK_HOST})`;

// The resolved paths of the table's data and delete files visible at the snapshot that could leave this machine.
export function snapshotFilesQuery(table: TableRef, snapshot: number | undefined): string {
  const list = `ducklake_list_files('${LAKE}', ${quoteLiteral(table.table)}, schema => ${quoteLiteral(table.schema)}${snapshot === undefined ? '' : `, snapshot_version => ${snapshot}`})`;
  return `SELECT DISTINCT f FROM (SELECT data_file AS f FROM ${list} UNION ALL SELECT delete_file FROM ${list}) WHERE f IS NOT NULL AND regexp_matches(${foldSql('replace(f, chr(92), chr(47))')}, ${quoteLiteral(hasOrigin)})`;
}

// Every data and delete file whose lifetime overlaps `[from, to]`, with the stored paths that locate it. `table_changes`
// reads the data and delete files of older snapshots, which the newest snapshot no longer lists, so Show Changes cannot
// rely on a single-snapshot listing. `at` is the snapshot the engine binds the table name at (`to` for Show Changes,
// where a table renamed or dropped later still resolves); its and its schema's newest stored paths locate the files, as
// the catalog reader does.
export function rangeFilesQuery(
  table: TableRef,
  at: string,
  range: { readonly from: number; readonly to: number },
): string {
  const latestTable = `t.begin_snapshot = (SELECT max(v.begin_snapshot) FROM ${METADATA}.ducklake_table v WHERE v.table_id = t.table_id)`;
  const latestSchema = `sc.begin_snapshot = (SELECT max(w.begin_snapshot) FROM ${METADATA}.ducklake_schema w WHERE w.schema_id = sc.schema_id)`;
  return `WITH ids AS (
      SELECT r.table_id FROM ${METADATA}.ducklake_table r JOIN ${METADATA}.ducklake_schema s ON s.schema_id = r.schema_id
      WHERE ${foldSql('s.schema_name')} = ${quoteLiteral(foldAscii(table.schema))} AND ${foldSql('r.table_name')} = ${quoteLiteral(foldAscii(table.table))} AND ${visible('r', at)} AND ${visible('s', at)}),
    tbl AS (
      SELECT t.table_id, t.path AS table_path, t.path_is_relative AS table_relative,
        sc.path AS schema_path, sc.path_is_relative AS schema_relative
      FROM ${METADATA}.ducklake_table t JOIN ${METADATA}.ducklake_schema sc ON sc.schema_id = t.schema_id
      WHERE t.table_id IN (SELECT table_id FROM ids) AND ${latestTable} AND ${latestSchema})
    SELECT x.path, x.path_is_relative, tbl.table_path, tbl.table_relative, tbl.schema_path, tbl.schema_relative
    FROM (
      SELECT path, path_is_relative, table_id, begin_snapshot, end_snapshot FROM ${METADATA}.ducklake_data_file
      UNION ALL SELECT path, path_is_relative, table_id, begin_snapshot, end_snapshot FROM ${METADATA}.ducklake_delete_file
    ) x JOIN tbl ON tbl.table_id = x.table_id
    WHERE x.begin_snapshot <= ${String(range.to)} AND (x.end_snapshot IS NULL OR x.end_snapshot > ${String(range.from)})`;
}
