import type * as Duckdb from '@duckdb/node-api';
import {
  closeParserDuckdb,
  OnFirstUse,
  openParserDuckdb,
  serializeSql,
  tokenRows,
} from '../sql/parser-engine';
import type { Token } from '../sql/script';

/** What the analysis asks of DuckDB: to parse a text and to name its built-in functions. Nothing given is run. */
export interface SqlParser {
  /** The `json_serialize_sql` document of the text: an error document for a text that is not exactly one SELECT. */
  serialize(sql: string): Promise<string>;
  /** Lower case names of the built-in functions, and of those that can follow FROM (`FROM duckdb_tables`). */
  functions(): Promise<BuiltinFunctions>;
  dispose(): Promise<void>;
}

/** The tokens of a text as DuckDB's `sql_tokenize` gives them, which the SQL editor splits a script at. Nothing is run. */
export interface SqlTokenizer {
  tokenize(text: string): Promise<Token[]>;
}

interface BuiltinFunctions {
  readonly all: ReadonlySet<string>;
  readonly table: ReadonlySet<string>;
}

/** An in-memory DuckDB of its own in the parser sandbox (`sql/parser-engine.ts`); it opens on the first call. */
export function openSqlParser(): SqlParser & SqlTokenizer {
  // A start or a read that failed is not kept: the next report tries again.
  const ready = new OnFirstUse(() => openParserDuckdb());
  const builtins = (): OnFirstUse<BuiltinFunctions> =>
    new OnFirstUse(async () => builtinFunctions((await ready.get()).connection));
  let functions = builtins();

  return {
    serialize: async (sql) => serializeSql((await ready.get()).connection, sql),
    tokenize: async (text) => tokenRows((await ready.get()).connection, text),
    functions: () => functions.get(),
    async dispose() {
      // A parser that failed to start has nothing to close; the call that started it got the error.
      const created = await ready.take();
      functions = builtins();
      if (created) closeParserDuckdb(created);
    },
  };
}

async function builtinFunctions(connection: Duckdb.DuckDBConnection): Promise<BuiltinFunctions> {
  const reader = await connection.runAndReadAll(
    "SELECT DISTINCT lower(function_name), function_type = 'table' FROM duckdb_functions()",
  );
  const rows = reader.getRowsJson() as [string, boolean][];
  return {
    all: new Set(rows.map(([name]) => name)),
    table: new Set(rows.filter(([, table]) => table).map(([name]) => name)),
  };
}
