import { isMaintenanceAction } from '../catalog/changes';
import type { CatalogReader, SchemaInfo, SnapshotId, ViewInfo } from '../catalog/model';
import type { RelationColumn } from '../data/types';
import { byName } from '../order';
import { changeDetail, columnTagDetail, partitionDetail, sortDetail, tableTagDetail } from './format';
import type { TreeDetail } from './format';
import {
  columnNode,
  detailNode,
  folderNode,
  macroNode,
  messageNode,
  SNAPSHOT_LIMIT,
  snapshotNode,
  tableNode,
  viewColumnNode,
  viewNode,
} from './nodes';
import type { NodeRef, TreeNode } from './refs';

// The levels below a connection, read from its catalog; pure but for the reads. The model caches them.

/** The columns of a view as DuckDB resolves them. */
export type ViewReader = (
  schema: SchemaInfo,
  view: ViewInfo,
  snapshot: SnapshotId,
) => Promise<readonly RelationColumn[]>;

/** What the levels of one connection are read with. */
export interface LevelSource {
  readonly reader: CatalogReader;
  /** The snapshot that the tree shows. */
  readonly snapshot: SnapshotId;
  /** Without it a view has no children. */
  readonly columnsOfView: ViewReader | undefined;
  /** The connection is an Azure DuckLake: its tables and views get context values of their own. */
  readonly azure: boolean;
}

/** The children of a node below the connection level. */
export async function readBelow(source: LevelSource, node: TreeNode): Promise<TreeNode[]> {
  const { reader, snapshot, columnsOfView } = source;
  const { ref } = node;
  switch (ref.kind) {
    case 'schema': {
      const { schema } = ref;
      const [tables, views, macros] = await Promise.all([
        reader.tables(schema.id, snapshot),
        reader.views(schema.id, snapshot),
        reader.macros(schema.id, snapshot),
      ]);
      // Folders show even when empty, so every schema looks the same.
      return [
        folderNode(node, { folder: 'tables', schema, tables: tables.toSorted(byName) }),
        folderNode(node, { folder: 'views', schema, views: views.toSorted(byName) }),
        folderNode(node, { folder: 'macros', schema, macros: macros.toSorted(byName) }),
      ];
    }
    case 'folder':
      return readFolder(source, node, ref);
    case 'table':
      return readTable(reader, snapshot, node, ref);
    case 'snapshot':
      return readSnapshot(reader, node, ref);
    case 'column':
      return ref.column.children.map((column) =>
        columnNode(node, ref.schema, ref.table, column, [...ref.path, column.name]),
      );
    case 'view':
      return columnsOfView
        ? [folderNode(node, { folder: 'viewColumns', schema: ref.schema, view: ref.view })]
        : [];
    case 'connection':
    case 'viewColumn':
    case 'macro':
    case 'detail':
    case 'query':
    case 'message':
      return [];
  }
}

async function readTable(
  reader: CatalogReader,
  snapshot: SnapshotId,
  node: TreeNode,
  { schema, table }: Extract<NodeRef, { kind: 'table' }>,
): Promise<TreeNode[]> {
  // Partitioning and tags name their columns from this one read.
  const read = reader.columns(table.id, snapshot);
  const [columns, partitioning, sortOrder, tags] = await Promise.all([
    read,
    read.then((columnTree) => reader.partitioning(table.id, snapshot, columnTree)),
    reader.sortOrder(table.id, snapshot),
    read.then((columnTree) => reader.tags(table.id, snapshot, columnTree)),
  ]);
  return [
    folderNode(node, { folder: 'statistics', schema, table }),
    folderNode(node, { folder: 'history', schema, table }),
    folderNode(node, { folder: 'columns', schema, table, columns }),
    ...(partitioning ? [folderNode(node, { folder: 'partitioning', schema, table, partitioning })] : []),
    ...(sortOrder ? [folderNode(node, { folder: 'sortOrder', schema, table, sortOrder })] : []),
    ...(tags.table.length + tags.columns.length > 0
      ? [folderNode(node, { folder: 'tags', schema, table, tags })]
      : []),
  ];
}

// A change of a table's rows or structure links to the table at the snapshot; maintenance only moves files.
async function readSnapshot(
  reader: CatalogReader,
  node: TreeNode,
  { snapshot }: Extract<NodeRef, { kind: 'snapshot' }>,
): Promise<TreeNode[]> {
  const changes = await reader.snapshotChanges(snapshot.id);
  if (changes.length === 0) return [messageNode(node, 'No recorded changes.', 'info')];
  return changes.map((change, index) => {
    const table =
      change.object === 'table' &&
      !isMaintenanceAction(change.action) &&
      change.schemaName !== null &&
      change.name !== null
        ? { snapshot: snapshot.id, table: { schema: change.schemaName, table: change.name } }
        : undefined;
    return detailNode(node, `c${index}`, changeDetail(change), table);
  });
}

async function readFolder(
  { reader, snapshot, columnsOfView, azure }: LevelSource,
  node: TreeNode,
  ref: Extract<NodeRef, { kind: 'folder' }>,
): Promise<TreeNode[]> {
  const details = (prefix: string, list: readonly TreeDetail[]): TreeNode[] =>
    list.map((detail, index) => detailNode(node, `${prefix}${index}`, detail));
  switch (ref.folder) {
    case 'tables':
      return ref.tables.length > 0
        ? ref.tables.map((table) => tableNode(node, ref.schema, table, azure))
        : [messageNode(node, 'No tables.', 'info')];
    case 'views':
      return ref.views.length > 0
        ? ref.views.map((view) => viewNode(node, ref.schema, view, columnsOfView !== undefined, azure))
        : [messageNode(node, 'No views.', 'info')];
    case 'macros':
      return ref.macros.length > 0
        ? ref.macros.map((macro) => macroNode(node, ref.schema, macro))
        : [messageNode(node, 'No macros.', 'info')];
    case 'columns':
      return ref.columns.map((column) => columnNode(node, ref.schema, ref.table, column, [column.name]));
    case 'viewColumns': {
      if (!columnsOfView) {
        return [];
      }
      const columns = await columnsOfView(ref.schema, ref.view, snapshot);
      return columns.map((column, index) => viewColumnNode(node, ref.schema, ref.view, column, index));
    }
    case 'partitioning':
      return details(
        'p',
        ref.partitioning.columns.map((column) => partitionDetail(ref.schema, ref.table, column)),
      );
    case 'sortOrder':
      return details(
        'e',
        ref.sortOrder.expressions.map((sort) => sortDetail(ref.schema, ref.table, sort)),
      );
    case 'statistics':
    case 'history':
    case 'queryHistory':
      return [];
    case 'tags':
      return details('k', [
        ...ref.tags.table.map((tag) => tableTagDetail(ref.schema, ref.table, tag)),
        ...ref.tags.columns.map((tag) => columnTagDetail(ref.schema, ref.table, tag)),
      ]);
    case 'snapshots':
      return (await reader.snapshots(SNAPSHOT_LIMIT)).map((entry) => snapshotNode(node, entry));
  }
}
