import { isMainSchema } from '../catalog/model';
import type { ColumnInfo, MacroInfo, SchemaInfo, SnapshotInfo, TableInfo, ViewInfo } from '../catalog/model';
import { isAwsLake, isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { RelationColumn } from '../data/types';
import { fileTypeOf } from '../files/kinds';
import type { FileEntry } from '../files/listing';
import type { IcebergRow } from '../iceberg/service';
import { visibleLine as shown } from '../markdown';
import type { Favorite, HistoryEntry, HistoryStatus } from '../sql/history';
import {
  columnDescription,
  columnTooltip,
  connectionDescription,
  connectionTooltip,
  favoriteLabel,
  fileDescription,
  fileRootTooltip,
  fileTooltip,
  FAVORITES_TOOLTIP,
  FILES_TOOLTIP,
  macroDescription,
  macroTooltip,
  partitioningTooltip,
  QUERY_HISTORY_TOOLTIP,
  queryDescription,
  queryLabel,
  queryTooltip,
  schemaTooltip,
  snapshotDescription,
  snapshotsFolderTooltip,
  snapshotTooltip,
  sortOrderTooltip,
  tableTooltip,
  viewColumnTooltip,
  viewTooltip,
} from './format';
import type { TreeDetail } from './format';
import type { ChangedTable, ConnectionNotice, ConnectionState, FilePlace, FolderRef, TreeNode } from './refs';

// Labels and descriptions from the catalog go through `shown`: no control or format character can reorder the tree.

/** The most snapshots the Snapshots folder lists. */
export const SNAPSHOT_LIMIT = 50;

// Every status sets the colour: the node updates in place and must lose the green again.
const STATUS = {
  disconnected: { icon: 'plug', iconColor: undefined, contextValue: 'connection.disconnected' },
  connecting: { icon: 'sync~spin', iconColor: undefined, contextValue: 'connection.disconnected' },
  // aantje-duck is contributed in package.json (contributes.icons), drawn from media/aantje-icons.woff.
  connected: { icon: 'aantje-duck', iconColor: 'charts.green', contextValue: 'connection.connected' },
  error: { icon: 'error', iconColor: 'charts.red', contextValue: 'connection.error' },
} as const;

// A notice (a delete of the lake that did not finish) makes the icon a red error in every status; connecting keeps its
// spinner.
const NOTICED = { icon: 'error', iconColor: 'charts.red' } as const;

// An Azure DuckLake has its own context values, so that only its menu offers Allow My IP and Delete Azure DuckLake.
const AZURE_STATUS = {
  disconnected: { contextValue: 'connection.disconnected.azure' },
  connecting: { contextValue: 'connection.disconnected.azure' },
  connected: { contextValue: 'connection.connected.azure' },
  error: { contextValue: 'connection.error.azure' },
} as const;

// An AWS DuckLake likewise, for its Allow My IP and Delete AWS DuckLake.
const AWS_STATUS = {
  disconnected: { contextValue: 'connection.disconnected.aws' },
  connecting: { contextValue: 'connection.disconnected.aws' },
  connected: { contextValue: 'connection.connected.aws' },
  error: { contextValue: 'connection.error.aws' },
} as const;

// Create Notebook cannot sign in to an Azure DuckLake: its tables and views have context values of their own, so that
// the menus offer everything else there and leave Create Notebook out.
const TABLE = { contextValue: 'table' } as const;
const AZURE_TABLE = { contextValue: 'table.azure' } as const;
const VIEW = { contextValue: 'view' } as const;
const AZURE_VIEW = { contextValue: 'view.azure' } as const;

// The schema main has its own context value, so that its Script as DROP is shown disabled (`isMainSchema`).
const SCHEMA = { contextValue: 'schema' } as const;
const MAIN_SCHEMA = { contextValue: 'schema.main' } as const;

// The context value names the folder kind: the Script as menu offers different entries per kind.
const FOLDERS = {
  tables: { label: 'Tables', segment: 'tables', contextValue: 'folder.tables' },
  views: { label: 'Views', segment: 'views', contextValue: 'folder.views' },
  macros: { label: 'Macros', segment: 'macros', contextValue: 'folder.macros' },
  columns: { label: 'Columns', segment: 'columns', contextValue: 'folder.columns' },
  viewColumns: { label: 'Columns', segment: 'columns', contextValue: 'folder.viewColumns' },
  partitioning: { label: 'Partitioning', segment: 'partitioning', contextValue: 'folder.partitioning' },
  sortOrder: { label: 'Sort Order', segment: 'sortorder', contextValue: 'folder.sortOrder' },
  statistics: { label: 'Statistics', segment: 'statistics', contextValue: 'folder.statistics' },
  history: { label: 'History', segment: 'history', contextValue: 'folder.history' },
  tags: { label: 'Tags', segment: 'tags', contextValue: 'folder.tags' },
  snapshots: { label: 'Snapshots', segment: 'snapshots', contextValue: 'folder.snapshots' },
  queryHistory: { label: 'Query History', segment: 'queries', contextValue: 'folder.queryHistory' },
  favorites: { label: 'Favorites', segment: 'favorites', contextValue: 'folder.favorites' },
  files: { label: 'Files', segment: 'files', contextValue: 'folder.files' },
  iceberg: { label: 'Iceberg', segment: 'iceberg', contextValue: 'folder.iceberg' },
} as const;

// The nodes below Files: a file that DuckDB reads with a table function of its own gets the import scripts.
const FILE_NODES = {
  root: { icon: 'root-folder', contextValue: 'fileRoot' },
  folder: { icon: 'folder', contextValue: 'fileFolder' },
  file: { icon: 'file', contextValue: 'file' },
  importable: { icon: 'file', contextValue: 'file.importable' },
  parquet: { icon: 'file', contextValue: 'file.importable.parquet' },
} as const;

// A Parquet file can also be inspected.
const fileNodeKind = (name: string): (typeof FILE_NODES)['file' | 'importable' | 'parquet'] => {
  const kind = fileTypeOf(name)?.kind;
  return kind === undefined
    ? FILE_NODES.file
    : kind === 'parquet'
      ? FILE_NODES.parquet
      : FILE_NODES.importable;
};

// A failed and a cancelled statement have icons of their own.
const QUERY_ICONS: Readonly<Record<HistoryStatus, string>> = {
  ok: 'code',
  failed: 'error',
  cancelled: 'circle-slash',
};

/*
 * The ids of the nodes a search or an action has to find again: the URI-encoded connection id, then one segment per level.
 * A folder segment is a word, the others are a letter and a number, so that siblings cannot collide.
 */
export function connectionNodeId(connectionId: string): string {
  return encodeURIComponent(connectionId);
}

export function schemaNodeId(parentId: string, schemaId: number): string {
  return `${parentId}/s${schemaId}`;
}

export function folderId(parentId: string, folder: keyof typeof FOLDERS): string {
  return `${parentId}/${FOLDERS[folder].segment}`;
}

export function tableNodeId(parentId: string, tableId: number): string {
  return `${parentId}/t${tableId}`;
}

export function viewNodeId(parentId: string, viewId: number): string {
  return `${parentId}/v${viewId}`;
}

/** Below the Columns folder, or below the column that holds the field. */
export function columnNodeId(parentId: string, columnId: number): string {
  return `${parentId}/c${columnId}`;
}

export function connectionPresentation(
  profile: ConnectionProfile,
  state: ConnectionState,
  expandable: boolean,
  notice?: ConnectionNotice,
): Pick<TreeNode, 'label' | 'description' | 'tooltip' | 'icon' | 'contextValue' | 'hasChildren'> {
  const description = connectionDescription(profile.kind, state);
  return {
    label: profile.name,
    description: notice === undefined ? description : `${notice.label} · ${description}`,
    tooltip: connectionTooltip(profile, state, notice),
    ...STATUS[state.status],
    ...(notice !== undefined && state.status !== 'connecting' ? NOTICED : {}),
    ...(isAzureLake(profile) ? AZURE_STATUS[state.status] : {}),
    ...(isAwsLake(profile) ? AWS_STATUS[state.status] : {}),
    hasChildren: expandable,
  };
}

export function schemaNode(parent: TreeNode, schema: SchemaInfo): TreeNode {
  return {
    id: schemaNodeId(parent.id, schema.id),
    ref: { kind: 'schema', connectionId: parent.ref.connectionId, schema },
    label: shown(schema.name),
    tooltip: schemaTooltip(schema),
    icon: 'symbol-namespace',
    ...(isMainSchema(schema.name) ? MAIN_SCHEMA : SCHEMA),
    hasChildren: true,
  };
}

/** What a row of an Iceberg sync shows: the icon is green when the copy has the state of the lake, red when not. */
export function applyIcebergRow(
  node: TreeNode,
  row: Pick<IcebergRow, 'name' | 'color' | 'description' | 'tooltip'>,
): void {
  node.label = row.name;
  node.description = row.description;
  node.tooltip = row.tooltip;
  node.iconColor = row.color === 'green' ? 'charts.green' : row.color === 'red' ? 'charts.red' : undefined;
}

/** The row of a target that the lake was copied to; its click opens the Iceberg report. */
export function icebergNode(parent: TreeNode, row: IcebergRow): TreeNode {
  const node: TreeNode = {
    id: `${folderId(parent.id, 'iceberg')}-${row.targetId}`,
    ref: { kind: 'folder', connectionId: parent.ref.connectionId, folder: 'iceberg', targetId: row.targetId },
    label: row.name,
    icon: 'database',
    logo: 'iceberg-row',
    contextValue: FOLDERS.iceberg.contextValue,
    command: { id: 'aantje.showIcebergReport', title: 'Iceberg Report' },
    hasChildren: false,
  };
  applyIcebergRow(node, row);
  return node;
}

export function folderNode(parent: TreeNode, folder: FolderRef): TreeNode {
  const { label, contextValue } = FOLDERS[folder.folder];
  return {
    id: folderId(parent.id, folder.folder),
    ref: { kind: 'folder', connectionId: parent.ref.connectionId, ...folder },
    label,
    ...folderPresentation(folder),
    icon: 'folder',
    contextValue,
    ...(folder.folder === 'statistics' && {
      icon: 'graph',
      command: { id: 'aantje.showStatistics', title: 'Statistics' },
    }),
    ...(folder.folder === 'history' && {
      icon: 'history',
      command: { id: 'aantje.showSchemaHistory', title: 'Show History' },
    }),
    ...(folder.folder === 'favorites' && { icon: 'star-full' }),
  };
}

function folderPresentation(folder: FolderRef): Pick<TreeNode, 'description' | 'tooltip' | 'hasChildren'> {
  switch (folder.folder) {
    case 'partitioning':
      return { tooltip: partitioningTooltip(folder.partitioning), hasChildren: true };
    case 'sortOrder':
      return { tooltip: sortOrderTooltip(folder.sortOrder), hasChildren: true };
    case 'snapshots':
      return {
        tooltip: snapshotsFolderTooltip(folder.total !== undefined && folder.total > SNAPSHOT_LIMIT),
        hasChildren: folder.total !== 0,
      };
    case 'queryHistory':
      return { tooltip: QUERY_HISTORY_TOOLTIP, hasChildren: true };
    case 'favorites':
      return { tooltip: FAVORITES_TOOLTIP, hasChildren: true };
    case 'files':
      return { tooltip: FILES_TOOLTIP, hasChildren: true };
    case 'iceberg':
      return { hasChildren: false };
    case 'statistics':
    case 'history':
      return { hasChildren: false };
    case 'tables':
    case 'views':
    case 'macros':
    case 'columns':
    case 'tags':
    case 'viewColumns':
      return { hasChildren: true };
  }
}

/** `azure`: the connection is an Azure DuckLake. */
export function tableNode(parent: TreeNode, schema: SchemaInfo, table: TableInfo, azure = false): TreeNode {
  return {
    id: tableNodeId(parent.id, table.id),
    ref: { kind: 'table', connectionId: parent.ref.connectionId, schema, table },
    label: shown(table.name),
    tooltip: tableTooltip(schema, table),
    icon: 'table',
    ...(azure ? AZURE_TABLE : TABLE),
    hasChildren: true,
  };
}

export function macroNode(parent: TreeNode, schema: SchemaInfo, macro: MacroInfo): TreeNode {
  return {
    id: `${parent.id}/m${macro.id}`,
    ref: { kind: 'macro', connectionId: parent.ref.connectionId, schema, macro },
    label: shown(macro.name),
    description: shown(macroDescription(macro)),
    tooltip: macroTooltip(schema, macro),
    icon: 'symbol-function',
    contextValue: 'macro',
    hasChildren: false,
  };
}

export function snapshotNode(parent: TreeNode, snapshot: SnapshotInfo): TreeNode {
  return {
    id: `${parent.id}/n${snapshot.id}`,
    ref: { kind: 'snapshot', connectionId: parent.ref.connectionId, snapshot },
    label: `@${snapshot.id}`,
    description: snapshotDescription(snapshot),
    tooltip: snapshotTooltip(snapshot),
    icon: 'git-commit',
    contextValue: 'snapshot',
    hasChildren: true,
  };
}

export function detailNode(
  parent: TreeNode,
  key: string,
  { label, description, tooltip, icon }: TreeDetail,
  change?: ChangedTable,
): TreeNode {
  const node: TreeNode = {
    id: `${parent.id}/${key}`,
    ref: { kind: 'detail', connectionId: parent.ref.connectionId },
    label: shown(label),
    description: description === undefined ? undefined : shown(description),
    tooltip,
    icon,
    contextValue: 'detail',
    hasChildren: false,
  };
  return change
    ? {
        ...node,
        ref: { kind: 'detail', connectionId: node.ref.connectionId, change },
        contextValue: 'detail.table',
      }
    : node;
}

/** `expandable`: the tree can resolve view columns, the only children of a view. `azure` as for `tableNode`. */
export function viewNode(
  parent: TreeNode,
  schema: SchemaInfo,
  view: ViewInfo,
  expandable: boolean,
  azure = false,
): TreeNode {
  return {
    id: viewNodeId(parent.id, view.id),
    ref: { kind: 'view', connectionId: parent.ref.connectionId, schema, view },
    label: shown(view.name),
    tooltip: viewTooltip(schema, view),
    icon: 'eye',
    ...(azure ? AZURE_VIEW : VIEW),
    hasChildren: expandable,
  };
}

// DuckDB columns have no catalog id, so the position in the view makes the id.
export function viewColumnNode(
  parent: TreeNode,
  schema: SchemaInfo,
  view: ViewInfo,
  column: RelationColumn,
  index: number,
): TreeNode {
  return {
    id: `${parent.id}/c${index}`,
    ref: { kind: 'viewColumn', connectionId: parent.ref.connectionId, schema, view, column },
    label: shown(column.name),
    description: shown(columnDescription(column)),
    tooltip: viewColumnTooltip(schema, view, column),
    icon: 'symbol-field',
    contextValue: 'viewColumn',
    hasChildren: false,
  };
}

// Column ids are unique per table: a nested field's id is its parent's id plus its own.
export function columnNode(
  parent: TreeNode,
  schema: SchemaInfo,
  table: TableInfo,
  column: ColumnInfo,
  path: readonly string[],
): TreeNode {
  const member = parent.ref.kind === 'column' && ['list', 'map'].includes(parent.ref.column.type);
  const node: TreeNode = {
    id: columnNodeId(parent.id, column.id),
    ref: {
      kind: 'column',
      connectionId: parent.ref.connectionId,
      schema,
      table,
      column,
      path,
      ...(member ? { member } : {}),
    },
    label: shown(column.name),
    description: shown(columnDescription(column)),
    tooltip: columnTooltip(schema, table, path, column),
    icon: 'symbol-field',
    contextValue: 'column',
    hasChildren: column.children.length > 0,
  };
  return member ? { ...node, contextValue: 'column.member' } : node;
}

/**
 * The internal command of the row of a statement or favourite: VS Code runs it on every click, and it opens the
 * statement as a new query on a double-click (`aantje.openQueryHistoryEntry`, Open as New Query in the menu).
 */
export const CLICK_QUERY = '_aantje.clickQueryHistoryEntry';

const OPEN_QUERY = { id: CLICK_QUERY, title: 'Open as New Query' } as const;

/**
 * The children of the folder Query History: the folder Favorites while the connection has any, then the statements,
 * newest first; a double-click opens one as a new query.
 */
export function queryNodes(
  parent: TreeNode,
  entries: readonly HistoryEntry[],
  now: number,
  favorites = 0,
): TreeNode[] {
  return [
    ...(favorites > 0 ? [folderNode(parent, { folder: 'favorites' })] : []),
    ...(entries.length === 0
      ? [messageNode(parent, 'No queries yet.', 'info')]
      : entries.map((entry): TreeNode => ({
          id: `${parent.id}/q${entry.seq}`,
          ref: { kind: 'query', connectionId: parent.ref.connectionId, entry },
          label: queryLabel(entry.sql),
          description: queryDescription(entry, now),
          tooltip: queryTooltip(entry),
          icon: QUERY_ICONS[entry.status],
          contextValue: 'query',
          command: OPEN_QUERY,
          hasChildren: false,
        }))),
  ];
}

/** The favourites below the folder Favorites, newest first: as a statement of the history, with the user's label. */
export function favoriteNodes(parent: TreeNode, favorites: readonly Favorite[], now: number): TreeNode[] {
  return favorites.map((favorite) => ({
    id: `${parent.id}/f${favorite.id}`,
    ref: { kind: 'query', connectionId: parent.ref.connectionId, entry: favorite, favorite },
    label: favoriteLabel(favorite),
    description: queryDescription(favorite, now),
    tooltip: queryTooltip(favorite),
    icon: QUERY_ICONS[favorite.status],
    contextValue: 'query.favorite',
    command: OPEN_QUERY,
    hasChildren: false,
  }));
}

/** A root of the Files folder; its label is the path, shown as text. */
export function fileRootNode(parent: TreeNode, place: FilePlace, index: number): TreeNode {
  return {
    id: `${parent.id}/r${index}`,
    ref: { kind: 'fileFolder', connectionId: parent.ref.connectionId, place },
    label: shown(place.root),
    tooltip: fileRootTooltip(place.root, place.problem),
    ...FILE_NODES.root,
    hasChildren: true,
  };
}

/**
 * A folder or a file of a level below a root. The name is data of whoever writes to the storage: the label shows it
 * as text, and the id encodes it, so that a folder and a file of the same name (possible on an object store) differ.
 */
export function fileEntryNode(parent: TreeNode, place: FilePlace, entry: FileEntry): TreeNode {
  const { connectionId } = parent.ref;
  const name = encodeURIComponent(entry.name);
  if (entry.folder) {
    return {
      id: `${parent.id}/d${name}`,
      ref: {
        kind: 'fileFolder',
        connectionId,
        place: { root: place.root, path: entry.path, context: place.context },
      },
      label: shown(entry.name),
      tooltip: fileTooltip(entry),
      ...FILE_NODES.folder,
      hasChildren: true,
    };
  }
  return {
    id: `${parent.id}/f${name}`,
    ref: { kind: 'file', connectionId, root: place.root, entry },
    label: shown(entry.name),
    description: fileDescription(entry),
    tooltip: fileTooltip(entry),
    ...fileNodeKind(entry.name),
    hasChildren: false,
  };
}

/** A message in place of a level; a click runs `command` for the connection, when given. */
export function messageNode(
  parent: TreeNode,
  text: string,
  icon: 'info' | 'error',
  command?: TreeNode['command'],
): TreeNode {
  return {
    id: `${parent.id}/message`,
    ref: { kind: 'message', connectionId: parent.ref.connectionId, text },
    label: text,
    icon,
    contextValue: 'message',
    ...(command === undefined ? {} : { command }),
    hasChildren: false,
  };
}
