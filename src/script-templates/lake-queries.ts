import { qualifiedName, quoteLiteral } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import { PREVIEW_LIMIT } from '../data/types';
import { commented } from '../ddl-script/check';
import { atVersion, newestComment, newestNote, pinnedOf } from '../script';
import type { ChangedTable } from '../tree/refs';
import { blocks, catalogOf } from './common';
import type { Folder, Ref, Tree } from './common';

const lake = quoteLiteral(LAKE);

const CATALOG_NOTE = `-- The SQL editor of aantje attaches the lake as "${LAKE}", so the statements below use that name.`;

export function selectStatistics(tree: Tree, ref: Folder<'statistics'>): string {
  const pinned = pinnedOf(tree, ref.connectionId);
  const schema = quoteLiteral(ref.schema.name);
  const table = quoteLiteral(ref.table.name);
  const at = atVersion(pinned);
  return blocks([
    [
      '-- Files and size of the table, as DuckLake counts them',
      ...newestComment(pinned),
      `SELECT * FROM ducklake_table_info(${lake}) WHERE table_id = ${ref.table.id};`,
    ],
    [
      '-- The data files of the table',
      `SELECT * FROM ducklake_list_files(${lake}, ${table}, schema => ${schema}${pinned === undefined ? '' : `, snapshot_version => ${pinned}`});`,
    ],
    [
      '-- The number of rows',
      `SELECT count(*) AS row_count FROM ${qualifiedName(ref.schema.name, ref.table.name)}${at};`,
    ],
  ]);
}

export function selectHistory(tree: Tree, ref: Folder<'history'>): string {
  const { snapshot } = catalogOf(tree, ref.connectionId, 'SELECT');
  const changes = (name: string): string =>
    `ducklake_table_${name}(${lake}, ${quoteLiteral(ref.schema.name)}, ${quoteLiteral(ref.table.name)}, 0, ${snapshot})`;
  return [
    `-- What the snapshots up to @${snapshot} changed in the table`,
    `SELECT * FROM ${changes('changes')} LIMIT ${PREVIEW_LIMIT};`,
    '-- Only the rows that were inserted, or only those that were deleted',
    commented(`SELECT * FROM ${changes('insertions')} LIMIT ${PREVIEW_LIMIT};`),
    commented(`SELECT * FROM ${changes('deletions')} LIMIT ${PREVIEW_LIMIT};`),
  ].join('\n');
}

export function selectChange(ref: Ref<'detail'> & { readonly change: ChangedTable }): string {
  const { snapshot, table } = ref.change;
  return [
    `-- What snapshot @${snapshot} changed in the table (its names at that snapshot)`,
    `SELECT * FROM ducklake_table_changes(${lake}, ${quoteLiteral(table.schema)}, ${quoteLiteral(table.table)}, ${snapshot}, ${snapshot}) LIMIT ${PREVIEW_LIMIT};`,
  ].join('\n');
}

export function selectCatalog(tree: Tree, ref: Ref<'connection'>): string {
  return blocks([
    [
      CATALOG_NOTE,
      ...newestNote(tree, ref.connectionId, { several: true }),
      '-- The schemas',
      `SELECT schema_name FROM duckdb_schemas() WHERE database_name = ${lake} ORDER BY schema_name;`,
    ],
    [
      '-- The tables',
      `SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${lake} ORDER BY schema_name, table_name;`,
    ],
    [
      '-- The views',
      `SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = ${lake} AND NOT internal ORDER BY schema_name, view_name;`,
    ],
    [
      '-- The macros',
      `SELECT DISTINCT schema_name, function_name, function_type FROM duckdb_functions() WHERE database_name = ${lake} AND function_type IN ('macro', 'table_macro') ORDER BY schema_name, function_name;`,
    ],
    [
      '-- The newest snapshots',
      `SELECT * FROM ducklake_snapshots(${lake}) ORDER BY snapshot_id DESC LIMIT 50;`,
    ],
  ]);
}

export function selectSnapshots(): string {
  return [
    '-- The newest snapshots of the lake, with what each one changed',
    `SELECT * FROM ducklake_snapshots(${lake}) ORDER BY snapshot_id DESC LIMIT 50;`,
  ].join('\n');
}

export function selectSnapshot(ref: Ref<'snapshot'>): string {
  return [
    '-- The snapshot, with what it changed',
    `SELECT * FROM ducklake_snapshots(${lake}) WHERE snapshot_id = ${ref.snapshot.id};`,
  ].join('\n');
}
