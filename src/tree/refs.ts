import type {
  ColumnInfo,
  MacroInfo,
  PartitioningInfo,
  SchemaInfo,
  SnapshotId,
  SnapshotInfo,
  SortOrderInfo,
  TableInfo,
  TagsInfo,
  ViewInfo,
} from '../catalog/model';
import type { RelationColumn, TableRef } from '../data/types';
import type { HistoryEntry } from '../sql/history';

/** Payload of a node: everything the commands need to act on it. */
export type NodeRef =
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'schema'; readonly connectionId: string; readonly schema: SchemaInfo }
  | {
      readonly kind: 'table';
      readonly connectionId: string;
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
    }
  | {
      readonly kind: 'view';
      readonly connectionId: string;
      readonly schema: SchemaInfo;
      readonly view: ViewInfo;
    }
  | {
      readonly kind: 'column';
      readonly connectionId: string;
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
      readonly column: ColumnInfo;
      /** Names from the top-level column down to this column, e.g. `['customer', 'name']`. */
      readonly path: readonly string[];
      /** A list element or map key/value: it has no name to create, rename or drop. */
      readonly member?: true;
    }
  | {
      readonly kind: 'viewColumn';
      readonly connectionId: string;
      readonly schema: SchemaInfo;
      readonly view: ViewInfo;
      readonly column: RelationColumn;
    }
  | ({ readonly kind: 'folder'; readonly connectionId: string } & FolderRef)
  | {
      readonly kind: 'macro';
      readonly connectionId: string;
      readonly schema: SchemaInfo;
      readonly macro: MacroInfo;
    }
  | { readonly kind: 'snapshot'; readonly connectionId: string; readonly snapshot: SnapshotInfo }
  /** A leaf that shows a fact; only a table change (`change`) has a command. */
  | { readonly kind: 'detail'; readonly connectionId: string; readonly change?: ChangedTable }
  /** A statement of the Query History. */
  | { readonly kind: 'query'; readonly connectionId: string; readonly entry: HistoryEntry }
  | { readonly kind: 'message'; readonly connectionId: string; readonly text: string };

/** A table a snapshot changed, as it is at that snapshot. */
export interface ChangedTable {
  readonly snapshot: SnapshotId;
  readonly table: TableRef;
}

/**
 * What a folder groups; it carries what was read to show it, so only `snapshots` needs a query on expansion.
 * `queryHistory` reads aantje's own record of the statements it ran, not the catalog.
 */
export type FolderRef =
  | { readonly folder: 'tables'; readonly schema: SchemaInfo; readonly tables: readonly TableInfo[] }
  | { readonly folder: 'views'; readonly schema: SchemaInfo; readonly views: readonly ViewInfo[] }
  | { readonly folder: 'macros'; readonly schema: SchemaInfo; readonly macros: readonly MacroInfo[] }
  | {
      readonly folder: 'columns';
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
      readonly columns: readonly ColumnInfo[];
    }
  | { readonly folder: 'viewColumns'; readonly schema: SchemaInfo; readonly view: ViewInfo }
  | {
      readonly folder: 'partitioning';
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
      readonly partitioning: PartitioningInfo;
    }
  | {
      readonly folder: 'sortOrder';
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
      readonly sortOrder: SortOrderInfo;
    }
  | { readonly folder: 'statistics'; readonly schema: SchemaInfo; readonly table: TableInfo }
  | { readonly folder: 'history'; readonly schema: SchemaInfo; readonly table: TableInfo }
  | {
      readonly folder: 'tags';
      readonly schema: SchemaInfo;
      readonly table: TableInfo;
      readonly tags: TagsInfo;
    }
  | { readonly folder: 'snapshots'; readonly total?: number }
  | { readonly folder: 'queryHistory' };

/** A node of the explorer; connection nodes update in place because VS Code matches change events by identity. */
export interface TreeNode {
  /** Unique in the tree and stable across refreshes, so VS Code keeps the expansion state. */
  readonly id: string;
  readonly ref: NodeRef;
  label: string;
  description?: string;
  /** Markdown. */
  tooltip?: string;
  /** Codicon id, e.g. `table`. */
  icon: string;
  /** Theme colour id for the icon, e.g. `charts.green`. */
  iconColor?: string;
  /** Matches the `viewItem` conditions of the menus in package.json. */
  contextValue: string;
  /** Runs on click; receives the node. */
  command?: { readonly id: string; readonly title: string };
  hasChildren: boolean;
}

export interface ConnectionState {
  readonly status: 'disconnected' | 'connecting' | 'connected' | 'error';
  /** Set while connected. */
  readonly specVersion?: string;
  /** Newest snapshot at the last connect or refresh; set while connected. */
  readonly latestSnapshot?: SnapshotId;
  /** A pinned id, or `latest` for `latestSnapshot`. */
  readonly snapshot: SnapshotId | 'latest';
  /** Set in the `error` status. */
  readonly error?: string;
}
