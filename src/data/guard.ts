import { AantjeError } from '../errors';
import { newestSnapshotQuery } from './attach';
import { foreignOrigins, listOrigins, storedDataPath } from './guard/file-origins';
import { relationsQuery, sameName, tablesQuery } from './guard/queries';
import type { Rows } from './guard/queries';
import { closureOf, maintenanceFunctions } from './guard/view-closure';
import type { TableRef } from './types';

const viewRefused = (table: TableRef, text: string, cause: string): AantjeError =>
  new AantjeError(
    'QUERY_FAILED',
    `The view "${table.schema}.${table.table}" is not run: ${text}. aantje previews views that read data. Run such a statement yourself in the SQL editor if you mean it.`,
    { table, cause: new Error(cause) },
  );

// Refuses a view whose stored SQL could change the lake, before it runs: views run with the user's rights, and neither
// the read-only attach nor the configuration lock stops DuckLake maintenance functions. The SQL is parsed with
// `json_serialize_sql` (never executes), following the views and macros it names. Not a sandbox. The lake tables the
// closure reads must keep their files at home like a table read directly.
async function assertViewIsReadOnly(
  rows: Rows,
  table: TableRef,
  snapshot: number | undefined,
  at: string,
): Promise<void> {
  const { problem, relations } = await closureOf(
    rows,
    at,
    { schema: table.schema, name: table.table },
    await maintenanceFunctions(rows),
  );
  if (problem) {
    const { definition, reason } = problem;
    const which = definition.kind === 'view' ? 'view' : 'macro';
    const through =
      sameName(definition.name, table.table) && definition.kind === 'view'
        ? ''
        : ` (through the ${which} ${JSON.stringify(definition.name)})`;
    throw viewRefused(table, `${reason}${through}`, `view refused: ${reason}`);
  }
  if (relations.size === 0) {
    return;
  }
  const tables = (await rows(tablesQuery(at, relations))).map(([schema, name]): TableRef => ({
    schema: String(schema),
    table: String(name),
  }));
  if (tables.length === 0) {
    return;
  }
  const base = await storedDataPath(rows);
  for (const read of tables) {
    const foreign = await foreignOrigins(rows, read, snapshot, at, undefined, base);
    if (foreign.length > 0) {
      throw viewRefused(
        table,
        `it reads "${read.schema}.${read.table}", whose catalog lists data files on ${listOrigins(foreign)}, which is neither the data path of the catalog nor the S3 endpoint of the settings. aantje sends no request to a server that a catalog names`,
        'files on a foreign server refused',
      );
    }
  }
}

// Refuses a table whose data or delete files lie on a server that is neither the catalog's data path nor the configured
// S3 endpoint, before any request is sent.
async function assertFilesStayHome(
  rows: Rows,
  table: TableRef,
  snapshot: number | undefined,
  at: string,
  range: { readonly from: number; readonly to: number } | undefined,
): Promise<void> {
  const foreign = await foreignOrigins(rows, table, snapshot, at, range, await storedDataPath(rows));
  if (foreign.length > 0) {
    throw new AantjeError(
      'QUERY_FAILED',
      `"${table.schema}.${table.table}" is not read: the catalog lists data files on ${listOrigins(foreign)}, which is neither the data path of the catalog nor the S3 endpoint of the settings. aantje sends no request to a server that a catalog names.`,
      { table, cause: new Error('files on a foreign server refused') },
    );
  }
}

/** How the guard judges a relation, decided at the snapshot the read actually binds, not from the tree node. */
export interface GuardOptions {
  /**
   * Whether the user has confirmed trust in this connection's views. When the relation read is a view and this is not
   * set, the guard refuses with `VIEW_UNTRUSTED` instead of binding it, so the command layer can ask and retry.
   */
  readonly trusted?: boolean;
  /**
   * Set for Show Changes: the relation is judged at `to`, where `table_changes` binds its name, and the files to check
   * are those the range `[from, to]` can read, not one snapshot's.
   */
  readonly range?: { readonly from: number; readonly to: number };
}

/**
 * Checks the relation before the engine reads it: an untrusted view is refused so the user is asked (trust follows what
 * is read, not the tree node); a trusted view must still not call DuckLake maintenance functions, and the lake tables
 * it reads must keep their files at home; a table's files must not lie on a catalog-chosen server; and the name must
 * mean one relation. Run it as the first statements of the transaction that also reads, so that both see the same
 * snapshot (`withLake` in `engine.ts`).
 */
export async function guardRelation(
  connection: { runAndReadAll(sql: string): Promise<{ getRowsJson(): unknown[][] }> },
  table: TableRef,
  snapshot: number | undefined,
  options: GuardOptions = {},
): Promise<void> {
  const rows: Rows = async (sql) => (await connection.runAndReadAll(sql)).getRowsJson();
  // The first access to the lake in a transaction pins the snapshot the engine reads; the catalog is judged at that one.
  // Show Changes attaches the newest snapshot, but `table_changes` binds the table name at the end of the range, where
  // a table renamed or dropped later still resolves, so the relation is judged at `to` and the files come from the
  // whole range.
  const newest = Number((await rows(newestSnapshotQuery()))[0]?.[0] ?? 0);
  const at = String(options.range?.to ?? snapshot ?? newest);
  const found = (await rows(relationsQuery(table, at))).map(([kind]) => String(kind));
  if (found.length > 1) {
    throw new AantjeError(
      'QUERY_FAILED',
      `"${table.schema}.${table.table}" is not read: the lake has ${found.length} relations (${found.join(' and ')}) with the same name when upper and lower case are ignored, which DuckDB reads as one name and aantje cannot tell apart. Rename one of them.`,
      { table, cause: new Error('names that differ only in case refused') },
    );
  }
  if (found[0] === 'view') {
    if (!options.trusted) {
      throw new AantjeError(
        'VIEW_UNTRUSTED',
        `"${table.schema}.${table.table}" is a view at this snapshot, so aantje would run the SQL stored in the catalog with your rights on this machine (files and network). Trust this connection's views to resolve it.`,
        { table, cause: new Error('view read before the connection is trusted') },
      );
    }
    await assertViewIsReadOnly(rows, table, snapshot, at);
  } else if (found[0] === 'table') {
    await assertFilesStayHome(rows, table, snapshot, at, options.range);
  }
}
