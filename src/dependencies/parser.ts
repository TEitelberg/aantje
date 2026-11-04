import type * as Duckdb from '@duckdb/node-api';
import { loadEngine } from '../data/open-lake';

/** What the analysis asks of DuckDB: to parse a text and to name its built-in functions. Nothing given is run. */
export interface SqlParser {
  /** The `json_serialize_sql` document of the text: an error document for a text that is not exactly one SELECT. */
  serialize(sql: string): Promise<string>;
  /** Lower case names of the built-in functions, and of those that can follow FROM (`FROM duckdb_tables`). */
  functions(): Promise<BuiltinFunctions>;
  dispose(): Promise<void>;
}

interface BuiltinFunctions {
  readonly all: ReadonlySet<string>;
  readonly table: ReadonlySet<string>;
}

/** An in-memory DuckDB of its own with no ATTACH, extension or external access; it opens on the first call. */
export function openSqlParser(): SqlParser {
  let ready:
    | Promise<{ readonly instance: Duckdb.DuckDBInstance; readonly connection: Duckdb.DuckDBConnection }>
    | undefined;
  let functions: Promise<BuiltinFunctions> | undefined;

  // A start or a read that failed is not kept, as in the language service: the next report tries again.
  const forgetFailure = <T>(pending: Promise<T>, forget: () => void): Promise<T> => {
    pending.catch(forget);
    return pending;
  };
  const open = () => {
    if (!ready) {
      const starting = (async () => {
        const engine = await loadEngine();
        const instance = await engine.DuckDBInstance.create(':memory:', {
          enable_external_access: 'false',
          autoinstall_known_extensions: 'false',
          autoload_known_extensions: 'false',
          allow_persistent_secrets: 'false',
        });
        return { instance, connection: await instance.connect() };
      })();
      ready = forgetFailure(starting, () => {
        if (ready === starting) ready = undefined;
      });
    }
    return ready;
  };

  return {
    async serialize(sql) {
      const { connection } = await open();
      const reader = await connection.runAndReadAll('SELECT json_serialize_sql($1)', [sql]);
      const json = reader.getRowsJson()[0]?.[0];
      return typeof json === 'string' ? json : '';
    },
    functions() {
      if (!functions) {
        const reading = open().then(async ({ connection }) => {
          const reader = await connection.runAndReadAll(
            "SELECT DISTINCT lower(function_name), function_type = 'table' FROM duckdb_functions()",
          );
          const rows = reader.getRowsJson() as [string, boolean][];
          return {
            all: new Set(rows.map(([name]) => name)),
            table: new Set(rows.filter(([, table]) => table).map(([name]) => name)),
          };
        });
        functions = forgetFailure(reading, () => {
          if (functions === reading) functions = undefined;
        });
      }
      return functions;
    },
    async dispose() {
      // A parser that failed to start has nothing to close; the call that started it got the error.
      const created = await ready?.catch(() => undefined);
      ready = undefined;
      functions = undefined;
      try {
        created?.connection.closeSync();
      } finally {
        created?.instance.closeSync();
      }
    },
  };
}
