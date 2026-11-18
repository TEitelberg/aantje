import { openingSignature } from '../connections/profile';
import type { ConnectionProfile } from '../connections/profile';
import { AantjeError, userMessageOf } from '../errors';
import type { GridColumn, GridValue } from '../data/types';
import { queryCancelled } from '../catalog/drivers/limits';
import { RunRecord } from './history';
import type { QueryHistory } from './history';
import {
  defaultsOf,
  findPlaceholders,
  initialValues,
  ParameterMemory,
  parseParameterHeader,
  runParameters,
  scriptParameters,
  usageProblem,
} from './parameters';
import type { RunParameters, ScriptParameter } from './parameters';
import { MAX_RESULT_CELLS } from './results';
import type { ResultsView, RunSummary } from './results';
import { DEFAULT_RUN_SETTINGS, runGuards } from './run-guards';
import type { CommitMessageStore, GuardUi, RunSettings } from './run-guards';
import type { SessionMode, SqlEvent, SqlSession, TransactionState } from './session';
import type { SqlToken } from './tokens';
import { RunTracker } from './run-tracker';

/** A script for a run: its text, where it starts in the document, and whether aantje built it (a CTE on its own). */
export interface RunScript {
  readonly text: string;
  readonly base: number;
  /** The text is not in the document: its positions lead nowhere, and it can be opened as a new query. */
  readonly built?: boolean;
  /** Its statements go into the Query History: Run Query, Run Statement and Execute; not Explain, Analysis, Statistics. */
  readonly record?: boolean;
  /** The `COPY` of Run to File: it writes a local file and changes no lake, so the run asks for no commit message. */
  readonly toFile?: boolean;
}

/** Runs SQL on the session without showing it; the rows of the last result set, or throws. */
export type QuietRun = (sql: string) => Promise<readonly (readonly GridValue[])[]>;

/** One result set of a statement that `QueryEditors.quiet` ran. */
export interface QuietResult {
  readonly columns: readonly GridColumn[];
  readonly rows: readonly (readonly GridValue[])[];
  /** More rows than `QUIET_MAX_ROWS` came back; the rest was not read. */
  readonly truncated: boolean;
}

/** Most rows that a statement of `QueryEditors.quiet` returns: its statements aggregate. */
export const QUIET_MAX_ROWS = 10_000;

/**
 * Statements around a script on the same session, hidden from the results; Statistics uses it for the profiler, Run to
 * File to bind the statement and to report the file it wrote.
 */
export interface RunAround {
  /** Before the script; when it fails, the failure is shown and the script does not run. */
  before(run: QuietRun): Promise<void>;
  /** After `before`: the text that runs in place of the script's text, which the results show at the start. */
  script?(run: QuietRun): Promise<string>;
  /** An event of the script as the results and the Query History get it. */
  event?(event: SqlEvent): SqlEvent;
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
  /** The whole text of the document, whose header declares the parameters; without it the script's own header counts. */
  text?(): string;
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

export interface QueryUi extends GuardUi {
  info(message: string): void;
  /** The id of the chosen connection, or undefined when the user cancels. */
  pickConnection(profiles: readonly ConnectionProfile[]): Promise<string | undefined>;
  /** Shows progress with a Cancel button that aborts the task's signal. */
  withProgress<T>(title: string, task: (cancel: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * The dialog of the parameters (`parameters.vscode.ts`): the values by name, or undefined when cancelled. Without it a
   * run asks for none, and DuckDB reports a placeholder that has no value.
   */
  askParameters?(
    parameters: readonly ScriptParameter[],
    initial: Readonly<Record<string, string>>,
  ): Promise<Record<string, string> | undefined>;
}

/**
 * A further connection that the session of one document attaches read-only, under `alias`: the source of Script as
 * Update of Data Compare. `dataPath` limits its storage secret.
 */
export interface SessionAttachment {
  readonly connectionId: string;
  readonly alias: string;
  readonly dataPath: string | null;
}

interface QueryEditorDeps {
  readonly profiles: {
    list(): readonly ConnectionProfile[];
    get(id: string): ConnectionProfile | undefined;
  };
  openSession(
    profile: ConnectionProfile,
    mode: SessionMode,
    signal: AbortSignal,
    attach?: SessionAttachment & { readonly profile: ConnectionProfile },
  ): Promise<SqlSession>;
  readonly results: ResultsView;
  readonly explorer: ExplorerPort;
  readonly ui: QueryUi;
  /** Read at every run, so a setting change applies to the next run. */
  maxRows(): number;
  now?(): number;
  /** Where the statements of a run with `record` go; it keeps the last commit messages of a connection too. */
  readonly history?: Pick<QueryHistory, 'record'> & CommitMessageStore;
  /** DuckDB's tokens of a text (the language service), for the placeholders of a run; without it a run asks for none. */
  readonly tokenize?: (text: string) => Promise<readonly SqlToken[]>;
  /** The settings of the questions before a change (`run-guards.ts`), read at every run; all on without it. */
  readonly runSettings?: () => RunSettings;
}

/** The values a run got from the dialog: those of the session, and the answers by name for the Query History. */
interface Asked {
  readonly parameters?: RunParameters;
  readonly answers?: Readonly<Record<string, string>>;
}

const NO_PARAMETERS: Asked = {};

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
  /** Statements that aantje runs on the session for itself (`quiet`); a run of the user cancels them. */
  quiet?: { readonly control: AbortController; readonly done: Promise<unknown> };
  /** The explorer let go of the file for the session and connects again when the session closes. */
  reconnect: boolean;
  /** Where the script that ran last starts in the document. */
  base: number;
  /** The script that ran last, and whether aantje built it. */
  last?: RunScript;
  /** Settings that a run changed and could not put back yet (an aborted transaction); tried after every run. */
  pending?: RunAround;
  /** A connection the session attaches as well, with its opening signature; a change of it closes the session. */
  attach?: SessionAttachment & { signature: string };
  /** "Run Anyway for This Session" of an UPDATE or DELETE without WHERE; the next session asks again. */
  writesConfirmed: { value: boolean };
}

/** The SQL editor without the VS Code API: one session per document, opened at the first run. */
export class QueryEditors {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: QueryEditorChange) => void>();
  /** The last values of the parameters per document. */
  private readonly memory = new ParameterMemory();

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
      running: entry.run !== undefined || entry.quiet !== undefined,
      sessionOpen: entry.session !== undefined,
      inTransaction: entry.session?.inTransaction ?? 'none',
    };
  }

  /**
   * Binds the document to the connection and closes a session on another connection; `attach` is a further connection
   * its session attaches read-only (a new document of Script as Update).
   */
  async associate(editor: EditorRef, connectionId: string, attach?: SessionAttachment): Promise<void> {
    const profile = this.deps.profiles.get(connectionId);
    if (!profile) {
      throw new AantjeError('INVALID_PROFILE', 'The connection does not exist (any more).');
    }
    const attached = attach && this.deps.profiles.get(attach.connectionId);
    if (attach && !attached) {
      throw new AantjeError('INVALID_PROFILE', 'The connection to attach does not exist (any more).');
    }
    const entry = this.entries.get(editor.key);
    if (entry?.connectionId === connectionId && attach === undefined) {
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
      writesConfirmed: { value: false },
      ...(attach && attached ? { attach: { ...attach, signature: openingSignature(attached) } } : {}),
    });
    this.fire({ key: editor.key, association: true });
  }

  /**
   * Runs the script on the document's connection (asked for first if missing), after asking for the values of its
   * placeholders; undefined when nothing ran.
   */
  async run(editor: EditorRef, script: RunScript, around?: RunAround): Promise<RunSummary | undefined> {
    if (!this.entries.has(editor.key) && !(await this.choose(editor))) return undefined;
    const entry = this.entries.get(editor.key);
    if (!entry || this.refusedWhileRunning(entry)) return undefined;
    // Without the dialog the run starts at once.
    const asked =
      this.deps.tokenize && this.deps.ui.askParameters
        ? await this.askParameters(editor, script.text)
        : NO_PARAMETERS;
    // The dialog takes time: the document may have lost its connection, or started a run, meanwhile.
    const profile = this.deps.profiles.get(entry.connectionId);
    if (!asked || !profile || this.entries.get(editor.key) !== entry || this.refusedWhileRunning(entry)) {
      return undefined;
    }
    // What aantje runs for itself (a summary of the columns) gives way to the user's run.
    if (entry.quiet) await stopQuiet(entry);
    if (this.entries.get(editor.key) !== entry || this.refusedWhileRunning(entry)) {
      return undefined;
    }
    entry.name = editor.name;
    return this.execute(editor.key, entry, profile, script, around, asked);
  }

  /**
   * Set Parameters...: asks for the values of the placeholders of the whole document and keeps them for its next runs,
   * without a run. False when the document has none or the dialog was cancelled.
   */
  async setParameters(editor: EditorRef): Promise<boolean> {
    const text = editor.text?.() ?? '';
    const asked = await this.askParameters(editor, text);
    if (asked === NO_PARAMETERS) {
      this.deps.ui.info('This document has no parameters: write $name for a value or {{name}} for text.');
    }
    return asked !== undefined && asked !== NO_PARAMETERS;
  }

  private refusedWhileRunning(entry: Entry): boolean {
    if (entry.run) this.deps.ui.info('A query is already running in this editor.');
    return entry.run !== undefined;
  }

  /**
   * The values of the placeholders of a text, asked for in the dialog and remembered for the document. `NO_PARAMETERS`
   * without placeholders (or without the dialog); undefined when the dialog was cancelled or a value cannot be used.
   */
  private async askParameters(editor: EditorRef, text: string): Promise<Asked | undefined> {
    const { tokenize, ui } = this.deps;
    // Without tokens (no language service) the run goes ahead, and DuckDB names a placeholder without a value.
    const tokens = tokenize && ui.askParameters && (await tokenize(text).catch(() => undefined));
    const placeholders = tokens ? findPlaceholders(text, tokens) : [];
    if (!tokenize || !ui.askParameters || placeholders.length === 0) return NO_PARAMETERS;
    const document = editor.text?.() ?? text;
    const header = parseParameterHeader(document);
    const [skipped] = header.problems;
    if (skipped !== undefined) ui.info(`A parameter line of the header is skipped: ${skipped}.`);
    // The inline defaults of the whole document count, also when only some of its statements run.
    const all = document === text ? tokens : await tokenize(document).catch(() => undefined);
    const defaults = all ? findPlaceholders(document, all) : placeholders;
    const parameters = scriptParameters(header.declarations, placeholders, defaults);
    const unusable = parameters.map(usageProblem).find((problem) => problem !== undefined);
    if (unusable !== undefined) {
      ui.info(unusable);
      return undefined;
    }
    const answers = await ui.askParameters(
      parameters,
      initialValues(parameters, this.memory.get(editor.key), this.memory.defaults(editor.key)),
    );
    if (!answers) return undefined;
    this.memory.remember(editor.key, answers, defaultsOf(parameters));
    const checked = runParameters(parameters, answers);
    if ('problem' in checked) {
      ui.info(checked.problem);
      return undefined;
    }
    return { parameters: checked.parameters, answers };
  }

  /**
   * Runs statements of aantje on the session of the editor, hidden from the results and the Query History: the summary
   * of the columns, Aggregate in DuckDB, the count before a Markdown file. `work` gets a function that runs one statement
   * and returns its result set (at most `QUIET_MAX_ROWS` rows). It opens the session when none is open, refuses while a
   * run of the editor is active, and gives way to a later call or run, which cancels it. `progress` shows a notification
   * with Cancel. Throws `ABORTED` when cancelled, `QUERY_FAILED` with the session's message when a statement fails.
   */
  async quiet<T>(
    key: string,
    work: (run: (sql: string) => Promise<QuietResult>) => Promise<T>,
    options: { readonly signal?: AbortSignal; readonly progress?: string } = {},
  ): Promise<T> {
    const entry = this.entries.get(key);
    const profile = entry && this.deps.profiles.get(entry.connectionId);
    if (!entry || !profile) {
      throw new AantjeError('QUERY_FAILED', 'This editor has no connection (any more). Run the query again.');
    }
    await stopQuiet(entry);
    if (entry.run) {
      throw new AantjeError(
        'QUERY_FAILED',
        'A query is running in this editor. Wait for it, then try again.',
      );
    }
    const control = new AbortController();
    const outer = options.signal;
    const abort = (): void => control.abort();
    outer?.addEventListener('abort', abort, { once: true });
    if (outer?.aborted) abort();
    const task = async (cancel?: AbortSignal): Promise<T> => {
      cancel?.addEventListener('abort', abort, { once: true });
      if (cancel?.aborted) abort();
      const session = await this.sessionOf(entry, profile, control.signal);
      return work(async (sql) => {
        if (control.signal.aborted) throw queryCancelled();
        let result: QuietResult | undefined;
        for await (const event of session.run(sql, { signal: control.signal, maxRows: QUIET_MAX_ROWS })) {
          if (event.kind === 'error') {
            throw control.signal.aborted ? queryCancelled() : new AantjeError('QUERY_FAILED', event.message);
          }
          if (event.kind === 'resultSet') {
            result = { columns: event.columns, rows: event.rows, truncated: event.truncated };
          }
        }
        return result ?? { columns: [], rows: [], truncated: false };
      });
    };
    const done = options.progress === undefined ? task() : this.deps.ui.withProgress(options.progress, task);
    entry.quiet = { control, done: done.catch(() => undefined) };
    this.fire({ key, association: false });
    try {
      return await done;
    } finally {
      outer?.removeEventListener('abort', abort);
      if (entry.quiet?.control === control) entry.quiet = undefined;
      this.fire({ key, association: false });
    }
  }

  /** Lets the user choose the connection of an editor that has none; false when it still has none. */
  async ensureConnection(editor: EditorRef): Promise<boolean> {
    return this.entries.has(editor.key) || (await this.choose(editor));
  }

  /** The script that ran last in the editor, for Open as New Query of a built statement. */
  lastScript(key: string): RunScript | undefined {
    return this.entries.get(key)?.last;
  }

  /** Cancels the running statement and the ones after it. */
  cancel(key: string): void {
    const entry = this.entries.get(key);
    entry?.run?.abort();
    entry?.quiet?.control.abort();
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
    this.memory.forget(key);
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
      } else if (entry.attach) {
        // The attached connection was edited or removed: the next run opens the session again, or says it is gone.
        const attached = this.deps.profiles.get(entry.attach.connectionId);
        if (!attached || openingSignature(attached) !== entry.attach.signature) {
          if (attached) entry.attach.signature = openingSignature(attached);
          await this.closeSession(entry);
          this.fire({ key, association: false });
        }
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
    asked: Asked,
  ): Promise<RunSummary> {
    const { results, ui } = this.deps;
    const now = (): number => this.deps.now?.() ?? Date.now();
    const run = new RunTracker({
      target: { key, title: `${entry.name} · ${profile.name}` },
      results,
      now,
      record: script.record && this.deps.history ? new RunRecord(script.text, now, asked.answers) : undefined,
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
          this.runInSession({ entry, profile, script, around, run, parameters: asked.parameters }, cancel),
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
    { entry, profile, script, around, run, parameters }: RunInSession,
    cancel: AbortSignal,
  ): Promise<void> {
    const { control } = run;
    cancel.addEventListener('abort', () => control.abort(), { once: true });
    if (cancel.aborted) control.abort();
    const session = await this.sessionOf(entry, profile, control.signal);
    run.session = session;
    const options = {
      signal: control.signal,
      maxRows: this.deps.maxRows(),
      maxCells: MAX_RESULT_CELLS,
      ...(parameters && { parameters }),
      ...runGuards({
        ui: this.deps.ui,
        settings: this.deps.runSettings?.() ?? DEFAULT_RUN_SETTINGS,
        session,
        control,
        confirmed: entry.writesConfirmed,
        commits: !script.toFile,
        profile,
        messages: this.deps.history,
      }),
    };
    // The statements around the script (Run to File binds its query) see the same values.
    const quiet = quietRun(session, parameters);
    try {
      await around?.before(quiet);
      const text = (await around?.script?.(quiet)) ?? script.text;
      for await (const event of session.run(text, options))
        run.statementEvent(around?.event?.(event) ?? event);
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
    const attached = entry.attach && this.deps.profiles.get(entry.attach.connectionId);
    if (entry.attach && !attached) {
      throw new AantjeError(
        'INVALID_PROFILE',
        'The connection that this document reads as its source was removed, so its session cannot attach it.',
      );
    }
    try {
      entry.session = await this.deps.openSession(
        profile,
        mode,
        signal,
        entry.attach && attached ? { ...entry.attach, profile: attached } : undefined,
      );
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
    entry.quiet?.control.abort();
    // A closed session takes its settings with it; only the temporary files are left to delete.
    const { pending } = entry;
    entry.pending = undefined;
    await pending?.dispose();
    const { session } = entry;
    if (!session) return;
    entry.session = undefined;
    entry.writesConfirmed.value = false;
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
  readonly parameters: RunParameters | undefined;
}

/** Cancels what aantje runs on the session for itself and waits until it stopped, also for one that started meanwhile. */
async function stopQuiet(entry: Entry): Promise<void> {
  while (entry.quiet) {
    const { quiet } = entry;
    quiet.control.abort();
    await quiet.done;
    if (entry.quiet === quiet) entry.quiet = undefined;
  }
}

/**
 * Runs SQL on the session without a signal (so a cancel of the script cannot stop it) and without showing it, with the
 * values of the run's parameters.
 */
function quietRun(session: SqlSession, parameters?: RunParameters): QuietRun {
  return async (sql) => {
    let rows: readonly (readonly GridValue[])[] = [];
    for await (const event of session.run(sql, parameters && { parameters })) {
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
