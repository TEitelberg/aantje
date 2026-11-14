import { quoteLiteral } from '../catalog/ddl';
import type { DeletedFiles, HealthScopeRef, TableDeletedFiles } from '../catalog/model';
import { LAKE } from '../data/attach';
import { collator } from '../order';
import { count, files } from '../shell/numbers';
import { formatBytes } from '../shell/numbers';
import type { CatalogTree } from '../tree/model';
import type { NodeRef } from '../tree/refs';

/**
 * The most tables whose rewrite a Merge script lists; its read asks for one more, to know that there are more.
 * Exported for its test.
 */
export const REWRITE_TABLES = 1000;

/**
 * What the Merge script of a node read about its small files with deleted rows: the tables that have them, or null
 * when the catalog could not be read.
 */
export type DeletedRead = readonly TableDeletedFiles[] | null;

/** The note of a Merge script whose read of the small files with deleted rows failed. */
export const DELETES_UNREAD =
  '-- Which small files have deleted rows could not be read when this script was made. The merge leaves such files alone; Rewrite Data Files with delete_threshold => 0 rewrites them.';

/**
 * What a Merge script says about its read: that it failed, or that it found more tables than it lists (the script of
 * a schema then misses the rewrite of some of its tables); nothing otherwise.
 */
export function readNote(deleted: DeletedRead): string[] {
  if (deleted === null) return [DELETES_UNREAD];
  return deleted.length > REWRITE_TABLES
    ? [
        `-- More than ${count(REWRITE_TABLES)} tables have small files with deleted rows, and the rewrite is listed for only some of them: run this script, then make it again for the others.`,
      ]
    : [];
}

/**
 * The rewrite that goes before the merge of a table whose small files have a delete file, because the merge leaves
 * such files alone; empty when none has one. `delete_threshold => 0` rewrites every file of the table with a deleted
 * row, small or not, so the comment says how many and how large. Names appear only in the string literals of the call.
 */
export function rewriteBeforeMerge(
  schemaName: string,
  tableName: string,
  deleted: DeletedFiles | undefined,
): string[] {
  if (deleted === undefined || deleted.small === 0) return [];
  const which =
    deleted.small === 1
      ? '1 of the small files of this table has'
      : `${count(deleted.small)} of the small files of this table have`;
  return [
    `-- ${which} deleted rows, and the merge leaves such files alone.`,
    `-- This rewrite drops the deleted rows and writes the files anew: it rewrites every file of the table with a deleted row (${files(deleted.files)}, ${formatBytes(deleted.bytes)}).`,
    `CALL ducklake_rewrite_data_files('${LAKE}', ${quoteLiteral(tableName)}, schema => ${quoteLiteral(schemaName)}, delete_threshold => 0);`,
  ];
}

/** The rewrites that the Merge script of the lake puts before its merge, by schema and table name. */
export function lakeRewrites(deleted: DeletedRead): string[] {
  const shown = (deleted ?? [])
    .slice(0, REWRITE_TABLES)
    .toSorted(
      (a, b) =>
        collator.compare(a.schema, b.schema) || collator.compare(a.table, b.table) || a.tableId - b.tableId,
    );
  return [
    ...shown.flatMap((table) => rewriteBeforeMerge(table.schema, table.table, table)),
    ...readNote(deleted),
  ];
}

// The tables a Merge script acts on: the lake, a schema or a table.
function scopeOf(ref: NodeRef): HealthScopeRef | undefined {
  switch (ref.kind) {
    case 'connection':
      return {};
    case 'schema':
      return { schemaId: ref.schema.id };
    case 'table':
      return { tableId: ref.table.id };
    default:
      return undefined;
  }
}

/**
 * Reads, in one statement at the newest state, the tables of the node whose small files have a delete file; empty
 * for a node that has no Merge script, null when the read fails or no reader is connected (the explorer is not
 * connected, for example while a read/write session holds a DuckDB file).
 */
export async function readDeletedSmallFiles(
  tree: Pick<CatalogTree, 'reader'>,
  ref: NodeRef,
): Promise<DeletedRead> {
  const scope = scopeOf(ref);
  if (!scope) return [];
  const reader = tree.reader(ref.connectionId);
  if (!reader) return null;
  try {
    return await reader.deletedSmallFiles(scope, REWRITE_TABLES + 1);
  } catch {
    return null;
  }
}
