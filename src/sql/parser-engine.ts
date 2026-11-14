// The DuckDB that parses hostile text and runs nothing of it: in memory, with no external access, no extension loading
// and no persistent secrets. The language service and the commands that parse view SQL (Dependencies, Schema Compare,
// Generate Scripts, Restore) open one each with these settings; the SQL session asks its own DuckDB the same questions.
import type * as Duckdb from '@duckdb/node-api';
import { loadEngine } from '../duckdb/engine';
import type { Token } from './script';

// The settings that keep the text from reaching anything outside the instance.
const SANDBOX = {
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  allow_persistent_secrets: 'false',
} as const;

export interface ParserDuckdb {
  readonly instance: Duckdb.DuckDBInstance;
  readonly connection: Duckdb.DuckDBConnection;
}

type Reading = Pick<Duckdb.DuckDBConnection, 'runAndReadAll'>;

/** Opens an in-memory DuckDB in the sandbox; `extensionDirectory` is where DuckDB would keep extensions (it loads none). */
export async function openParserDuckdb(extensionDirectory?: string): Promise<ParserDuckdb> {
  const engine = await loadEngine();
  const instance = await engine.DuckDBInstance.create(':memory:', {
    ...(extensionDirectory ? { extension_directory: extensionDirectory } : {}),
    ...SANDBOX,
  });
  try {
    return { instance, connection: await instance.connect() };
  } catch (cause) {
    instance.closeSync();
    throw cause;
  }
}

export function closeParserDuckdb({ instance, connection }: ParserDuckdb): void {
  try {
    connection.closeSync();
  } finally {
    instance.closeSync();
  }
}

/** The tokens of a text as `sql_tokenize` gives them; `start` counts UTF-8 bytes. Nothing is run. */
export async function tokenRows(connection: Reading, text: string): Promise<Token[]> {
  const reader = await connection.runAndReadAll('SELECT start, token_type, word FROM sql_tokenize($1)', [
    text,
  ]);
  return (reader.getRowsJson() as unknown as [number, string, string][]).map(([start, type, word]) => ({
    start: Number(start),
    type,
    word,
  }));
}

/** The `json_serialize_sql` document of a text: its statements or the error of parsing it; empty when DuckDB gives none. */
export async function serializeSql(connection: Reading, text: string): Promise<string> {
  const reader = await connection.runAndReadAll('SELECT json_serialize_sql($1)', [text]);
  const json = reader.getRowsJson()[0]?.[0];
  return typeof json === 'string' ? json : '';
}

/** A value that opens on first use. A failed open is not kept, so the next use tries again; `failed` hears of it. */
export class OnFirstUse<T> {
  private pending: Promise<T> | undefined;

  constructor(
    private readonly open: () => Promise<T>,
    private readonly failed?: (cause: unknown) => void,
  ) {}

  get(): Promise<T> {
    if (!this.pending) {
      const opening = this.open();
      this.pending = opening;
      opening.catch((cause: unknown) => {
        if (this.pending === opening) this.pending = undefined;
        this.failed?.(cause);
      });
    }
    return this.pending;
  }

  /** Forgets the value and gives it for closing; undefined when none was opened, or opening it failed. */
  async take(): Promise<T | undefined> {
    const pending = this.pending;
    this.pending = undefined;
    return pending?.catch(() => undefined);
  }
}
