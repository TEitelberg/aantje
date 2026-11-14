import { isMainSchema } from '../catalog/model';
import type { ColumnInfo, MacroInfo, SchemaInfo, SnapshotInfo, TableInfo, ViewInfo } from '../catalog/model';
import { isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { RelationColumn } from '../data/types';
import { visibleLine as shown } from '../markdown';
import type { HistoryEntry, HistoryStatus } from '../sql/history';
import {
  columnDescription,
  columnTooltip,
  connectionDescription,
  connectionTooltip,
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
import type { ChangedTable, ConnectionState, FolderRef, TreeNode } from './refs';

// Labels and descriptions from the catalog go through `shown`: no control or format character can reorder the tree.

/** The most snapshots the Snapshots folder lists. */
export const SNAPSHOT_LIMIT = 50;

// Every status sets the colour: the node updates in place and must lose the green again.
const STATUS = {
  disconnected: { icon: 'plug', iconColor: undefined, contextValue: 'connection.disconnected' },
  connecting: { icon: 'sync~spin', iconColor: undefined, contextValue: 'connection.disconnected' },
  // aantje-duck is contributed in package.json (contributes.icons), drawn from media/aantje-icons.woff.
  connected: { icon: 'aantje-duck', iconColor: 'charts.green', contextValue: 'connection.connected' },
  error: { icon: 'error', iconColor: undefined, contextValue: 'connection.error' },
} as const;

// An Azure DuckLake has its own context values, so that only its menu offers Allow My IP and Delete Azure DuckLake.
const AZURE_STATUS = {
  disconnected: { contextValue: 'connection.disconnected.azure' },
  connecting: { contextValue: 'connection.disconnected.azure' },
  connected: { contextValue: 'connection.connected.azure' },
  error: { contextValue: 'connection.error.azure' },
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
} as const;

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
): Pick<TreeNode, 'label' | 'description' | 'tooltip' | 'icon' | 'contextValue' | 'hasChildren'> {
  return {
    label: profile.name,
    description: connectionDescription(profile.kind, state),
    tooltip: connectionTooltip(profile, state),
    ...STATUS[state.status],
    ...(isAzureLake(profile) ? AZURE_STATUS[state.status] : {}),
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

/** The statements below the folder Query History, newest first; a click opens one as a new query. */
export function queryNodes(parent: TreeNode, entries: readonly HistoryEntry[], now: number): TreeNode[] {
  if (entries.length === 0) return [messageNode(parent, 'No queries yet.', 'info')];
  return entries.map((entry) => ({
    id: `${parent.id}/q${entry.seq}`,
    ref: { kind: 'query', connectionId: parent.ref.connectionId, entry },
    label: queryLabel(entry.sql),
    description: queryDescription(entry, now),
    tooltip: queryTooltip(entry),
    icon: QUERY_ICONS[entry.status],
    contextValue: 'query',
    command: { id: 'aantje.openQueryHistoryEntry', title: 'Open as New Query' },
    hasChildren: false,
  }));
}

export function messageNode(parent: TreeNode, text: string, icon: 'info' | 'error'): TreeNode {
  return {
    id: `${parent.id}/message`,
    ref: { kind: 'message', connectionId: parent.ref.connectionId, text },
    label: text,
    icon,
    contextValue: 'message',
    hasChildren: false,
  };
}
