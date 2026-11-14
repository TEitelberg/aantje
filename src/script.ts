import { qualifiedName, quoteIdentifier } from './catalog/ddl';
import type { CatalogReader, SnapshotId } from './catalog/model';
import { PREVIEW_LIMIT } from './data/types';
import type { TableRef } from './data/types';
import type { Subject } from './time-travel';
import type { CatalogTree } from './tree/model';

/** The comment above a time-travel query; it holds the snapshot number only, never catalog text. */
export function timeTravelNote(pinned: SnapshotId | undefined): string[] {
  return pinned === undefined ? [] : [`-- Time travel to snapshot ${pinned}`];
}

/** ` AT (VERSION => n)` after a relation that a statement reads at a snapshot; empty without one. */
export const atVersion = (snapshot: SnapshotId | undefined): string =>
  snapshot === undefined ? '' : ` AT (VERSION => ${snapshot})`;

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
  return [
    `SELECT${list}`,
    `FROM ${qualifiedName(schemaName, relationName)}${atVersion(pinned)}`,
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

/** The comment above a statement that acts on the newest state although the script is for an older snapshot. */
export function newestComment(
  pinned: SnapshotId | undefined,
  { several = false }: { several?: boolean } = {},
): string[] {
  const subject = several ? 'these statements act' : 'this statement acts';
  return pinned === undefined
    ? []
    : [`-- The tree shows snapshot @${pinned}; ${subject} on the newest state.`];
}

/** `newestComment` for the tree's pinned snapshot; DROP and ALTER always act on the newest catalog. */
export function newestNote(
  tree: Pick<CatalogTree, 'state'>,
  connectionId: string,
  options: { several?: boolean } = {},
): string[] {
  return newestComment(pinnedOf(tree, connectionId), options);
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
