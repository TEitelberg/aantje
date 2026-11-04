import { createTableDdl, createViewDdl, qualifiedName } from './catalog/ddl';
import type { CatalogEntry, SnapshotId } from './catalog/model';
import { folderNodeId, treeNodeId } from './search';
import type { CatalogTree } from './tree/model';
import type { ConnectionState, NodeRef, TreeNode } from './tree/refs';
import { connectionClosed } from './messages';

// What the explorer commands compute; the VS Code side only asks the user and writes to the clipboard.

/** The snapshot a connection shows; undefined while not connected. */
export function shownSnapshot(state: ConnectionState): SnapshotId | undefined {
  return state.snapshot === 'latest' ? state.latestSnapshot : state.snapshot;
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
  const reader = tree.reader(ref.connectionId);
  const snapshot = shownSnapshot(tree.state(ref.connectionId));
  if (!reader || snapshot === undefined) {
    throw connectionClosed('copy the DDL');
  }
  return createTableDdl(ref.schema.name, ref.table.name, await reader.columns(ref.table.id, snapshot));
}

/** The tree node of a search result, taken from the tree's cache because VS Code matches elements by identity. */
export async function findEntryNode(
  tree: Pick<CatalogTree, 'roots' | 'children'>,
  connectionId: string,
  entry: CatalogEntry,
): Promise<TreeNode | undefined> {
  const connection = tree.roots().find((node) => node.ref.connectionId === connectionId);
  if (!connection) {
    return undefined;
  }
  const schema = (await tree.children(connection)).find(
    (node) => node.ref.kind === 'schema' && node.ref.schema.id === entry.schemaId,
  );
  if (!schema) {
    return undefined;
  }
  const folderId = folderNodeId(connectionId, entry);
  const folder = (await tree.children(schema)).find((node) => node.id === folderId);
  if (!folder) {
    return undefined;
  }
  const id = treeNodeId(connectionId, entry);
  return (await tree.children(folder)).find((node) => node.id === id);
}
