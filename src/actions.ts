import { createTableDdl, createViewDdl, qualifiedName } from './catalog/ddl';
import type { CatalogReader, SnapshotId } from './catalog/model';
import { treeNodePath } from './search';
import type { SearchHit } from './search';
import type { CatalogTree } from './tree/model';
import type { ConnectionState, NodeRef, TreeNode } from './tree/refs';
import { connectionClosed } from './messages';

// What the explorer commands compute; the VS Code side only asks the user and writes to the clipboard.

/** The snapshot a connection shows; undefined while not connected. */
export function shownSnapshot(state: ConnectionState): SnapshotId | undefined {
  return state.snapshot === 'latest' ? state.latestSnapshot : state.snapshot;
}

/**
 * The reader of a connection and the snapshot its tree shows. Throws `connectionClosed` when it is not connected:
 * `goal` completes "Connect again to ...", `name` names the connection.
 */
export function catalogAt(
  tree: Pick<CatalogTree, 'reader' | 'state'>,
  connectionId: string,
  goal: string,
  name?: string,
): { readonly reader: CatalogReader; readonly snapshot: SnapshotId } {
  const reader = tree.reader(connectionId);
  const snapshot = shownSnapshot(tree.state(connectionId));
  if (!reader || snapshot === undefined) {
    throw connectionClosed(goal, name);
  }
  return { reader, snapshot };
}

/** Quoted name of a schema, table, view or (nested) column; undefined for nodes without an SQL name. */
export function qualifiedNameOf(ref: NodeRef): string | undefined {
  switch (ref.kind) {
    case 'schema':
      return qualifiedName(ref.schema.name);
    case 'table':
      return qualifiedName(ref.schema.name, ref.table.name);
    case 'view':
      return qualifiedName(ref.schema.name, ref.view.name);
    case 'column':
      return qualifiedName(ref.schema.name, ref.table.name, ...ref.path);
    case 'viewColumn':
      return qualifiedName(ref.schema.name, ref.view.name, ref.column.name);
    default:
      return undefined;
  }
}

/** `CREATE` statement of a table (columns at the shown snapshot) or view; undefined for other nodes. */
export async function ddlOf(
  tree: Pick<CatalogTree, 'reader' | 'state'>,
  ref: NodeRef,
): Promise<string | undefined> {
  if (ref.kind === 'view') {
    return createViewDdl(ref.schema.name, ref.view);
  }
  if (ref.kind !== 'table') {
    return undefined;
  }
  const { reader, snapshot } = catalogAt(tree, ref.connectionId, 'copy the DDL');
  return createTableDdl(ref.schema.name, ref.table.name, await reader.columns(ref.table.id, snapshot));
}

/** The node of a connection; undefined when the tree has no such connection. */
export function rootOf(tree: Pick<CatalogTree, 'roots'>, connectionId: string): TreeNode | undefined {
  return tree.roots().find((root) => root.ref.connectionId === connectionId);
}

/** The node of a connection, or with `schemaId` the node of one of its schemas; undefined when the tree lacks it. */
export async function nodeOf(
  tree: Pick<CatalogTree, 'roots' | 'children'>,
  connectionId: string,
  schemaId?: number,
): Promise<TreeNode | undefined> {
  const root = rootOf(tree, connectionId);
  if (!root || schemaId === undefined) {
    return root;
  }
  return (await tree.children(root)).find(
    (child) => child.ref.kind === 'schema' && child.ref.schema.id === schemaId,
  );
}

/**
 * The tree node of a table, view or column (a row of the search), taken from the tree's cache because VS Code matches
 * elements by identity.
 */
export async function findEntryNode(
  tree: Pick<CatalogTree, 'roots' | 'children'>,
  connectionId: string,
  entry: SearchHit,
): Promise<TreeNode | undefined> {
  let node = rootOf(tree, connectionId);
  // A level is read before its children can be found; the tree caches what it reads.
  for (const id of treeNodePath(connectionId, entry)) {
    node = node && (await tree.children(node)).find((child) => child.id === id);
  }
  return node;
}
