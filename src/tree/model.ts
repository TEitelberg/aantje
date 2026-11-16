import type { CatalogInfo, CatalogReader, SchemaInfo, SnapshotId, ViewInfo } from '../catalog/model';
import type { OpenedCatalog } from '../catalog/open';
import { isAzureLake } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import type { RelationColumn } from '../data/types';
import { isAantjeError, isAborted, userMessageOf } from '../errors';
import type { FilesPort } from '../files/source';
import { silentLogger } from '../log';
import { byName } from '../order';
import type { Logger } from '../log';
import type { IcebergRow } from '../iceberg/service';
import type { QueryHistory } from '../sql/history';
import { tableTooltip } from './format';
import { listsFiles, readFiles } from './files';
import { readBelow } from './levels';
import type { ViewReader } from './levels';
import {
  connectionNodeId,
  connectionPresentation,
  folderId,
  applyIcebergRow,
  folderNode,
  icebergNode,
  messageNode,
  queryNodes,
  schemaNode,
} from './nodes';
import type { ConnectionNotice, ConnectionState, TreeNode } from './refs';

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
  /** The statements the SQL editor ran; without it, a connection has no folder Query History. */
  queryHistory?: Pick<QueryHistory, 'shown' | 'entries'>;
  /** The storage of the lake; without it, a connection has no folder Files. A Quack connection never has one. */
  files?: FilesPort;
  /** The copies of a lake to Iceberg: their rows, the lines for the tooltips of copied tables, and the check that updates them. */
  iceberg?: {
    rows(connectionId: string): readonly IcebergRow[];
    tableLines(connectionId: string, schema: string, table: string): readonly string[];
    /** `Iceberg: 3 behind` while the lake changed a synced table after the sync; undefined otherwise. */
    tableHint?(connectionId: string, schema: string, table: string): string | undefined;
    check(connectionId: string): Promise<void>;
    /** Tells when the rows or the state of a connection's copies changed. */
    onDidChange(listener: (connectionId: string) => void): { dispose(): void };
  };
  /** What a connection must show in any status (a delete of its lake that did not finish), and when that changes. */
  notices?: {
    of(connectionId: string): ConnectionNotice | undefined;
    onDidChange(listener: (connectionId: string) => void): { dispose(): void };
  };
  logger?: Logger;
}

// Every resolved view starts a DuckDB instance; cap parallel reads.
const MAX_VIEW_READS = 3;

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

  private readonly icebergListener: { dispose(): void } | undefined;
  private readonly noticeListener: { dispose(): void } | undefined;

  constructor(private readonly deps: CatalogTreeDeps) {
    this.logger = deps.logger ?? silentLogger;
    this.icebergListener = deps.iceberg?.onDidChange((connectionId) => this.icebergChanged(connectionId));
    this.noticeListener = deps.notices?.onDidChange((connectionId) => {
      const conn = this.connections.get(connectionId);
      if (conn) this.changed(conn);
    });
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
    // aantje's own record, read anew each time: it changes with every run, not with the catalog.
    if (node.ref.kind === 'folder' && node.ref.folder === 'queryHistory') {
      const entries = this.deps.queryHistory?.entries(node.ref.connectionId) ?? [];
      return Promise.resolve(queryNodes(node, entries, Date.now()));
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

  /** A sync to Iceberg was checked: its rows and the tooltips of the copied tables show the result. */
  icebergChanged(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    const rows = this.deps.iceberg?.rows(connectionId) ?? [];
    for (const node of conn?.cache.nodes.values() ?? []) {
      if (node.ref.kind === 'folder' && node.ref.folder === 'iceberg') {
        const { targetId } = node.ref;
        const row = rows.find((candidate) => candidate.targetId === targetId);
        if (row) {
          applyIcebergRow(node, row);
          this.emit(node);
        }
      } else if (conn && this.showIceberg(conn, node)) {
        // VS Code keeps the item it was given: a new line in the tooltip needs a change event.
        this.emit(node);
      }
    }
  }

  /**
   * The Iceberg state of a synced table: a line below its tooltip, and `Iceberg: n behind` as its description while
   * the lake changed it after the sync; true when either changed.
   */
  private showIceberg(conn: Connection, node: TreeNode): boolean {
    if (node.ref.kind !== 'table') return false;
    const { schema, table } = node.ref;
    const lines = this.deps.iceberg?.tableLines(conn.profile.id, schema.name, table.name) ?? [];
    const tooltip = [tableTooltip(schema, table), ...lines].join('\n\n');
    const description = this.deps.iceberg?.tableHint?.(conn.profile.id, schema.name, table.name);
    if (tooltip === node.tooltip && description === node.description) return false;
    node.tooltip = tooltip;
    node.description = description;
    return true;
  }

  /** The folder Query History of a connection, once its level was read: the node to fire a change for after a run. */
  queryHistoryFolder(connectionId: string): TreeNode | undefined {
    const conn = this.connections.get(connectionId);
    return conn?.cache.nodes.get(folderId(conn.node.id, 'queryHistory'));
  }

  /**
   * Lists a part of the folder Files again (the folder, a root or a folder below it) without reopening the connection:
   * the cached levels of the node and below are dropped, and the node is reported as changed.
   */
  refreshFiles(node: TreeNode): void {
    const conn = this.connections.get(node.ref.connectionId);
    if (!conn || !listsFiles(node) || conn.cache.nodes.get(node.id) !== node) {
      return;
    }
    const below = `${node.id}/`;
    for (const map of [conn.cache.children, conn.cache.parents, conn.cache.nodes]) {
      for (const id of [...map.keys()]) {
        if (id.startsWith(below)) map.delete(id);
      }
    }
    conn.cache.children.delete(node.id);
    this.emit(node);
  }

  /**
   * Reads the levels of every connection, or of one, again without reopening it: when the Query History is switched on
   * or off, or after a sync to Iceberg, which changes the rows of a lake but not the lake.
   */
  reread(connectionId?: string): void {
    for (const conn of this.sync()) {
      if (connectionId !== undefined && conn.profile.id !== connectionId) continue;
      this.replaceCache(conn);
      this.changed(conn);
    }
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
    this.icebergListener?.dispose();
    this.noticeListener?.dispose();
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
    const notice = this.deps.notices?.of(conn.profile.id);
    Object.assign(conn.node, connectionPresentation(conn.profile, stateOf(conn), expandable, notice));
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
      this.showIceberg(conn, child);
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
    if (listsFiles(node)) {
      const { files } = this.deps;
      return files
        ? readFiles(files, conn.profile, phase.reader, node, cache.stale.signal)
        : Promise.resolve([]);
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
    return readBelow(
      {
        reader: phase.reader,
        snapshot: snapshotOf(conn.snapshot, phase.info),
        columnsOfView,
        azure: isAzureLake(conn.profile),
      },
      node,
    );
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
        // Connecting and refreshing check the copies to Iceberg again; the rows show the result when it is in.
        void this.deps.iceberg?.check(conn.profile.id);
        const [schemas, total] = await Promise.all([
          phase.reader.schemas(snapshotOf(conn.snapshot, phase.info)),
          this.snapshotCount(conn.profile, phase.reader),
        ]);
        return [
          ...schemas.toSorted(byName).map((schema) => schemaNode(node, schema)),
          folderNode(node, { folder: 'snapshots', total }),
          ...(this.deps.queryHistory?.shown() ? [folderNode(node, { folder: 'queryHistory' })] : []),
          // Quack: the server reads the files, not aantje.
          ...(this.deps.files && conn.profile.kind !== 'quack'
            ? [folderNode(node, { folder: 'files' })]
            : []),
          ...(this.deps.iceberg?.rows(conn.profile.id) ?? []).map((row) => icebergNode(node, row)),
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
