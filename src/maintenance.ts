import { quoteLiteral } from './catalog/ddl';
import { DEFAULT_EXPIRE_OLDER_THAN } from './catalog/expirable';
import { DEFAULT_DELETE_OLDER_THAN } from './catalog/scheduled';
import { LAKE } from './data/attach';
import { commented, newestNote } from './script';
import { lakeOptionsOf, optionHeader } from './maintenance-header';
import type { LakeOptions } from './maintenance-header';
import { lakeOptionLines, schemaOptionLines, tableOptionLines } from './maintenance-options';
import type { CatalogTree } from './tree/model';
import type { NodeRef } from './tree/refs';

const TABLE_KINDS = ['merge', 'rewrite', 'flush', 'option'] as const;

export type TableMaintenance = (typeof TABLE_KINDS)[number];

/** The entries of the Maintenance submenu of a connection; the whole lake is their subject. */
export type MaintenanceKind = TableMaintenance | 'checkpoint' | 'expire' | 'cleanup' | 'orphans';

const isTableKind = (kind: MaintenanceKind): kind is TableMaintenance =>
  (TABLE_KINDS as readonly string[]).includes(kind);

/** The comment that opens every maintenance script. */
export const HEADER = `-- Maintenance of the DuckLake. The SQL editor of aantje attaches the lake as "${LAKE}", so the statements below use that name.
-- Run them in a read/write SQL session.`;

const COMMENTED_OUT =
  '-- Every statement here is commented out, so running the script changes nothing. Remove the "-- " in front of the ones you want and edit the values.';

// The age of an explicit-age example that the script offers next to the option of the lake; edit it.
const EXAMPLE_AGE = '7 DAY';

const ago = (age: string): string => `older_than => now() - INTERVAL ${age}`;

// The dry run is active and only reports; the real call and a call with an age of its own are commented out under it.
// `age` is the explicit age of the active calls, or undefined when they follow the option of the lake.
function destructiveCalls(fn: string, age: string | undefined): string[] {
  const named = age === undefined ? '' : `, ${ago(age)}`;
  return [
    `CALL ${fn}('${LAKE}'${named}, dry_run => true);`,
    commented(`CALL ${fn}('${LAKE}'${named});`),
    ...(age === undefined ? [commented(`CALL ${fn}('${LAKE}', ${ago(EXAMPLE_AGE)});`)] : []),
  ];
}

/** The age Expire Snapshots uses when the lake sets no `expire_older_than`: the call without an age expires nothing. */
const EXPIRE_DEFAULT_AGE = DEFAULT_EXPIRE_OLDER_THAN.replace(/s$/, '').toUpperCase();

/** What DuckLake uses for `delete_older_than` when the lake sets none, but not when it sets an empty one (the call then fails). */
const ORPHANS_DEFAULT_AGE = DEFAULT_DELETE_OLDER_THAN.replace(/s$/, '').toUpperCase();

const hasValue = (value: string | null | undefined): boolean =>
  value !== null && value !== undefined && value.trim() !== '';

function expireScript(options: LakeOptions | null | undefined): string[] {
  const follows = hasValue(options?.expire_older_than);
  return [
    '-- Expires old snapshots. WARNING: an expired snapshot can no longer be read, so there is no time travel to it, and the files that only it needed can be deleted by Clean Up Old Files.',
    DRY_RUN_NOTE,
    follows
      ? '-- The dry run follows the option expire_older_than of the lake: without older_than it expires the snapshots at least that old (the newest snapshot never). To expire by another age, uncomment the last call and edit it. Instead of older_than you can name snapshots with versions => [1, 2].'
      : `-- The lake sets no expire_older_than (or it could not be read when this script was made), and a call without older_than then expires nothing. So the calls here name an age of ${DEFAULT_EXPIRE_OLDER_THAN}, the default of aantje; edit it, or set the option expire_older_than and make the script again. Instead of older_than you can name snapshots with versions => [1, 2].`,
    ...destructiveCalls('ducklake_expire_snapshots', follows ? undefined : EXPIRE_DEFAULT_AGE),
  ];
}

function orphansScript(options: LakeOptions | null | undefined): string[] {
  const value = options?.delete_older_than;
  const empty = typeof value === 'string' && !hasValue(value);
  return [
    '-- Deletes files in the data path that the catalog does not know. WARNING: a writer that is running at the moment (for example Sail) may have uploaded files that it has not committed yet, and deleting them breaks its commit. Keep the age longer than its longest write.',
    READ_ONLY_NOTE,
    DRY_RUN_NOTE,
    empty
      ? `-- The option delete_older_than of the lake is empty, and a call without older_than then fails. So the calls here name an age of ${DEFAULT_DELETE_OLDER_THAN}, what DuckLake uses when the option is not set; edit it, or set the option and make the script again.`
      : '-- Without older_than the calls follow the option delete_older_than of the lake (2 days when the lake sets none), so they list only the files that are at least that old. To use another age, uncomment the last call and edit it.',
    ...destructiveCalls('ducklake_delete_orphaned_files', empty ? ORPHANS_DEFAULT_AGE : undefined),
  ];
}

// DuckLake deletes these files before it checks the READ_ONLY attachment (see docs/en/sql-session.md).
const READ_ONLY_NOTE = '-- This deletes files even in a read-only session.';

const DRY_RUN_NOTE =
  '-- The call that is not commented out is a dry run: it only lists what would be affected. To do it for real, run the commented call instead.';

/** The statements of a Maintenance entry for the whole lake, with their comments. */
export function lakeScript(kind: MaintenanceKind, options?: LakeOptions | null): string[] {
  switch (kind) {
    case 'checkpoint':
      return [
        '-- Runs the maintenance steps in one go: flushes inlined data, merges adjacent files, rewrites data files with many deletes, expires snapshots, cleans up old files and deletes orphaned files.',
        '-- WARNING: it follows the options of the lake. With expire_older_than set it expires old snapshots, and they can no longer be read. It also deletes files that nothing needs any more and orphaned files, and a writer that is running at the moment (for example Sail) may have uploaded files that it has not committed yet.',
        '-- To see first what would go, use the scripts Expire Snapshots, Clean Up Old Files and Delete Orphaned Files, which start with a dry run.',
        '-- It expires snapshots older than expire_older_than, deletes files after delete_older_than, rewrites files from rewrite_delete_threshold, writes files of about target_file_size and skips every table with auto_compact = false.',
        '-- The DuckDB setting ducklake_target_file_size, when it is set, overrides target_file_size for CHECKPOINT.',
        `CHECKPOINT ${LAKE};`,
      ];
    case 'merge':
      return [
        '-- Merges small adjacent data files into larger ones (what OPTIMIZE does in other systems; DuckLake has no OPTIMIZE statement).',
        '-- Optional named parameters: min_file_size, max_file_size, max_compacted_files, newer_than, older_than; table_name and schema limit it to one table.',
        `CALL ducklake_merge_adjacent_files('${LAKE}');`,
      ];
    case 'rewrite':
      return [
        '-- Rewrites data files in which many rows are deleted, so that the deleted rows are gone from the files.',
        '-- Optional named parameters: delete_threshold (the share of deleted rows that triggers a rewrite), max_compacted_files; table_name and schema limit it to one table.',
        `CALL ducklake_rewrite_data_files('${LAKE}');`,
      ];
    case 'flush':
      return [
        '-- Writes the rows that DuckLake keeps in the catalog (inlined data) to Parquet files.',
        '-- Optional named parameters: schema_name and table_name limit it to one table.',
        `CALL ducklake_flush_inlined_data('${LAKE}');`,
      ];
    case 'expire':
      return expireScript(options);
    case 'cleanup':
      return [
        '-- Deletes data files that no snapshot needs any more (after a merge, a rewrite or expired snapshots). WARNING: deleted files cannot be restored.',
        READ_ONLY_NOTE,
        '-- The call that is not commented out is a dry run: it lists the files that would be deleted now and deletes nothing. Without older_than it uses the option delete_older_than of the lake (2 days when the lake sets none), so it lists only the scheduled files that are at least that old. Files scheduled more recently are not listed and wait.',
        '-- To delete the listed files, remove the "-- " in front of the first commented call. The second commented call deletes every scheduled file at once, however recent (cleanup_all => true).',
        '-- Another age: add older_than => now() - INTERVAL 7 DAY to a call. The pages of aantje show how many files are ready now and how many wait.',
        `CALL ducklake_cleanup_old_files('${LAKE}', dry_run => true);`,
        commented(`CALL ducklake_cleanup_old_files('${LAKE}');`),
        commented(`CALL ducklake_cleanup_old_files('${LAKE}', cleanup_all => true);`),
      ];
    case 'orphans':
      return orphansScript(options);
    case 'option':
      return [
        COMMENTED_OUT,
        `-- The current options: SELECT * FROM ducklake_options('${LAKE}');`,
        ...lakeOptionLines(),
      ];
  }
}

// Table names are string literals (a bare table name is looked up in `main`); quotes in them are doubled.
export function tableScript(kind: TableMaintenance, schemaName: string, tableName: string): string[] {
  const schema = quoteLiteral(schemaName);
  const table = quoteLiteral(tableName);
  switch (kind) {
    case 'merge':
      return [
        '-- Merges small adjacent data files of the table into larger ones (what OPTIMIZE does in other systems; DuckLake has no OPTIMIZE statement).',
        '-- Optional named parameters: min_file_size, max_file_size, max_compacted_files, newer_than, older_than.',
        `CALL ducklake_merge_adjacent_files('${LAKE}', ${table}, schema => ${schema});`,
      ];
    case 'rewrite':
      return [
        '-- Rewrites the data files of the table in which many rows are deleted, so that the deleted rows are gone from the files.',
        '-- Optional named parameters: delete_threshold (the share of deleted rows that triggers a rewrite), max_compacted_files.',
        `CALL ducklake_rewrite_data_files('${LAKE}', ${table}, schema => ${schema});`,
      ];
    case 'flush':
      return [
        '-- Writes the rows of the table that DuckLake keeps in the catalog (inlined data) to Parquet files.',
        `CALL ducklake_flush_inlined_data('${LAKE}', schema_name => ${schema}, table_name => ${table});`,
      ];
    case 'option':
      return [
        COMMENTED_OUT,
        '-- An option of the table overrides the option of the lake for this table.',
        ...tableOptionLines(schemaName, tableName),
      ];
  }
}

/** The most tables that a script of a schema names; a larger schema says how many are left out. Exported for its test. */
export const SCHEMA_SCRIPT_TABLES = 1000;

/**
 * The statements of a Maintenance entry for all tables of a schema. DuckLake merges and rewrites one table per call
 * (the `schema` parameter exists only next to a table name), so these list one call per table; flushing takes the
 * schema alone. Names appear only in string literals.
 */
function schemaScript(kind: TableMaintenance, schemaName: string, tableNames: readonly string[]): string[] {
  const schema = quoteLiteral(schemaName);
  if (kind === 'flush') {
    return [
      '-- Writes the rows of every table of the schema that DuckLake keeps in the catalog (inlined data) to Parquet files.',
      `CALL ducklake_flush_inlined_data('${LAKE}', schema_name => ${schema});`,
    ];
  }
  if (kind === 'option') {
    return [
      COMMENTED_OUT,
      '-- An option of the schema overrides the option of the lake for its tables; an option of a table overrides both.',
      ...schemaOptionLines(schemaName),
    ];
  }
  const shown = tableNames.slice(0, SCHEMA_SCRIPT_TABLES);
  return [
    kind === 'merge'
      ? '-- Merges small adjacent data files into larger ones, table by table, for every table of the schema (DuckLake merges one table per call).'
      : '-- Rewrites the data files in which many rows are deleted, table by table, for every table of the schema (DuckLake rewrites one table per call).',
    kind === 'merge'
      ? '-- Optional named parameters: min_file_size, max_file_size, max_compacted_files, newer_than, older_than.'
      : '-- Optional named parameters: delete_threshold (the share of deleted rows that triggers a rewrite), max_compacted_files.',
    ...(shown.length === 0 ? ['-- The schema has no table.'] : []),
    ...shown.map((name) => tableScript(kind, schemaName, name).at(-1) ?? ''),
    ...(tableNames.length > shown.length
      ? [`-- ${tableNames.length - shown.length} more tables of the schema are not listed.`]
      : []),
  ];
}

// The scripts that follow options of the lake and show their values in the header.
const FOLLOWS_OPTIONS: readonly MaintenanceKind[] = ['checkpoint', 'expire', 'cleanup', 'orphans'];

/**
 * The script of a Maintenance entry for a connection, schema or table node; table and schema names appear only in string literals, never in a comment.
 * `options` are the values of the lake for the header of the scripts that follow them (`null`: not readable); without them the header has none.
 * `tables` are the names of the tables of a schema node, which a merge or rewrite script lists.
 */
export function maintenanceOf(
  tree: Pick<CatalogTree, 'state'>,
  kind: MaintenanceKind,
  ref: NodeRef,
  options?: LakeOptions | null,
  tables: readonly string[] = [],
): string | undefined {
  if (ref.kind === 'connection') {
    const header = options !== undefined && FOLLOWS_OPTIONS.includes(kind) ? optionHeader(options) : [];
    return [HEADER, ...header, ...lakeScript(kind, options)].join('\n');
  }
  if (ref.kind === 'schema' && isTableKind(kind)) {
    return [
      HEADER,
      ...newestNote(tree, ref.connectionId, { several: kind !== 'flush' }),
      ...schemaScript(kind, ref.schema.name, tables),
    ].join('\n');
  }
  if (ref.kind !== 'table' || !isTableKind(kind)) {
    return undefined;
  }
  return [
    HEADER,
    ...newestNote(tree, ref.connectionId, { several: kind === 'option' }),
    ...tableScript(kind, ref.schema.name, ref.table.name),
  ].join('\n');
}

// The names of the tables the schema has now (the newest snapshot), which a script of the schema acts on.
async function tablesOf(
  tree: Pick<CatalogTree, 'state' | 'reader'>,
  ref: Extract<NodeRef, { kind: 'schema' }>,
): Promise<string[]> {
  const reader = tree.reader(ref.connectionId);
  if (!reader) return [];
  const newest = tree.state(ref.connectionId).latestSnapshot ?? (await reader.info()).latestSnapshot;
  return (await reader.tables(ref.schema.id, newest)).map(({ name }) => name);
}

/** `maintenanceOf` with the option values of the lake read from the catalog, for the scripts that show them. */
export async function maintenanceScript(
  tree: Pick<CatalogTree, 'state' | 'reader'>,
  kind: MaintenanceKind,
  ref: NodeRef,
): Promise<string | undefined> {
  if (ref.kind === 'schema' && (kind === 'merge' || kind === 'rewrite')) {
    return maintenanceOf(tree, kind, ref, undefined, await tablesOf(tree, ref));
  }
  if (ref.kind !== 'connection' || !FOLLOWS_OPTIONS.includes(kind)) {
    return maintenanceOf(tree, kind, ref);
  }
  const options = await tree
    .reader(ref.connectionId)
    ?.metadata()
    .then(lakeOptionsOf, () => null);
  return maintenanceOf(tree, kind, ref, options ?? null);
}
