import { alterViewDdl, createViewDdl, macroDdl, qualifiedName, quoteIdentifier } from './catalog/ddl';
import type { CatalogReader, ColumnInfo, MacroInfo, SnapshotId, ViewInfo } from './catalog/model';
import { PREVIEW_LIMIT } from './data/types';
import type { TableRef } from './data/types';
import type { Subject } from './time-travel';
import type { CatalogTree } from './tree/model';

/** The comment above a time-travel query; it holds the snapshot number only, never catalog text. */
export function timeTravelNote(pinned: SnapshotId | undefined): string[] {
  return pinned === undefined ? [] : [`-- Time travel to snapshot ${pinned}`];
}

function selectBody(
  schemaName: string,
  relationName: string,
  columns: readonly string[] | undefined,
  pinned: SnapshotId | undefined,
): string {
  // A table without columns at the snapshot would give `SELECT FROM`, which is invalid SQL.
  const list = columns?.length
    ? `\n${columns.map((name) => `  ${quoteIdentifier(name)}`).join(',\n')}`
    : ' *';
  const atSnapshot = pinned === undefined ? '' : ` AT (VERSION => ${pinned})`;
  return [
    `SELECT${list}`,
    `FROM ${qualifiedName(schemaName, relationName)}${atSnapshot}`,
    `LIMIT ${PREVIEW_LIMIT};`,
  ].join('\n');
}

/** A `SELECT` over a table or view; `*` without columns, time travel with `pinned`. */
export function selectStatement(
  schemaName: string,
  relationName: string,
  columns: readonly string[] | undefined,
  pinned: SnapshotId | undefined,
): string {
  return [...timeTravelNote(pinned), selectBody(schemaName, relationName, columns, pinned)].join('\n');
}

/** One `SELECT` per relation under a single time-travel note. */
export function selectList(
  schemaName: string,
  relationNames: readonly string[],
  pinned: SnapshotId | undefined,
): string {
  return [
    ...timeTravelNote(pinned),
    relationNames.map((name) => selectBody(schemaName, name, undefined, pinned)).join('\n\n'),
  ].join('\n');
}

/** The snapshot the tree is pinned to; undefined while it follows `latest`. */
export function pinnedOf(tree: Pick<CatalogTree, 'state'>, connectionId: string): SnapshotId | undefined {
  const { snapshot } = tree.state(connectionId);
  return snapshot === 'latest' ? undefined : snapshot;
}

/** `fromReport` is set when the snapshot comes from a report, not from the tree. */
export interface ScriptSource {
  readonly fromReport?: true;
}

/** The comment above a statement that acts on the newest state although the script is for an older snapshot. */
export function newestComment(
  pinned: SnapshotId | undefined,
  { several = false, fromReport = false }: { several?: boolean; fromReport?: boolean | undefined } = {},
): string[] {
  const subject = several ? 'these statements act' : 'this statement acts';
  const whose = fromReport ? 'This script was made for' : 'The tree shows';
  return pinned === undefined ? [] : [`-- ${whose} snapshot @${pinned}; ${subject} on the newest state.`];
}

/** `newestComment` for the tree's pinned snapshot; DROP and ALTER always act on the newest catalog. */
export function newestNote(
  tree: Pick<CatalogTree, 'state'> & ScriptSource,
  connectionId: string,
  options: { several?: boolean } = {},
): string[] {
  return newestComment(pinnedOf(tree, connectionId), { ...options, fromReport: tree.fromReport });
}

/** Comments a statement out line by line; a quoted name may hold a line break that would otherwise run as SQL. */
export function commented(statement: string): string {
  return `-- ${statement.replace(/\r\n|\r|\n/g, (lineBreak) => `${lineBreak}-- `)}`;
}

const READ_ALL = '-- The query below comes from the catalog: read all of it before running.';
const COMMENTED_OUT_NOTE =
  '-- It contains ";", "--" or "/*", which can start another statement or hide a part of one, so it is commented out: remove the "-- " in front of it once you have read it.';

/**
 * A statement that copies catalog text. A fragment with `;`, `--` or `/*` could start or hide a statement,
 * so the statement becomes a comment under fixed notes. `warn` adds the first note to a live statement.
 */
export function fromCatalog(
  statement: string,
  fragments: readonly string[],
  warn = false,
): { notes: string[]; statement: string } {
  return fragments.some((text) => /;|--|\/\*/.test(text))
    ? { notes: [READ_ALL, COMMENTED_OUT_NOTE], statement: commented(statement) }
    : { notes: warn ? [READ_ALL] : [], statement };
}

/** Types and defaults of the columns and their children: the unquoted catalog text of a column statement. */
export function columnFragments(columns: readonly ColumnInfo[]): string[] {
  return columns.flatMap((column) => [
    column.type,
    ...(column.defaultValue === null ? [] : [column.defaultValue]),
    ...columnFragments(column.children),
  ]);
}

/** A macro statement under fixed notes: one for non-DuckDB overloads, which it rewrites, and the `fromCatalog` notes. */
export function macroScript(
  schemaName: string,
  macro: Pick<MacroInfo, 'name' | 'kind' | 'implementations'>,
): { notes: string[]; statement: string } {
  const { notes, statement } = fromCatalog(
    macroDdl(schemaName, macro),
    macro.implementations.flatMap(({ sql, parameters }) => [
      sql,
      ...parameters.flatMap(({ type, defaultValue }) => [type ?? '', defaultValue ?? '']),
    ]),
  );
  return {
    notes: [
      ...(macro.implementations.some(({ dialect }) => dialect !== 'duckdb')
        ? ['-- This macro is stored in another SQL dialect; running this replaces it with DuckDB overloads.']
        : []),
      ...notes,
    ],
    statement,
  };
}

/** A view statement under fixed notes: a view in another dialect would become a DuckDB view; the query is catalog text. */
export function viewScript(
  schemaName: string,
  view: Pick<ViewInfo, 'name' | 'sql' | 'dialect' | 'columnAliases'>,
  head: 'create' | 'alter',
): { notes: string[]; statement: string } {
  const foreign = view.dialect !== 'duckdb';
  const { notes, statement } = fromCatalog(
    (head === 'create' ? createViewDdl : alterViewDdl)(schemaName, view),
    [view.sql],
    foreign,
  );
  return {
    notes: [
      ...(foreign
        ? ['-- This view is stored in another SQL dialect; running this replaces it with a DuckDB view.']
        : []),
      ...notes,
    ],
    statement,
  };
}

/** The time-travel `SELECT` of **Query at Snapshot > Open as SQL**; `table` holds the names at that snapshot. */
export async function selectAtSnapshot(
  reader: Pick<CatalogReader, 'columns'>,
  subject: Subject,
  table: TableRef,
  snapshot: SnapshotId,
): Promise<string> {
  const columns = subject.kind === 'table' ? await reader.columns(subject.id, snapshot) : undefined;
  return selectStatement(
    table.schema,
    table.table,
    columns?.map(({ name }) => name),
    snapshot,
  );
}
