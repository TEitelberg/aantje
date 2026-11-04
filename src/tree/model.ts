import type {
  CatalogInfo,
  CatalogReader,
  ResolvedAction,
  SchemaInfo,
  SnapshotId,
  ViewInfo,
} from '../catalog/model';
import type { OpenedCatalog } from '../catalog/open';
import { isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { RelationColumn } from '../data/types';
import { isAborted } from '../data/aborted';
import { isAantjeError, userMessageOf } from '../errors';
import { silentLogger } from '../log';
import { collator } from '../order';
import type { Logger } from '../log';
import { changeDetail, columnTagDetail, partitionDetail, sortDetail, tableTagDetail } from './format';
import type { TreeDetail } from './format';
import {
  columnNode,
  connectionNodeId,
  connectionPresentation,
  detailNode,
  folderNode,
  macroNode,
  messageNode,
  schemaNode,
  SNAPSHOT_LIMIT,
  snapshotNode,
  tableNode,
  viewColumnNode,
  viewNode,
} from './nodes';
import type { ConnectionState, NodeRef, TreeNode } from './refs';

export interface CatalogTreeDeps {
  /** Connections in display order, read on every `roots()`; ids must be unique. */
  profiles(): readonly ConnectionProfile[];
  /** A catalog that passed its check, with what the check read; the tree closes the reader. */
  open(profile: ConnectionProfile): Promise<OpenedCatalog>;
  /** View columns as DuckDB resolves them (runs the view SQL); a rejection becomes a message node, retried after refresh. */
  viewColumns?: (
    connectionId: string,
    schema: SchemaInfo,
    view: ViewInfo,
    snapshot: SnapshotId,
    signal: AbortSignal,
  ) => Promise<readonly RelationColumn[]>;
  logger?: Logger;
}

// Every resolved view starts a DuckDB instance; cap parallel reads.
const MAX_VIEW_READS = 3;

// A snapshot with only these actions moves files; nothing to show.
const MAINTENANCE = new Set<ResolvedAction>(['flushed_inlined', 'compacted', 'merged', 'rewritten']);

type Phase =
  | { readonly status: 'disconnected'; readonly autoConnect: boolean }
  | { readonly status: 'connecting' }
  | { readonly status: 'connected'; readonly reader: CatalogReader; readonly info: CatalogInfo }
  | { readonly status: 'error'; readonly error: string };

interface Cache {
  readonly children: Map<string, Promise<TreeNode[]>>;
  readonly parents: Map<string, TreeNode>;
  // Nodes of an earlier cache must not be read into this one.
  readonly nodes: Map<string, TreeNode>;
  readonly stale: AbortController;
}

interface Connection {
  profile: ConnectionProfile;
  readonly node: TreeNode;
  phase: Phase;
  snapshot: SnapshotId | 'latest';
  // Shared by all callers, so a catalog is never opened twice.
  opening?: Promise<void>;
  // Replaced, not cleared, so that late results land nowhere.
  cache: Cache;
}

/** Lazy tree model of the explorer; levels are cached per connection and snapshot. See docs/en/tree.md. */
export class CatalogTree {
  private readonly connections = new Map<string, Connection>();
  private readonly listeners = new Set<(node: TreeNode | undefined) => void>();
  private readonly refreshListeners = new Set<(connectionId: string) => void>();
  private readonly logger: Logger;
  private readonly limitViewReads = limiter(MAX_VIEW_READS);

  constructor(private readonly deps: CatalogTreeDeps) {
    this.logger = deps.logger ?? silentLogger;
  }

  /** One node per profile; connections without a profile are closed and dropped. */
  roots(): TreeNode[] {
    return this.sync().map((conn) => conn.node);
  }

  /** The children at the connection's snapshot; expanding opens a connection unless disconnected on purpose. Cached until refresh. */
  children(node: TreeNode): Promise<TreeNode[]> {
    const conn = this.connections.get(node.ref.connectionId);
    if (!conn || !node.hasChildren || (node.ref.kind !== 'connection' && conn.phase.status !== 'connected')) {
      return Promise.resolve([]);
    }
    const { cache } = conn;
    // VS Code may still ask a node of a replaced cache; its data must not enter the new cache.
    if (node.ref.kind !== 'connection' && cache.nodes.get(node.id) !== node) {
      return Promise.resolve([]);
    }
    let children = cache.children.get(node.id);
    if (!children) {
      children = this.load(conn, node, cache);
      cache.children.set(node.id, children);
    }
    return children;
  }

  /** The node this node was read from, while the cached children are valid. */
  parent(node: TreeNode): TreeNode | undefined {
    return this.connections.get(node.ref.connectionId)?.cache.parents.get(node.id);
  }

  state(connectionId: string): ConnectionState {
    const conn = this.connections.get(connectionId);
    return conn ? stateOf(conn) : { status: 'disconnected', snapshot: 'latest' };
  }

  reader(connectionId: string): CatalogReader | undefined {
    const phase = this.connections.get(connectionId)?.phase;
    return phase?.status === 'connected' ? phase.reader : undefined;
  }

  /** Opens the connection unless it is connected. A failure does not reject but sets the `error` status. */
  async connect(connectionId: string): Promise<void> {
    const conn = this.find(connectionId);
    if (!conn || conn.phase.status === 'connected') {
      return;
    }
    if (conn.phase.status === 'error') {
      this.replaceCache(conn);
    }
    await this.open(conn);
  }

  /** Closes the reader and forgets the pinned snapshot; not expandable until `connect()`. */
  async disconnect(connectionId: string): Promise<void> {
    const conn = this.find(connectionId);
    if (!conn) {
      return;
    }
    // A refresh during an attempt starts another one when it ends: wait for all of them.
    while (conn.opening) {
      await conn.opening;
    }
    const { phase } = conn;
    conn.phase = { status: 'disconnected', autoConnect: false };
    conn.snapshot = 'latest';
    this.replaceCache(conn);
    this.changed(conn);
    if (phase.status === 'connected') {
      this.logger.info(`Disconnected from "${conn.profile.name}".`);
      await this.closeReader(phase.reader);
    }
  }

  /** Reopens a connected or failed connection (all without a node) so `latest` moves; never refreshes part of a tree. */
  refresh(node?: TreeNode): void {
    const connections = this.sync();
    const targets = node
      ? connections.filter((conn) => conn.profile.id === node.ref.connectionId)
      : connections;
    for (const conn of targets) {
      this.replaceCache(conn);
      if (conn.phase.status === 'connected' || conn.phase.status === 'error') {
        void this.open(conn);
      } else if (conn.phase.status === 'connecting') {
        // The attempt that is running captured the profile of before (Edit Connection, a changed setting) and belongs
        // to the cache that was just replaced: open again with the current profile when it has ended.
        void conn.opening?.then(() => {
          const { status } = conn.phase;
          if (
            this.connections.get(conn.profile.id) === conn &&
            (status === 'connected' || status === 'error')
          ) {
            void this.open(conn);
          }
        });
      }
      for (const listener of [...this.refreshListeners]) {
        listener(conn.profile.id);
      }
    }
    this.emit(node && targets[0]?.node);
  }

  /** The listener gets the id of each connection that a refresh reloads: what open reports show may be out of date. */
  onDidRefresh(listener: (connectionId: string) => void): { dispose(): void } {
    this.refreshListeners.add(listener);
    return { dispose: () => void this.refreshListeners.delete(listener) };
  }

  /** Re-reads the profiles without reopening any connection. */
  profilesChanged(): void {
    this.sync();
    this.emit(undefined);
  }

  /** Shows a connection's tree at a snapshot, or at the newest one. */
  selectSnapshot(connectionId: string, snapshot: SnapshotId | 'latest'): void {
    const conn = this.find(connectionId);
    if (!conn) {
      return;
    }
    conn.snapshot = snapshot;
    this.replaceCache(conn);
    this.changed(conn);
  }

  /** The listener gets the changed connection node, or `undefined` when the whole tree is stale. */
  onDidChange(listener: (node: TreeNode | undefined) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    this.refreshListeners.clear();
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map((conn) => this.release(conn)));
  }

  private find(connectionId: string): Connection | undefined {
    return this.sync().find((conn) => conn.profile.id === connectionId);
  }

  private sync(): Connection[] {
    const profiles = this.deps.profiles();
    const ids = new Set(profiles.map((profile) => profile.id));
    for (const [id, conn] of this.connections) {
      if (!ids.has(id)) {
        this.connections.delete(id);
        void this.release(conn);
      }
    }
    return profiles.map((profile) => {
      const conn = this.connections.get(profile.id) ?? newConnection(profile);
      conn.profile = profile;
      this.connections.set(profile.id, conn);
      this.present(conn);
      return conn;
    });
  }

  private present(conn: Connection): void {
    const { phase } = conn;
    const expandable = phase.status !== 'disconnected' || phase.autoConnect;
    Object.assign(conn.node, connectionPresentation(conn.profile, stateOf(conn), expandable));
  }

  private changed(conn: Connection): void {
    this.present(conn);
    this.emit(conn.node);
  }

  private emit(node: TreeNode | undefined): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(node);
      } catch (error) {
        this.logger.error('A tree change listener failed.', error);
      }
    }
  }

  private open(conn: Connection): Promise<void> {
    if (!conn.opening) {
      const previous = conn.phase;
      conn.phase = { status: 'connecting' };
      conn.opening = this.establish(conn, previous).finally(() => {
        conn.opening = undefined;
      });
      // After `opening` is set, so a listener that calls back joins this attempt.
      this.changed(conn);
    }
    return conn.opening;
  }

  // Never rejects.
  private async establish(conn: Connection, previous: Phase): Promise<void> {
    const { profile } = conn;
    try {
      const { reader, info } = await this.deps.open(profile);
      conn.phase = { status: 'connected', reader, info };
      this.logger.info(
        `Connected to "${profile.name}" (DuckLake ${info.specVersion}, latest snapshot ${info.latestSnapshot}).`,
      );
    } catch (error) {
      this.logger.error(`Cannot connect to "${profile.name}".`, error);
      if (isAzureLake(profile) && isAantjeError(error) && error.code === 'NOT_A_DUCKLAKE') {
        this.logger.info(notAttachedYet(profile.name));
      }
      conn.phase = { status: 'error', error: userMessageOf(error) };
    }
    this.changed(conn);
    if (previous.status === 'connected') {
      await this.closeReader(previous.reader);
    }
  }

  private replaceCache(conn: Connection): void {
    conn.cache.stale.abort();
    conn.cache = newCache();
  }

  private async release(conn: Connection): Promise<void> {
    conn.cache.stale.abort();
    await conn.opening;
    if (conn.phase.status === 'connected') {
      await this.closeReader(conn.phase.reader);
    }
  }

  private async closeReader(reader: CatalogReader | undefined): Promise<void> {
    try {
      await reader?.close();
    } catch (error) {
      this.logger.error('Closing the catalog reader failed.', error);
    }
  }

  private async load(conn: Connection, node: TreeNode, cache: Cache): Promise<TreeNode[]> {
    let children: TreeNode[];
    try {
      children = await this.read(conn, node, cache);
    } catch (error) {
      if (cache.stale.signal.aborted && isAborted(error)) {
        // Nobody waits for the answer; "cancelled" would only flash up before the level is read again.
        children = [];
      } else if (isAborted(error)) {
        // Declined or cancelled is not a failure: no error log entry, no error icon.
        this.logger.info(
          `The children of "${nameOf(node)}" in "${conn.profile.name}" were not read: ${userMessageOf(error)}`,
        );
        children = [messageNode(node, userMessageOf(error), 'info')];
      } else {
        this.logger.error(`Cannot read the children of "${nameOf(node)}" in "${conn.profile.name}".`, error);
        children = [messageNode(node, userMessageOf(error), 'error')];
      }
    }
    for (const child of children) {
      cache.parents.set(child.id, node);
      cache.nodes.set(child.id, child);
    }
    return children;
  }

  private read(conn: Connection, node: TreeNode, cache: Cache): Promise<TreeNode[]> {
    if (node.ref.kind === 'connection') {
      return this.readConnection(conn, node);
    }
    const { phase } = conn;
    if (phase.status !== 'connected') {
      return Promise.resolve([]);
    }
    const { viewColumns } = this.deps;
    const columnsOfView: ViewReader | undefined =
      viewColumns &&
      ((schema, view, snapshot) =>
        this.limitViewReads(() =>
          // The cache may have been replaced while waiting.
          cache.stale.signal.aborted
            ? Promise.resolve([])
            : viewColumns(node.ref.connectionId, schema, view, snapshot, cache.stale.signal),
        ));
    return readBelow(phase.reader, snapshotOf(conn.snapshot, phase.info), node, columnsOfView);
  }

  private async readConnection(conn: Connection, node: TreeNode): Promise<TreeNode[]> {
    if (
      conn.phase.status === 'connecting' ||
      (conn.phase.status === 'disconnected' && conn.phase.autoConnect)
    ) {
      await this.open(conn);
    }
    const { phase } = conn;
    switch (phase.status) {
      case 'error':
        return [messageNode(node, phase.error, 'error')];
      case 'connected': {
        const [schemas, total] = await Promise.all([
          phase.reader.schemas(snapshotOf(conn.snapshot, phase.info)),
          this.snapshotCount(conn.profile, phase.reader),
        ]);
        return [
          ...schemas.toSorted(byName).map((schema) => schemaNode(node, schema)),
          folderNode(node, { folder: 'snapshots', total }),
        ];
      }
      default:
        return [];
    }
  }

  // Failing only drops the count: a catalog whose snapshots cannot be counted still shows its schemas.
  private async snapshotCount(
    profile: ConnectionProfile,
    reader: CatalogReader,
  ): Promise<number | undefined> {
    try {
      return await reader.snapshotCount();
    } catch (error) {
      this.logger.warn(`Cannot count the snapshots of "${profile.name}": ${userMessageOf(error)}`);
      return undefined;
    }
  }
}

type ViewReader = (
  schema: SchemaInfo,
  view: ViewInfo,
  snapshot: SnapshotId,
) => Promise<readonly RelationColumn[]>;

async function readBelow(
  reader: CatalogReader,
  snapshot: SnapshotId,
  node: TreeNode,
  columnsOfView: ViewReader | undefined,
): Promise<TreeNode[]> {
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
      return readFolder(reader, node, ref, columnsOfView, snapshot);
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
      !MAINTENANCE.has(change.action) &&
      change.schemaName !== null &&
      change.name !== null
        ? { snapshot: snapshot.id, table: { schema: change.schemaName, table: change.name } }
        : undefined;
    return detailNode(node, `c${index}`, changeDetail(change), table);
  });
}

async function readFolder(
  reader: CatalogReader,
  node: TreeNode,
  ref: Extract<NodeRef, { kind: 'folder' }>,
  columnsOfView: ViewReader | undefined,
  snapshot: SnapshotId,
): Promise<TreeNode[]> {
  const details = (prefix: string, list: readonly TreeDetail[]): TreeNode[] =>
    list.map((detail, index) => detailNode(node, `${prefix}${index}`, detail));
  switch (ref.folder) {
    case 'tables':
      return ref.tables.length > 0
        ? ref.tables.map((table) => tableNode(node, ref.schema, table))
        : [messageNode(node, 'No tables.', 'info')];
    case 'views':
      return ref.views.length > 0
        ? ref.views.map((view) => viewNode(node, ref.schema, view, columnsOfView !== undefined))
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

function limiter(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (running < max) {
      running++;
    } else {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      // The next waiter takes over the finished task's slot.
      const next = waiting.shift();
      if (next) {
        next();
      } else {
        running--;
      }
    }
  };
}

function newCache(): Cache {
  return { children: new Map(), parents: new Map(), nodes: new Map(), stale: new AbortController() };
}

function newConnection(profile: ConnectionProfile): Connection {
  return {
    profile,
    node: {
      // Encoded, so no connection id can look like a node id below another connection.
      id: connectionNodeId(profile.id),
      ref: { kind: 'connection', connectionId: profile.id },
      ...connectionPresentation(profile, { status: 'disconnected', snapshot: 'latest' }, true),
    },
    phase: { status: 'disconnected', autoConnect: true },
    snapshot: 'latest',
    cache: newCache(),
  };
}

function stateOf({ phase, snapshot }: Connection): ConnectionState {
  switch (phase.status) {
    case 'connected':
      return {
        status: 'connected',
        specVersion: phase.info.specVersion,
        latestSnapshot: phase.info.latestSnapshot,
        snapshot,
      };
    case 'error':
      return { status: 'error', snapshot, error: phase.error };
    default:
      return { status: phase.status, snapshot };
  }
}

function snapshotOf(selected: SnapshotId | 'latest', info: CatalogInfo): SnapshotId {
  return selected === 'latest' ? info.latestSnapshot : selected;
}

/** Case-insensitive, numbers by value ("table2" before "table10"). */
export function byName(a: { readonly name: string }, b: { readonly name: string }): number {
  return collator.compare(a.name, b.name);
}

// A folder is named after its owner; "Columns" alone says too little in the log.
function nameOf({ label, ref }: TreeNode): string {
  if (ref.kind !== 'folder') {
    return label;
  }
  const owner =
    'table' in ref ? ref.table.name : 'view' in ref ? ref.view.name : 'schema' in ref ? ref.schema.name : '';
  return owner === '' ? label : `${owner}/${label}`;
}

// A new Azure DuckLake gets its tables from its first attach, which runs after the connection was saved: the explorer
// can open it in between, or the creation broke off before it.
function notAttachedYet(name: string): string {
  return `"${name}" is an Azure DuckLake without DuckLake tables yet: the first attach of Create Azure DuckLake creates them. If the creation is still running, wait until it reports the lake as created, then click Refresh in the title of the explorer. If it was interrupted, run "aantje: Finish Creating Azure DuckLake..." from the Command Palette (Ctrl+Shift+P or F1).`;
}
