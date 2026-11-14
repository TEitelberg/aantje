import { stat } from 'node:fs/promises';
import type * as Duckdb from '@duckdb/node-api';
import { quoteIdentifier } from '../catalog/ddl';
import {
  dataPathQuery,
  firstSchemaQuery,
  postgresSecretStatement,
  setupStatements,
  USE_LAKE,
} from '../data/attach';
import { MISSING_LOCAL_FILE, MISSING_OBJECT, secretsOf } from '../data/errors';
import type { Phase } from '../data/errors';
import { kindOf, toGridValue } from '../data/grid-values';
import { closeAll, openLakeSession } from '../data/open-lake';
import { startRenewal } from '../data/renewal';
import { DEFAULT_MAX_ROWS } from '../data/settings';
import type { DataAccess, GridColumn, GridValue } from '../data/types';
import { interruptRepeatedly, loadEngine } from '../duckdb/engine';
import type { Engine } from '../duckdb/engine';
import { extensionFailure, firstLine, scrubbed } from '../duckdb/messages';
import { AantjeError, messageOf } from '../errors';
import { maskSecrets } from '../secrets';
import { storageSecretStatement } from '../storage/statements';
import { storageContextOf } from '../storage/diagnose';
import { translateSqlError } from './errors';
import type { SessionMode, SqlErrorContext } from './errors';
import { serializeSql, tokenRows } from './parser-engine';
import { caretRange, splitScript, statementSpans, withoutBom } from './script';
import type { Range, ScriptStatement } from './script';
import { statementKind } from './statement-kind';
import { syntaxErrorsOf } from './syntax';
import type { Diagnostic } from './syntax';

export type { SessionMode } from './errors';

export type TransactionState = 'none' | 'open' | 'aborted';

export interface SqlSessionOptions {
  readonly access: DataAccess;
  readonly mode: SessionMode;
  /** Most rows a result keeps, default 10 000. */
  readonly maxRows?: number;
  /** Cancels opening the session (the first open downloads the extensions). */
  readonly signal?: AbortSignal;
}

export interface RunOptions {
  readonly signal?: AbortSignal;
  readonly maxRows?: number;
  /** Most cells all result sets of the script may hold, unlimited by default; the set that overflows is cut and `truncated`. */
  readonly maxCells?: number;
}

/** Positions are UTF-16 offsets into the script passed to `run`. */
export type SqlEvent =
  | {
      readonly kind: 'start';
      readonly index: number;
      /** The first word in upper case, e.g. `SELECT`, `WITH`, `INSERT`. */
      readonly statementType: string;
      readonly sql: string;
      readonly offset: number;
      /** The statement may change the catalog, judged by its tokens (`statement-kind.ts`). */
      readonly changesCatalog: boolean;
    }
  | {
      readonly kind: 'resultSet';
      readonly index: number;
      readonly columns: readonly GridColumn[];
      readonly rows: readonly (readonly GridValue[])[];
      /** The result has more rows than `maxRows`; the rest was not read. */
      readonly truncated: boolean;
      readonly elapsedMs: number;
    }
  | {
      readonly kind: 'message';
      readonly index: number;
      readonly text: string;
      readonly rowsAffected?: number;
      readonly elapsedMs: number;
    }
  | { readonly kind: 'error'; readonly index: number; readonly message: string; readonly position?: Range }
  /** The profile of Statistics as DuckDB's profiler wrote it (JSON); the results show it as a table, as charts and as text. */
  | { readonly kind: 'profile'; readonly index: number; readonly json: string };

/**
 * A long-lived DuckDB with the DuckLake attached; one session per editor. It runs any SQL its credentials allow;
 * the only guard is `mode: 'read-only'`, which attaches the lake `READ_ONLY` (a Quack catalog has no such mode: the
 * server decides what its token may do).
 * A writable session on a DuckDB-file catalog locks the file: the Explorer and other sessions fail until `close()`.
 */
export interface SqlSession {
  readonly mode: SessionMode;
  /** Follows the statements; after a failure inside a transaction it asks the engine. */
  readonly inTransaction: TransactionState;
  /**
   * Runs the statements in order and reports each as `start`, then `resultSet` or `message`; an `error` stops the script.
   * A script that does not parse runs nothing. A `run` while another is active, or on a closed session, throws.
   */
  run(script: string, options?: RunOptions): AsyncIterable<SqlEvent>;
  /** Interrupts the active statement and skips the rest; does nothing when idle. */
  cancel(): void;
  /** Rolls back an open transaction, then closes the connections and the instance. */
  close(): Promise<void>;
  /** The text with the secrets of the connection masked, as in the session's own messages. */
  mask(text: string): string;
}

interface Limits {
  readonly maxRows: number;
  readonly maxCells: number;
}

/** A statement of a script and whether it may change the catalog. */
interface Planned extends ScriptStatement {
  readonly changesCatalog: boolean;
}

const STARTS_TRANSACTION = new Set(['BEGIN', 'START']);
const ENDS_TRANSACTION = new Set(['COMMIT', 'END', 'ROLLBACK', 'ABORT']);

/**
 * Opens the in-memory DuckDB, loads the extensions, attaches the lake and applies the session settings.
 * `access.timeoutMs` bounds the attach, not statements; `access.snapshot` is ignored: use `AT (VERSION => n)`.
 */
export async function openSqlSession(options: SqlSessionOptions): Promise<SqlSession> {
  const { access, mode, signal } = options;
  const { profile } = access;
  // A writable ATTACH of a missing file would create a new, empty catalog there.
  if ((profile.kind === 'sqlite' || profile.kind === 'duckdb') && !(await exists(profile.path))) {
    throw new AantjeError(
      'FILE_NOT_FOUND',
      `The catalog file "${profile.path}" does not exist. aantje does not create catalogs.`,
    );
  }
  const engine = await loadEngine();
  return openLakeSession({
    engine,
    access,
    signal,
    setup: setupStatements(access, { readOnly: mode === 'read-only' }),
    run: (connection, sql) => (sql === USE_LAKE ? useLake(connection) : connection.run(sql)),
    cancelledText: 'Opening the SQL session was cancelled.',
    activity: 'Opening the DuckLake',
    // An immediate reconnect must not fail with "being used by another process".
    lockingFile: profile.kind === 'duckdb',
    use: ({ instance, connection, parser, temporary }) =>
      new LiveSession({
        engine,
        access,
        mode,
        maxRows: options.maxRows ?? DEFAULT_MAX_ROWS,
        instance,
        connection,
        parser,
        temporary,
      }),
    fail: (cause, phase) => openError(cause, phase, access, mode),
  });
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// `USE lake` fails for a lake without the schema `main`; its first schema becomes the default then.
async function useLake(connection: Duckdb.DuckDBConnection): Promise<void> {
  try {
    await connection.run(USE_LAKE);
  } catch (error) {
    const first = (await connection.runAndReadAll(firstSchemaQuery())).getRowsJson()[0]?.[0];
    if (typeof first !== 'string') throw error;
    await connection.run(`${USE_LAKE}.${quoteIdentifier(first)}`);
  }
}

function openError(cause: unknown, phase: Phase, access: DataAccess, mode: SessionMode): AantjeError {
  const { text: raw, line } = scrubbed(cause, secretsOf(access));
  const safeCause = new Error(line);
  if (phase === 'extension') {
    return extensionFailure('A DuckDB extension that aantje needs for the SQL editor', line);
  }
  const { code, message } = translateSqlError(raw, {
    mode,
    kind: access.profile.kind,
    storage: storageContextOf(access.storage),
  });
  // A rule has a code of its own; for the rest, the attach failed.
  return new AantjeError(
    code === 'QUERY_FAILED' ? 'CONNECTION_FAILED' : code,
    `Cannot open the SQL session: ${message}`,
    {
      cause: safeCause,
    },
  );
}

interface LiveSessionOptions {
  readonly engine: Engine;
  readonly access: DataAccess;
  readonly mode: SessionMode;
  readonly maxRows: number;
  readonly instance: Duckdb.DuckDBInstance;
  readonly connection: Duckdb.DuckDBConnection;
  /** A second connection that parses while `connection` runs a statement. */
  readonly parser: Duckdb.DuckDBConnection;
  readonly temporary: { readonly temp_directory: string };
}

class LiveSession implements SqlSession {
  inTransaction: TransactionState = 'none';
  private scriptActive = false;
  // The running statement plus its transaction check; never rejects.
  private executing: Promise<unknown> = Promise.resolve();
  private cancelRequested = false;
  private statementRunning = false;
  private stopInterrupt: (() => void) | undefined;
  private closing: Promise<void> | undefined;
  private azureRefresh: NodeJS.Timeout | undefined;
  private readonly context: SqlErrorContext;
  private readonly secrets: string[];
  readonly mode: SessionMode;
  private readonly engine: Engine;
  private readonly maxRows: number;
  private readonly instance: Duckdb.DuckDBInstance;
  private readonly connection: Duckdb.DuckDBConnection;
  private readonly parser: Duckdb.DuckDBConnection;
  private readonly temporary: { readonly temp_directory: string };

  constructor(options: LiveSessionOptions) {
    ({
      engine: this.engine,
      mode: this.mode,
      maxRows: this.maxRows,
      instance: this.instance,
      connection: this.connection,
      parser: this.parser,
      temporary: this.temporary,
    } = options);
    this.context = {
      mode: options.mode,
      kind: options.access.profile.kind,
      storage: storageContextOf(options.access.storage),
    };
    this.secrets = secretsOf(options.access);
    this.keepAzureTokenFresh(options.access);
  }

  async *run(script: string, options: RunOptions = {}): AsyncGenerator<SqlEvent> {
    if (this.closing) throw new AantjeError('QUERY_FAILED', 'The SQL session is closed.');
    if (this.scriptActive) {
      throw new AantjeError(
        'QUERY_FAILED',
        'Another script is still running in this session. Wait for it or cancel it.',
      );
    }
    this.scriptActive = true;
    this.cancelRequested = false;
    const abort = (): void => this.cancel();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      yield* this.execute(
        withoutBom(script),
        options.maxRows ?? this.maxRows,
        options.maxCells ?? Number.POSITIVE_INFINITY,
      );
    } finally {
      options.signal?.removeEventListener('abort', abort);
      this.stopInterrupt?.();
      this.stopInterrupt = undefined;
      this.scriptActive = false;
    }
  }

  cancel(): void {
    if (!this.scriptActive) return;
    this.cancelRequested = true;
    if (this.statementRunning) this.stopInterrupt ??= interruptRepeatedly(this.connection);
  }

  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  mask(text: string): string {
    return maskSecrets(text, this.secrets);
  }

  // The azure extension never renews an access token, so the secret is replaced from time to time; so is the PostgreSQL
  // secret of an Entra login. The second connection does it, because the first may be running a statement; secrets
  // belong to the instance, not to a connection.
  private keepAzureTokenFresh(access: DataAccess): void {
    const renewals = tokenRenewals(access, this.secrets, (sql) => this.parser.run(sql));
    if (renewals.length === 0) return;
    this.azureRefresh = startRenewal(renewals, (error) => {
      access.log?.warn(`A token of the SQL session could not be renewed: ${this.scrubbed(error)}`);
    });
  }

  private async shutDown(): Promise<void> {
    clearInterval(this.azureRefresh);
    this.cancel();
    await this.executing;
    try {
      if (this.inTransaction !== 'none') {
        await this.connection.run('ROLLBACK');
      }
    } catch {
      // The engine drops an open transaction when its connection closes.
    } finally {
      this.inTransaction = 'none';
      closeAll([this.parser, this.connection, this.instance], this.temporary);
    }
  }

  private async *execute(script: string, maxRows: number, maxCells: number): AsyncGenerator<SqlEvent> {
    let cellsLeft = maxCells;
    let statements: Planned[];
    try {
      statements = await this.split(script);
    } catch (cause) {
      // The position of the syntax error is a bonus; the message of the split failure is shown either way.
      const [diagnostic] = await syntaxErrors(this.parser, script).catch(() => []);
      const message = firstLine(this.scrubbed(cause)).replace(/^Failed to extract statements: /, '');
      yield {
        kind: 'error',
        index: 0,
        message: `${sentence(message)} No statement was run.`,
        ...(diagnostic ? { position: { offset: diagnostic.offset, length: diagnostic.length } } : {}),
      };
      return;
    }
    if (statements.length === 0) {
      yield {
        kind: 'message',
        index: 0,
        text: 'There is nothing to run: the script is empty or has only comments.',
        elapsedMs: 0,
      };
      return;
    }
    for (const [index, statement] of statements.entries()) {
      const rest = statements.length - index - 1;
      yield {
        kind: 'start',
        index,
        statementType: statement.keyword,
        sql: statement.sql,
        offset: statement.offset,
        changesCatalog: statement.changesCatalog,
      };
      if (this.cancelRequested) {
        yield { kind: 'error', index, message: withRest('The run was cancelled.', rest + 1) };
        return;
      }
      const step = this.step(statement, index, { maxRows, maxCells: cellsLeft }, rest);
      this.executing = step;
      const { event, failed } = await step;
      if (event.kind === 'resultSet') cellsLeft -= event.rows.length * event.columns.length;
      yield event;
      if (failed) return;
    }
  }

  private async step(
    statement: ScriptStatement,
    index: number,
    limits: Limits,
    rest: number,
  ): Promise<{ event: SqlEvent; failed: boolean }> {
    let event: SqlEvent;
    let failed = false;
    this.statementRunning = true;
    try {
      event = await this.runStatement(statement, index, limits, performance.now());
    } catch (cause) {
      failed = true;
      event = await this.failure(cause, statement, index, rest);
    } finally {
      // Nothing may interrupt the transaction probe below.
      this.statementRunning = false;
      this.stopInterrupt?.();
      this.stopInterrupt = undefined;
    }
    await this.trackTransaction(statement.keyword, failed);
    return { event, failed };
  }

  // Splits by tokenizing; the parser has to agree on the number of statements.
  private async split(script: string): Promise<Planned[]> {
    const tokens = await tokenRows(this.parser, script);
    // Both cut the tokens alike, so the n-th span is the n-th statement.
    const spans = statementSpans(tokens);
    const statements = splitScript(script, tokens).map((statement, index) => ({
      ...statement,
      changesCatalog: statementKind(spans[index]?.tokens ?? []) === 'writes',
    }));
    if (statements.length > 0) {
      const parsed = await this.parser.extractStatements(script);
      if (parsed.count !== statements.length) {
        throw new Error(
          `The script could not be split into statements safely (${statements.length} found, ${parsed.count} parsed).`,
        );
      }
    }
    return statements;
  }

  private async runStatement(
    statement: ScriptStatement,
    index: number,
    { maxRows, maxCells }: Limits,
    started: number,
  ): Promise<SqlEvent> {
    const prepared = await this.connection.prepare(statement.sql);
    try {
      const result = await prepared.stream();
      try {
        if (result.returnType === this.engine.ResultReturnType.CHANGED_ROWS) {
          const rowsAffected = Number(result.rowsChanged);
          return {
            kind: 'message',
            index,
            text: `${rowsAffected} ${rowsAffected === 1 ? 'row' : 'rows'} affected.`,
            rowsAffected,
            elapsedMs: since(started),
          };
        }
        if (result.returnType !== this.engine.ResultReturnType.QUERY_RESULT) {
          return {
            kind: 'message',
            index,
            text: 'Commands completed successfully.',
            elapsedMs: since(started),
          };
        }
        const types = result.columnTypes();
        const columns = result.columnNames().map((name, position): GridColumn => {
          const type = types[position]?.toString() ?? '';
          return { name, type, kind: kindOf(type) };
        });
        const limit = Math.min(maxRows, Math.floor(maxCells / Math.max(columns.length, 1)));
        const rows: GridValue[][] = [];
        for await (const chunk of result.yieldRowsJson()) {
          rows.push(...chunk.map((row) => row.map(toGridValue)));
          if (rows.length > limit) break;
        }
        const truncated = rows.length > limit;
        rows.length = Math.min(rows.length, limit);
        return { kind: 'resultSet', index, columns, rows, truncated, elapsedMs: since(started) };
      } finally {
        result.closeSync();
      }
    } finally {
      prepared.destroySync();
    }
  }

  private async failure(
    cause: unknown,
    statement: ScriptStatement,
    index: number,
    rest: number,
  ): Promise<SqlEvent> {
    const raw = this.scrubbed(cause);
    if (this.cancelRequested || /^INTERRUPT Error/.test(raw)) {
      return { kind: 'error', index, message: withRest('The statement was cancelled.', rest) };
    }
    const range = caretRange(raw, statement.sql);
    return {
      kind: 'error',
      index,
      message: withRest(translateSqlError(raw, await this.contextFor(raw)).message, rest),
      ...(range ? { position: { offset: statement.offset + range.offset, length: range.length } } : {}),
    };
  }

  // The data path is queried only for a missing file; inside a failed transaction the query fails and the text says less.
  private async contextFor(raw: string): Promise<SqlErrorContext> {
    if (!MISSING_OBJECT.test(raw) && !MISSING_LOCAL_FILE.test(raw)) {
      return this.context;
    }
    try {
      const path = (await this.connection.runAndReadAll(dataPathQuery())).getRowsJson()[0]?.[0];
      return typeof path === 'string'
        ? { ...this.context, dataPath: maskSecrets(path, this.secrets) }
        : this.context;
    } catch {
      return this.context;
    }
  }

  private scrubbed(cause: unknown): string {
    return this.mask(messageOf(cause));
  }

  // A failed COMMIT or ROLLBACK also leaves no transaction. A failure inside an open one may have aborted it;
  // only the engine knows, and it then refuses every statement.
  private async trackTransaction(keyword: string, failed: boolean): Promise<void> {
    if (ENDS_TRANSACTION.has(keyword)) {
      this.inTransaction = 'none';
    } else if (!failed && STARTS_TRANSACTION.has(keyword)) {
      this.inTransaction = 'open';
    } else if (failed && this.inTransaction === 'open') {
      try {
        await this.connection.run('SELECT 1');
      } catch (cause) {
        if (cause instanceof Error && /Current transaction is aborted/.test(cause.message)) {
          this.inTransaction = 'aborted';
        }
      }
    }
  }
}

/** The syntax errors of a text; `json_serialize_sql` only parses and reports positions as UTF-8 byte offsets. */
async function syntaxErrors(parser: Duckdb.DuckDBConnection, original: string): Promise<Diagnostic[]> {
  const text = withoutBom(original);
  return syntaxErrorsOf(await serializeSql(parser, text), text);
}

/**
 * The jobs that replace the tokens of a session: the storage token of an Azure or OneLake storage, the password of an
 * Entra login.
 * Each new token joins `secrets` before it is used, so that an error quoting it is masked; the old ones stay there,
 * because a statement that started with one may still report it.
 */
export function tokenRenewals(
  { storage, profile, renewPassword }: DataAccess,
  secrets: string[],
  run: (sql: string) => Promise<unknown>,
): (() => Promise<void>)[] {
  const renewals: (() => Promise<void>)[] = [];
  if (storage?.refresh) {
    const { refresh } = storage;
    renewals.push(async () => {
      const accessToken = await refresh();
      secrets.push(accessToken);
      const renewed = storageSecretStatement({ ...storage, values: { ...storage.values, accessToken } });
      if (renewed) await run(renewed);
    });
  }
  if (renewPassword && profile.kind === 'postgres') {
    renewals.push(async () => {
      const token = await renewPassword();
      secrets.push(token);
      await run(postgresSecretStatement(profile, token));
    });
  }
  return renewals;
}

function withRest(message: string, rest: number): string {
  if (rest === 0) return message;
  return `${sentence(message)} ${rest === 1 ? 'The remaining statement was' : `The remaining ${rest} statements were`} not run.`;
}

function sentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function since(started: number): number {
  return Math.round(performance.now() - started);
}
