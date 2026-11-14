import { openingSignature } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import { AantjeError, userMessageOf } from '../errors';
import type { GridValue } from '../data/types';
import { RunRecord } from './history';
import type { QueryHistory } from './history';
import { MAX_RESULT_CELLS } from './results';
import type { ResultsTarget, ResultsView, RunSummary } from './results';
import type { SessionMode, SqlEvent, SqlSession, TransactionState } from './session';

/** A script for a run: its text, where it starts in the document, and whether aantje built it (a CTE on its own). */
export interface RunScript {
  readonly text: string;
  readonly base: number;
  /** The text is not in the document: its positions lead nowhere, and it can be opened as a new query. */
  readonly built?: boolean;
  /** Its statements go into the Query History: Run Query, Run Statement and Execute; not Explain, Analysis, Statistics. */
  readonly record?: boolean;
}

/** Runs SQL on the session without showing it; the rows of the last result set, or throws. */
export type QuietRun = (sql: string) => Promise<readonly (readonly GridValue[])[]>;

/** Statements around a script on the same session, hidden from the results; Statistics uses it for the profiler. */
export interface RunAround {
  /** Before the script; when it fails, the failure is shown and the script does not run. */
  before(run: QuietRun): Promise<void>;
  /** Puts back what `before` changed, also after a failure or a cancel; false when the session refused it. */
  restore(run: QuietRun): Promise<boolean>;
  /** What to show after the script's own events. */
  report(): Promise<readonly SqlEvent[]>;
  /** Once restored, or when the session closes. */
  dispose(): Promise<void>;
}

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
  /** Where the statements of a run with `record` go. */
  readonly history?: Pick<QueryHistory, 'record'>;
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
  /** Where the script that ran last starts in the document. */
  base: number;
  /** The script that ran last, and whether aantje built it. */
  last?: RunScript;
  /** Settings that a run changed and could not put back yet (an aborted transaction); tried after every run. */
  pending?: RunAround;
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
      base: 0,
    });
    this.fire({ key: editor.key, association: true });
  }

  /** Runs the script on the document's connection (asked for first if missing); undefined when nothing ran. */
  async run(editor: EditorRef, script: RunScript, around?: RunAround): Promise<RunSummary | undefined> {
    if (!this.entries.has(editor.key) && !(await this.choose(editor))) return undefined;
    const entry = this.entries.get(editor.key);
    const profile = entry && this.deps.profiles.get(entry.connectionId);
    if (!entry || !profile) return undefined;
    entry.name = editor.name;
    if (entry.run) {
      this.deps.ui.info('A query is already running in this editor.');
      return undefined;
    }
    return this.execute(editor.key, entry, profile, script, around);
  }

  /** The script that ran last in the editor, for Open as New Query of a built statement. */
  lastScript(key: string): RunScript | undefined {
    return this.entries.get(key)?.last;
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

  /** Closes the sessions of a connection, whose next run opens a new one: new sign-in values of its storage apply then. */
  async closeSessionsOf(connectionId: string): Promise<void> {
    for (const [key, entry] of [...this.entries]) {
      if (entry.connectionId === connectionId) {
        await this.closeSession(entry);
        this.fire({ key, association: false });
      }
    }
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

  /** Maps a range of the script that ran last to document offsets; undefined for a script that aantje built. */
  scriptRange(key: string, offset: number, length: number): { offset: number; length: number } | undefined {
    const entry = this.entries.get(key);
    return entry && !entry.last?.built ? { offset: entry.base + offset, length } : undefined;
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
    script: RunScript,
    around: RunAround | undefined,
  ): Promise<RunSummary> {
    const { results, ui } = this.deps;
    const now = (): number => (this.deps.now ?? Date.now)();
    const run = new RunTracker({
      target: { key, title: `${entry.name} · ${profile.name}` },
      results,
      now,
      record: script.record && this.deps.history ? new RunRecord(script.text, now) : undefined,
      changed: () => this.fire({ key, association: false }),
    });
    entry.run = run.control;
    entry.base = script.base;
    entry.last = script;
    // Whatever a port throws, the `finally` clears the run so the editor never stays "running".
    try {
      try {
        results.begin(run.target, {
          text: script.text,
          startedAt: run.startedAt,
          ...(script.built ? { built: true } : {}),
        });
        results.reveal(run.target);
        this.fire({ key, association: false });
        await ui.withProgress(`Running SQL on ${profile.name}...`, (cancel) =>
          this.runInSession({ entry, profile, script, around, run }, cancel),
        );
      } catch (error) {
        run.forward({ kind: 'error', index: 0, message: userMessageOf(error) });
      }
      return this.finishRun(profile, run);
    } finally {
      entry.run = undefined;
      this.fire({ key, association: false });
    }
  }

  // Opens or reuses the session and runs the script with the statements around it; their settings always go back.
  private async runInSession(
    { entry, profile, script, around, run }: RunInSession,
    cancel: AbortSignal,
  ): Promise<void> {
    const { control } = run;
    cancel.addEventListener('abort', () => control.abort(), { once: true });
    if (cancel.aborted) control.abort();
    const session = await this.sessionOf(entry, profile, control.signal);
    run.session = session;
    const options = { signal: control.signal, maxRows: this.deps.maxRows(), maxCells: MAX_RESULT_CELLS };
    const quiet = quietRun(session);
    try {
      await around?.before(quiet);
      for await (const event of session.run(script.text, options)) run.statementEvent(event);
      for (const event of (await around?.report()) ?? []) run.forward(event);
    } finally {
      // Settings go back even after a failure or a cancel; an earlier run's leftovers get another try.
      await this.restore(entry, quiet, around);
    }
  }

  // After the run, ended or not: its statements into the history, the explorer reloaded, the summary shown.
  private finishRun(profile: ConnectionProfile, run: RunTracker): RunSummary {
    const { session, control } = run;
    if (run.record) {
      const mask = (text: string): string => session?.mask(text) ?? text;
      void this.deps.history?.record(profile.id, run.record.finish(control.signal.aborted), mask);
    }
    // Only a committed change counts, so the explorer is refreshed even when the script ends with a BEGIN.
    if (run.catalogChanged && !holdsFileExclusively(profile, session?.mode ?? 'read-only')) {
      this.refreshExplorer(profile.id);
    }
    const summary = {
      cancelled: control.signal.aborted,
      failed: run.failed,
      elapsedMs: run.elapsed(),
      inTransaction: session?.inTransaction ?? 'none',
    };
    this.deps.results.end(run.target, summary);
    return summary;
  }

  private async restore(entry: Entry, quiet: QuietRun, around: RunAround | undefined): Promise<void> {
    for (const changed of new Set([entry.pending, around])) {
      if (!changed) continue;
      if (await changed.restore(quiet)) {
        if (entry.pending === changed) entry.pending = undefined;
        await changed.dispose();
      } else if (entry.pending !== changed) {
        entry.pending = changed;
        this.deps.ui.info(
          'The session refused to restore its profiler settings, as in an aborted transaction. They are restored after the next run, e.g. a ROLLBACK.',
        );
      }
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
    // A closed session takes its settings with it; only the temporary files are left to delete.
    const { pending } = entry;
    entry.pending = undefined;
    await pending?.dispose();
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

interface RunInSession {
  readonly entry: Entry;
  readonly profile: ConnectionProfile;
  readonly script: RunScript;
  readonly around: RunAround | undefined;
  readonly run: RunTracker;
}

/** One run: it forwards the events to the results and the history, and notes a failure and a committed change. */
class RunTracker {
  readonly control = new AbortController();
  readonly target: ResultsTarget;
  readonly record: RunRecord | undefined;
  readonly startedAt: number;
  /** The session of the run, once it is open. */
  session: SqlSession | undefined;
  failed = false;
  /** A statement that may change the catalog completed outside a transaction, or a COMMIT did. */
  catalogChanged = false;
  // The statement that started last may change the catalog.
  private changing = false;

  constructor(
    private readonly ports: {
      readonly target: ResultsTarget;
      readonly results: ResultsView;
      readonly now: () => number;
      readonly record: RunRecord | undefined;
      /** The editor's state changed: a failure or a transaction may show. */
      readonly changed: () => void;
    },
  ) {
    this.target = ports.target;
    this.record = ports.record;
    this.startedAt = ports.now();
  }

  elapsed(): number {
    return this.ports.now() - this.startedAt;
  }

  forward(event: SqlEvent): void {
    this.failed ||= event.kind === 'error';
    this.record?.event(event, this.control.signal.aborted);
    this.ports.results.event(this.target, event);
    this.ports.changed();
  }

  /** An event of the script: a statement that ends well notes its change, unless a transaction holds it back. */
  statementEvent(event: SqlEvent): void {
    if (event.kind === 'start') {
      this.changing = event.changesCatalog;
    } else if (event.kind !== 'error') {
      // Inside a transaction the change becomes visible at COMMIT, which counts as a change itself.
      if (this.changing && this.session?.inTransaction === 'none') this.catalogChanged = true;
      this.changing = false;
    }
    this.forward(event);
  }
}

/** Runs SQL on the session without a signal (so a cancel of the script cannot stop it) and without showing it. */
function quietRun(session: SqlSession): QuietRun {
  return async (sql) => {
    let rows: readonly (readonly GridValue[])[] = [];
    for await (const event of session.run(sql)) {
      if (event.kind === 'error') throw new AantjeError('QUERY_FAILED', event.message);
      if (event.kind === 'resultSet') rows = event.rows;
    }
    return rows;
  };
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
