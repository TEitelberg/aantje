import type { CatalogReader, SnapshotId } from '../catalog/model';
import { openingSignature } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import { isAborted } from '../data/aborted';
import { resolveViewColumns } from '../data/resolve';
import type { DataAccessFactory } from '../data/resolve';
import type { ViewTrustStore } from '../data/trust';
import { AantjeError, userMessageOf } from '../errors';
import type { Logger } from '../log';
import { catalogOfReader } from './catalog';
import type { SqlCatalog, ViewColumnSource } from './catalog';
import type { SqlToken } from './tokens';
import { statementSpans } from './script';
import { MAX_RESULT_CELLS } from './results';
import type { ResultsView, RunSummary } from './results';
import type { SessionMode, SqlEvent, SqlSession, TransactionState } from './session';

/** A document of the SQL editor; the key is stable for the document's life, the name is display only. */
export interface EditorRef {
  readonly key: string;
  readonly name: string;
}

/** The explorer, as far as the editor needs it. */
export interface ExplorerPort {
  status(connectionId: string): 'disconnected' | 'connecting' | 'connected' | 'error';
  disconnect(connectionId: string): Promise<void>;
  /** Reconnects a connection that the editor disconnected, once its session failed to open or closed. */
  connect(connectionId: string): void;
  /** Reloads the connection so that the tree shows what a run changed. */
  refresh(connectionId: string): void;
}

export interface QueryUi {
  info(message: string): void;
  /** The id of the chosen connection, or undefined when the user cancels. */
  pickConnection(profiles: readonly ConnectionProfile[]): Promise<string | undefined>;
  /** Shows progress with a Cancel button that aborts the task's signal. */
  withProgress<T>(title: string, task: (cancel: AbortSignal) => Promise<T>): Promise<T>;
}

interface QueryEditorDeps {
  readonly profiles: {
    list(): readonly ConnectionProfile[];
    get(id: string): ConnectionProfile | undefined;
  };
  openSession(profile: ConnectionProfile, mode: SessionMode, signal: AbortSignal): Promise<SqlSession>;
  readonly results: ResultsView;
  readonly explorer: ExplorerPort;
  readonly ui: QueryUi;
  /** Read at every run, so a setting change applies to the next run. */
  maxRows(): number;
  now?(): number;
}

interface QueryEditorState {
  readonly connectionId: string;
  readonly connectionName: string;
  readonly mode: SessionMode;
  /** Whether the session can switch to the other mode; a Quack session has full access only. */
  readonly switchable: boolean;
  readonly running: boolean;
  readonly sessionOpen: boolean;
  readonly inTransaction: TransactionState;
}

// `association` is true when the document gained, lost or changed its connection.
interface QueryEditorChange {
  readonly key: string;
  readonly association: boolean;
}

interface Entry {
  connectionId: string;
  name: string;
  /** The opening signature of the connection as the editor got it; a change closes the session. */
  signature: string;
  /** The mode the user switched to; without it the profile decides. */
  override?: SessionMode;
  session?: SqlSession;
  run?: AbortController;
  /** The explorer let go of the file for the session and connects again when the session closes. */
  reconnect: boolean;
  /** A statement changed the catalog and the explorer has not reloaded it yet. */
  refreshPending: boolean;
  /** Where the script that ran last starts in the document. */
  base: number;
}

/** The SQL editor without the VS Code API: one session per document, opened at the first run. */
export class QueryEditors {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: QueryEditorChange) => void>();

  constructor(private readonly deps: QueryEditorDeps) {}

  onDidChange(listener: (change: QueryEditorChange) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  connectionOf(key: string): string | undefined {
    return this.entries.get(key)?.connectionId;
  }

  state(key: string): QueryEditorState | undefined {
    const entry = this.entries.get(key);
    const profile = entry && this.deps.profiles.get(entry.connectionId);
    if (!entry || !profile) return undefined;
    return {
      connectionId: entry.connectionId,
      connectionName: profile.name,
      mode: modeOf(entry, profile),
      switchable: hasReadOnlySessions(profile),
      running: entry.run !== undefined,
      sessionOpen: entry.session !== undefined,
      inTransaction: entry.session?.inTransaction ?? 'none',
    };
  }

  /** Binds the document to the connection and closes a session on another connection. */
  async associate(editor: EditorRef, connectionId: string): Promise<void> {
    const profile = this.deps.profiles.get(connectionId);
    if (!profile) {
      throw new AantjeError('INVALID_PROFILE', 'The connection does not exist (any more).');
    }
    const entry = this.entries.get(editor.key);
    if (entry?.connectionId === connectionId) {
      entry.name = editor.name;
      return;
    }
    if (entry?.run) {
      this.deps.ui.info('A query is running in this editor. Cancel it first.');
      return;
    }
    if (entry) await this.closeSession(entry);
    this.entries.set(editor.key, {
      connectionId,
      name: editor.name,
      signature: openingSignature(profile),
      reconnect: false,
      refreshPending: false,
      base: 0,
    });
    this.fire({ key: editor.key, association: true });
  }

  /** Runs the script on the document's connection (asked for first if missing); undefined when nothing ran. */
  async run(editor: EditorRef, script: { text: string; base: number }): Promise<RunSummary | undefined> {
    if (!this.entries.has(editor.key) && !(await this.choose(editor))) return undefined;
    const entry = this.entries.get(editor.key);
    const profile = entry && this.deps.profiles.get(entry.connectionId);
    if (!entry || !profile) return undefined;
    entry.name = editor.name;
    if (entry.run) {
      this.deps.ui.info('A query is already running in this editor.');
      return undefined;
    }
    return this.execute(editor.key, entry, profile, script);
  }

  /** Cancels the running statement and the ones after it. */
  cancel(key: string): void {
    this.entries.get(key)?.run?.abort();
  }

  /** Switches the session mode (the profile stays the default); the next run opens the new session. */
  async toggleMode(key: string): Promise<void> {
    const entry = this.entries.get(key);
    const profile = entry && this.deps.profiles.get(entry.connectionId);
    if (!entry || !profile) return;
    if (!hasReadOnlySessions(profile)) {
      this.deps.ui.info(
        `A session on the DuckDB + Quack connection "${profile.name}" has no read-only mode: the server decides what its token may do.`,
      );
      return;
    }
    if (entry.run) {
      this.deps.ui.info('A query is running in this editor. Cancel it first.');
      return;
    }
    entry.override = modeOf(entry, profile) === 'read-only' ? 'read-write' : 'read-only';
    await this.closeSession(entry);
    this.fire({ key, association: false });
  }

  /** Closes the session; the document stays associated and the next run opens a new one. */
  async closeSessionOf(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    await this.closeSession(entry);
    this.fire({ key, association: false });
  }

  async documentClosed(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    await this.closeSession(entry);
    this.fire({ key, association: true });
  }

  /** A deleted connection detaches its documents; an edited one closes its sessions. */
  async profilesChanged(): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      const profile = this.deps.profiles.get(entry.connectionId);
      if (!profile) {
        this.entries.delete(key);
        await this.closeSession(entry);
        this.fire({ key, association: true });
      } else if (openingSignature(profile) !== entry.signature) {
        entry.signature = openingSignature(profile);
        entry.override = undefined;
        await this.closeSession(entry);
        this.fire({ key, association: false });
      }
    }
  }

  /** Maps a range of the script that ran last to document offsets. */
  scriptRange(key: string, offset: number, length: number): { offset: number; length: number } | undefined {
    const entry = this.entries.get(key);
    return entry && { offset: entry.base + offset, length };
  }

  async dispose(): Promise<void> {
    this.listeners.clear();
    const entries = [...this.entries.values()];
    this.entries.clear();
    // The explorer goes down with the editors: nothing to give the file back to.
    for (const entry of entries) entry.reconnect = false;
    // Close all at once: a session that cannot be interrupted must not keep the others open.
    const results = await Promise.allSettled(entries.map((entry) => this.closeSession(entry)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason as unknown;
  }

  /**
   * The connection for an editor, for New Query, Run and Select Connection alike: none says how to add one, a single
   * one is taken without asking unless `askForOne` (an explicit Select Connection), more are offered in a picker.
   * Undefined when there is nothing to take or the picker was dismissed.
   */
  async pickConnection(askForOne = false): Promise<string | undefined> {
    const profiles = this.deps.profiles.list();
    if (profiles.length === 0) {
      this.deps.ui.info('There is no connection yet. Add a connection in the aantje view first.');
      return undefined;
    }
    return profiles.length === 1 && !askForOne ? profiles[0]?.id : this.deps.ui.pickConnection(profiles);
  }

  private async choose(editor: EditorRef): Promise<boolean> {
    // A run may write: it asks also when there is a single connection.
    const id = await this.pickConnection(true);
    if (id === undefined) return false;
    await this.associate(editor, id);
    return this.entries.has(editor.key);
  }

  private async execute(
    key: string,
    entry: Entry,
    profile: ConnectionProfile,
    script: { text: string; base: number },
  ): Promise<RunSummary> {
    const { results, ui } = this.deps;
    const now = (): number => (this.deps.now ?? Date.now)();
    const control = new AbortController();
    const target = { key, title: `${entry.name} · ${profile.name}` };
    const startedAt = now();
    let failed = false;
    let session: SqlSession | undefined;
    let statement = { type: '', sql: '' };

    entry.run = control;
    entry.base = script.base;
    // Whatever a port throws, the `finally` clears the run so the editor never stays "running".
    try {
      const forward = (event: SqlEvent): void => {
        failed ||= event.kind === 'error';
        results.event(target, event);
        this.fire({ key, association: false });
      };
      try {
        results.begin(target, { text: script.text, startedAt });
        results.reveal(target);
        this.fire({ key, association: false });
        await ui.withProgress(`Running SQL on ${profile.name}...`, async (cancel) => {
          cancel.addEventListener('abort', () => control.abort(), { once: true });
          if (cancel.aborted) control.abort();
          session = await this.sessionOf(entry, profile, control.signal);
          const options = {
            signal: control.signal,
            maxRows: this.deps.maxRows(),
            maxCells: MAX_RESULT_CELLS,
          };
          for await (const event of session.run(script.text, options)) {
            if (event.kind === 'start') {
              statement = { type: event.statementType, sql: event.sql };
            } else if (event.kind !== 'error') {
              // Inside a transaction the change becomes visible at COMMIT, which counts as a change itself.
              if (statement.type !== '' && session.inTransaction === 'none' && changesCatalog(statement)) {
                entry.refreshPending = true;
              }
              statement = { type: '', sql: '' };
            }
            forward(event);
          }
        });
      } catch (error) {
        forward({ kind: 'error', index: 0, message: userMessageOf(error) });
      }
      const inTransaction = session?.inTransaction ?? 'none';
      // Only a committed change sets the flag, so the explorer is refreshed even when the script ends with a BEGIN.
      if (entry.refreshPending) {
        entry.refreshPending = false;
        if (!holdsFileExclusively(profile, session?.mode ?? 'read-only')) this.refreshExplorer(profile.id);
      }
      const summary = {
        cancelled: control.signal.aborted,
        failed,
        elapsedMs: now() - startedAt,
        inTransaction,
      };
      results.end(target, summary);
      return summary;
    } finally {
      entry.run = undefined;
      this.fire({ key, association: false });
    }
  }

  private refreshExplorer(connectionId: string): void {
    if (this.deps.explorer.status(connectionId) === 'connected') this.deps.explorer.refresh(connectionId);
  }

  private async sessionOf(
    entry: Entry,
    profile: ConnectionProfile,
    signal: AbortSignal,
  ): Promise<SqlSession> {
    const mode = modeOf(entry, profile);
    if (entry.session) return entry.session;
    const { explorer, ui } = this.deps;
    // A writable session locks a DuckDB file exclusively, so the explorer must release it before the session attaches.
    const exclusive = holdsFileExclusively(profile, mode);
    const letGo = exclusive && explorer.status(profile.id) === 'connected';
    if (exclusive) await explorer.disconnect(profile.id);
    try {
      entry.session = await this.deps.openSession(profile, mode, signal);
    } catch (error) {
      if (letGo) explorer.connect(profile.id);
      throw error;
    }
    if (letGo) {
      entry.reconnect = true;
      ui.info(`Disconnected the explorer from ${profile.name} while the editor has it open for writing.`);
    }
    return entry.session;
  }

  private async closeSession(entry: Entry): Promise<void> {
    entry.run?.abort();
    const { session } = entry;
    if (!session) return;
    entry.session = undefined;
    const open = session.inTransaction !== 'none';
    await session.close();
    if (open) this.deps.ui.info(`Rolled back the open transaction of ${entry.name}`);
    if (entry.reconnect) {
      entry.reconnect = false;
      // A removed connection has no explorer node left to connect.
      if (this.deps.profiles.get(entry.connectionId)) this.deps.explorer.connect(entry.connectionId);
    }
  }

  private fire(change: QueryEditorChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

function modeOf(entry: Entry, profile: ConnectionProfile): SessionMode {
  if (!hasReadOnlySessions(profile)) return 'read-write';
  return entry.override ?? (profile.readOnly ? 'read-only' : 'read-write');
}

// The read-only mode exists to avoid the lock of a DuckDB file; a Quack server has none and enforces its own rights.
function hasReadOnlySessions(profile: ConnectionProfile): boolean {
  return profile.kind !== 'quack';
}

/** Whether the session locks the catalog file so that no one else, the explorer included, can read it. */
export function holdsFileExclusively(profile: ConnectionProfile, mode: SessionMode): boolean {
  return profile.kind === 'duckdb' && mode === 'read-write';
}

// Statement types that cannot change the catalog; any other successful statement makes the explorer reload.
const KEEPS_CATALOG = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'FROM',
  'TABLE',
  'EXPLAIN',
  'DESCRIBE',
  'SHOW',
  'SUMMARIZE',
  'PRAGMA',
  'SET',
  'RESET',
  'USE',
  'BEGIN',
  'START',
  'ROLLBACK',
  'ABORT',
  'LOAD',
  'INSTALL',
]);

// What makes `WITH` and `EXPLAIN ANALYZE` write. A mention inside a string is a harmless false alarm.
const WRITES = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|COPY)\b/i;
const EXPLAIN_ANALYZE = /^EXPLAIN\s*(\([^)]*\b)?ANALYZE\b/i;

/** Whether the statement may change the catalog; `WITH` and `EXPLAIN ANALYZE` are judged by their content. */
export function changesCatalog({ type, sql }: { readonly type: string; readonly sql: string }): boolean {
  if (type === 'WITH') return WRITES.test(sql);
  if (type === 'EXPLAIN') return EXPLAIN_ANALYZE.test(sql) && WRITES.test(sql);
  return !KEEPS_CATALOG.has(type);
}

/** The selection unless it is blank, else the whole document. */
export function scriptToRun(
  text: string,
  selection: { readonly start: number; readonly end: number },
): { text: string; base: number } {
  const selected = text.slice(selection.start, selection.end);
  return selected.trim() === '' ? { text, base: 0 } : { text: selected, base: selection.start };
}

/** The statement at the cursor; text between statements belongs to the previous one, a cursor before all picks the first. */
export function statementAt(
  text: string,
  tokens: readonly SqlToken[],
  offset: number,
): { text: string; base: number } | undefined {
  const found = statementSpans(tokens).map(({ tokens: span }) => ({
    start: span[0].start,
    end: (span.at(-1) ?? span[0]).end,
  }));
  const statement = found.findLast(({ start }) => start <= offset) ?? found[0];
  return statement && { text: text.slice(statement.start, statement.end), base: statement.start };
}

/** The status bar text of an associated editor, e.g. `$(database) Fixture · read/write`, plus the transaction state. */
export function queryStatusContent(state: {
  readonly connectionName: string;
  readonly mode: SessionMode;
  readonly inTransaction: TransactionState;
}): { text: string; tooltip: string } {
  const mode = state.mode === 'read-only' ? 'read-only' : 'read/write';
  const transaction = state.inTransaction === 'none' ? '' : ` · transaction ${state.inTransaction}`;
  const note =
    state.inTransaction === 'none'
      ? ''
      : ` A transaction is ${state.inTransaction}; closing the editor rolls it back.`;
  return {
    text: `$(database) ${state.connectionName} · ${mode}${transaction}`,
    tooltip: `The SQL session of this editor runs on ${state.connectionName} (${mode}).${note} Click for the session menu.`,
  };
}

type QueryMenuAction = 'select' | 'toggle' | 'cancel' | 'close';

/** The menu entries behind the editor's status bar item. */
export function queryMenuItems(
  state: Pick<QueryEditorState, 'mode' | 'switchable' | 'running' | 'sessionOpen'>,
): { label: string; action: QueryMenuAction }[] {
  return [
    { label: 'Select Connection...', action: 'select' as const },
    ...(state.switchable
      ? [
          {
            label:
              state.mode === 'read-only' ? 'Switch to a Read/Write Session' : 'Switch to a Read-only Session',
            action: 'toggle' as const,
          },
        ]
      : []),
    ...(state.running ? [{ label: 'Cancel Query', action: 'cancel' as const }] : []),
    ...(state.sessionOpen && !state.running ? [{ label: 'Close Session', action: 'close' as const }] : []),
  ];
}

/**
 * The completion catalog per connection; rebuilt when the explorer reconnects (a refresh does) or changes snapshot. A
 * catalog that is dropped aborts its reads of view columns.
 */
export function catalogCache(source: {
  reader(connectionId: string): CatalogReader | undefined;
  snapshot(connectionId: string): SnapshotId | undefined;
  /** How the catalog of the connection binds its views; without it, views offer no columns. */
  views?(connectionId: string, signal: AbortSignal): ViewColumnSource;
}): { of(connectionId: string): SqlCatalog | undefined; invalidate(): void } {
  const cache = new Map<
    string,
    { reader: CatalogReader; snapshot: SnapshotId; catalog: SqlCatalog; dropped: AbortController }
  >();
  const drop = (connectionId: string): void => {
    cache.get(connectionId)?.dropped.abort();
    cache.delete(connectionId);
  };
  return {
    of(connectionId) {
      const reader = source.reader(connectionId);
      const snapshot = source.snapshot(connectionId);
      if (!reader || snapshot === undefined) {
        drop(connectionId);
        return undefined;
      }
      const hit = cache.get(connectionId);
      if (hit?.reader === reader && hit.snapshot === snapshot) return hit.catalog;
      drop(connectionId);
      const dropped = new AbortController();
      const catalog = catalogOfReader(reader, snapshot, 'lake', source.views?.(connectionId, dropped.signal));
      cache.set(connectionId, { reader, snapshot, catalog, dropped });
      return catalog;
    },
    invalidate: () => {
      for (const connectionId of [...cache.keys()]) drop(connectionId);
    },
  };
}

/**
 * How completion binds the views of a connection: the explorer's path (`resolveViewColumns`, the view guard included)
 * once the user trusted the connection's views. It never asks; a failed read is logged and the view offers no columns.
 */
export function trustedViewColumns(deps: {
  readonly store: { get(id: string): ConnectionProfile | undefined };
  readonly trust: Pick<ViewTrustStore, 'isTrusted'>;
  readonly dataAccess: DataAccessFactory;
  readonly describe: Parameters<typeof resolveViewColumns>[0]['describe'];
  readonly log: Pick<Logger, 'warn'>;
}): (connectionId: string, signal: AbortSignal) => ViewColumnSource {
  const { store, trust, log } = deps;
  const resolve = resolveViewColumns({
    store,
    dataAccess: deps.dataAccess,
    describe: deps.describe,
    confirm: (profile) =>
      trust.isTrusted(profile)
        ? Promise.resolve()
        : Promise.reject(new AantjeError('ABORTED', `The views of "${profile.name}" are not trusted.`)),
  });
  return (connectionId, signal) => ({
    trusted: () => {
      const profile = store.get(connectionId);
      return profile !== undefined && trust.isTrusted(profile);
    },
    read: (schema, view, snapshot) => resolve(connectionId, schema, view, snapshot, signal),
    failed: (schema, view, error) => {
      if (isAborted(error)) return;
      log.warn(
        `Completion offers no columns of the view "${schema.name}.${view.name}": ${userMessageOf(error)}`,
      );
    },
  });
}
