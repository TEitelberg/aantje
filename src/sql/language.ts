import type * as Duckdb from '@duckdb/node-api';
import { loadEngine } from '../data/open-lake';
import type { Logger } from '../log';
import { failureLog } from '../log-once';
import type { FailureLog } from '../log-once';
import type { SqlCatalog } from './catalog';
import { completionsAt } from './completion';
import type { Completions } from './completion';
import { statementSnapshot } from './context';
import type { SqlToken } from './tokens';
import { hoverAt, signatureAt } from './help';
import type { Hover, SignatureHelp } from './help';
import { openLookup } from './lookup';
import { parseText } from './parse';
import type { ParsedText } from './parse';
import type { Problem } from './problems';
import { utf16Offsets, withoutBom } from './script';
import { serializeSql } from './session';
import { tokenWindow } from './token-window';
import { unknownNames } from './unknown-names';
import { loadVocabulary } from './vocabulary';
import type { Vocabulary } from './vocabulary';

export type { Problem } from './problems';

interface LanguageServiceOptions {
  /** Where DuckDB keeps extensions; the service loads none, so nothing is written there. */
  readonly extensionDirectory?: string;
  /** Where DuckDB failures go; each kind is logged once. */
  readonly logger?: Logger;
}

// Parsing 200 000 characters takes about 200 ms.
const MAX_DIAGNOSE_LENGTH = 200_000;

// Tokenizing 500 000 characters takes about 1 s.
const MAX_COMPLETE_LENGTH = 500_000;

const CLOSED = 'The language service is closed.';

// How long the name check waits for a catalog that is still being read; then it gives no warnings this time.
const CATALOG_WAIT_MS = 1000;

/**
 * SQL IntelliSense without the VS Code API. Its own in-memory DuckDB attaches nothing, loads no extension,
 * blocks external access and never executes the text; it only tokenizes and parses.
 */
export interface LanguageService {
  /** The tokens of a text with UTF-16 offsets. Comments are tokens too; whitespace is not. */
  tokenize(text: string): Promise<SqlToken[]>;
  /** What DuckDB knows about its language (keywords, functions, types, settings), loaded on first use. */
  vocabulary(): Promise<Vocabulary>;
  /**
   * Syntax errors by parsing only; with a catalog and no syntax error, warnings for the tables, views and columns that
   * the catalog certainly lacks. A call replaced by a newer call with the same `source` answers `undefined`.
   */
  diagnose(text: string, source?: string, catalog?: SqlCatalog): Promise<readonly Problem[] | undefined>;
  /** Undefined inside a string, a comment or a number, and for a text longer than `MAX_COMPLETE_LENGTH`. */
  complete(text: string, offset: number, catalog: SqlCatalog): Promise<Completions | undefined>;
  hover(text: string, offset: number, catalog: SqlCatalog): Promise<Hover | undefined>;
  signature(text: string, offset: number, catalog: SqlCatalog): Promise<SignatureHelp | undefined>;
  /** Waits for the call that is running, answers the waiting ones with `undefined`, then closes the DuckDB. */
  dispose(): Promise<void>;
}

/** The catalog at the snapshot that the statement at the offset names with `AT (VERSION => n)`, else `catalog`. */
function catalogOfStatement(catalog: SqlCatalog, tokens: readonly SqlToken[], offset: number): SqlCatalog {
  const snapshot = statementSnapshot(tokens, offset);
  return snapshot === undefined ? catalog : catalog.at(snapshot);
}

/** Opens the service; the DuckDB starts on the first call that needs it. */
export function openLanguageService(options: LanguageServiceOptions = {}): LanguageService {
  return new DuckdbLanguageService(options);
}

interface Ready {
  readonly instance: Duckdb.DuckDBInstance;
  readonly connection: Duckdb.DuckDBConnection;
  readonly vocabulary: Vocabulary;
  /** DuckDB's own views in lower case, which a name without schema may read (`duckdb_tables`, `pg_tables`). */
  readonly system: ReadonlySet<string>;
}

interface Job {
  readonly text: string;
  readonly catalog: SqlCatalog | undefined;
  resolve(found: readonly Problem[] | PromiseLike<readonly Problem[]> | undefined): void;
}

class DuckdbLanguageService implements LanguageService {
  private ready: Promise<Ready> | undefined;
  private disposed = false;
  private draining = false;
  // The newest text per source.
  private readonly waiting = new Map<string, Job>();
  private readonly running = new Set<Promise<unknown>>();
  private readonly window = tokenWindow((text) => this.readTokens(text));

  private readonly failed: FailureLog | undefined;

  constructor(private readonly options: LanguageServiceOptions) {
    this.failed = options.logger && failureLog(options.logger);
  }

  tokenize(text: string): Promise<SqlToken[]> {
    if (this.disposed) return Promise.reject(new Error(CLOSED));
    return this.track(this.window.all(withoutBom(text)));
  }

  async vocabulary(): Promise<Vocabulary> {
    return (await this.open()).vocabulary;
  }

  diagnose(text: string, source = '', catalog?: SqlCatalog): Promise<readonly Problem[] | undefined> {
    if (this.disposed || text.trim() === '' || text.length > MAX_DIAGNOSE_LENGTH) return Promise.resolve([]);
    return new Promise((resolve) => {
      this.waiting.get(source)?.resolve(undefined);
      this.waiting.delete(source);
      this.waiting.set(source, { text, catalog, resolve });
      void this.drain();
    });
  }

  async complete(text: string, offset: number, catalog: SqlCatalog): Promise<Completions | undefined> {
    if (text.length > MAX_COMPLETE_LENGTH) return undefined;
    const [tokens, vocabulary] = await Promise.all([this.statementTokens(text, offset), this.vocabulary()]);
    return completionsAt(tokens, offset, vocabulary, catalogOfStatement(catalog, tokens, offset));
  }

  async hover(text: string, offset: number, catalog: SqlCatalog): Promise<Hover | undefined> {
    if (text.length > MAX_COMPLETE_LENGTH) return undefined;
    const [tokens, vocabulary] = await Promise.all([this.statementTokens(text, offset), this.vocabulary()]);
    return hoverAt(tokens, offset, vocabulary, await openLookup(catalogOfStatement(catalog, tokens, offset)));
  }

  async signature(text: string, offset: number, catalog: SqlCatalog): Promise<SignatureHelp | undefined> {
    if (text.length > MAX_COMPLETE_LENGTH) return undefined;
    const [tokens, vocabulary] = await Promise.all([this.statementTokens(text, offset), this.vocabulary()]);
    return signatureAt(
      tokens,
      offset,
      vocabulary,
      await openLookup(catalogOfStatement(catalog, tokens, offset)),
    );
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.waiting.values()) job.resolve(undefined);
    this.waiting.clear();
    const ready = this.ready;
    this.ready = undefined;
    await Promise.allSettled([...this.running]);
    // A failed start was logged when it happened.
    const created = await ready?.catch(() => undefined);
    try {
      created?.connection.closeSync();
    } finally {
      created?.instance.closeSync();
    }
  }

  private open(): Promise<Ready> {
    if (this.disposed) return Promise.reject(new Error(CLOSED));
    this.ready ??= this.create().catch((cause: unknown) => {
      this.ready = undefined;
      this.failed?.('Starting the DuckDB of the language service', cause);
      throw cause;
    });
    return this.ready;
  }

  private async create(): Promise<Ready> {
    const engine = await loadEngine();
    const instance = await engine.DuckDBInstance.create(':memory:', {
      enable_external_access: 'false',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_persistent_secrets: 'false',
      ...(this.options.extensionDirectory ? { extension_directory: this.options.extensionDirectory } : {}),
    });
    try {
      const connection = await instance.connect();
      const [vocabulary, system] = await Promise.all([loadVocabulary(connection), systemViews(connection)]);
      return { instance, connection, vocabulary, system };
    } catch (cause) {
      instance.closeSync();
      throw cause;
    }
  }

  // Lets `dispose` wait for running calls.
  private track<T>(promise: Promise<T>): Promise<T> {
    this.running.add(promise);
    const forget = (): void => void this.running.delete(promise);
    promise.then(forget, forget);
    return promise;
  }

  // The tokens of the text up to the end of the statement at the offset: all that completion and help read.
  private statementTokens(text: string, offset: number): Promise<SqlToken[]> {
    if (this.disposed) return Promise.reject(new Error(CLOSED));
    return this.track(this.window.upTo(withoutBom(text), offset));
  }

  private async readTokens(plain: string): Promise<SqlToken[]> {
    const { connection } = await this.open();
    const reader = await connection.runAndReadAll('SELECT start, token_type, word FROM sql_tokenize($1)', [
      plain,
    ]);
    const unitOf = utf16Offsets(plain);
    return (reader.getRowsJson() as unknown as [number, string, string][]).map(([start, type, word]) => {
      const offset = unitOf(Number(start));
      return { start: offset, end: offset + word.length, type, word };
    });
  }

  // Parses one text at a time, oldest source first.
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.waiting.entries().next(); !next.done; next = this.waiting.entries().next()) {
        const [source, job] = next.value;
        this.waiting.delete(source);
        const parsed = await this.track(this.parse(job.text, job.catalog !== undefined)).catch(
          (cause: unknown) => {
            this.failed?.('Parsing the SQL for the syntax check', cause);
            return undefined;
          },
        );
        // The names are checked against the catalog while the next text is parsed; the check needs no DuckDB.
        job.resolve(parsed ? this.problems(parsed, job.catalog) : []);
      }
    } finally {
      this.draining = false;
    }
  }

  private async parse(text: string, withQueries: boolean): Promise<{ text: ParsedText; ready: Ready }> {
    const ready = await this.open();
    const parser = {
      serialize: (sql: string) => serializeSql(ready.connection, sql),
      tokens: (sql: string) => this.window.all(sql),
    };
    return { text: await parseText(parser, withoutBom(text), withQueries), ready };
  }

  private async problems(
    { text, ready }: { text: ParsedText; ready: Ready },
    catalog: SqlCatalog | undefined,
  ): Promise<Problem[]> {
    const errors = text.errors.map((error): Problem => ({ ...error, severity: 'error', replacements: [] }));
    if (!catalog || text.queries.length === 0) return errors;
    const { queries, mentioned, qualifiedOnly } = text;
    const check = {
      catalog,
      reserved: ready.vocabulary.reserved,
      system: ready.system,
      mentioned,
      qualifiedOnly,
    };
    const checked = unknownNames(queries, check).catch((cause: unknown) => {
      this.failed?.('Checking the names of the SQL', cause);
      return [];
    });
    // A catalog that is still being read gives no warnings this time; its reads go on, for the next check.
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<Problem[]>(
      (resolve) => (timer = setTimeout(() => resolve([]), CATALOG_WAIT_MS)),
    );
    return Promise.race([checked, waited]).finally(() => clearTimeout(timer));
  }
}

// The views of DuckDB itself (`main.duckdb_tables`, `pg_catalog.pg_tables`, ...), which no catalog of the lake lists.
async function systemViews(connection: Duckdb.DuckDBConnection): Promise<ReadonlySet<string>> {
  const reader = await connection.runAndReadAll(
    'SELECT DISTINCT lower(view_name) FROM duckdb_views() WHERE internal',
  );
  return new Set(reader.getRowsJson().flatMap(([name]) => (typeof name === 'string' ? [name] : [])));
}
