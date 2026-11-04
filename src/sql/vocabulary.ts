import type * as Duckdb from '@duckdb/node-api';
import { POSITIONAL_PARAMETERS } from './duckdb-vocabulary';
import { GLOBAL_LAKE_FUNCTIONS, LAKE_FUNCTIONS } from './ducklake';

export type FunctionKind = 'scalar' | 'aggregate' | 'window' | 'table' | 'macro';

export interface Parameter {
  readonly name: string;
  readonly type: string;
  /** The stored default of a macro parameter. */
  readonly defaultValue?: string;
  /** Passed by name (`dry_run => true`) after the positional arguments. */
  readonly named?: boolean;
}

export interface Overload {
  readonly parameters: readonly Parameter[];
  readonly returns: string | undefined;
  /** The type of the extra arguments of a variadic function. */
  readonly varargs: string | undefined;
}

export interface FunctionInfo {
  readonly name: string;
  /** The kind of the first overload that is no table function; `table` when all are. */
  readonly kind: FunctionKind;
  /** Some overload can be used in an expression. */
  readonly expression: boolean;
  /** Some overload can be used after FROM. */
  readonly relation: boolean;
  /** Exists only after the lake name (`lake.snapshots()`). */
  readonly qualified: boolean;
  /** Called with CALL; changes the lake. */
  readonly procedure: boolean;
  /** Takes the lake's name as its first argument: `ducklake_snapshots('lake')`. */
  readonly lakeArgument: boolean;
  readonly description: string | undefined;
  /** `{lake}` in the text stands for the lake name. */
  readonly examples: readonly string[];
  readonly overloads: readonly Overload[];
}

interface Keyword {
  /** In upper case. */
  readonly name: string;
  /** `reserved`, `unreserved`, `column_name` or `type_function`. */
  readonly category: string;
}

interface TypeName {
  /** In lower case. */
  readonly name: string;
  readonly category: string | undefined;
}

interface Setting {
  readonly name: string;
  readonly type: string;
  readonly description: string;
}

/** What DuckDB knows about its own language, loaded once. */
export interface Vocabulary {
  readonly keywords: readonly Keyword[];
  /** Lower case names that cannot be used unquoted as the name of a table or column. */
  readonly reserved: ReadonlySet<string>;
  /** By lower case name. */
  readonly functions: ReadonlyMap<string, FunctionInfo>;
  /** The functions behind the lake's name (`lake.snapshots()`), by lower case name. */
  readonly lakeFunctions: ReadonlyMap<string, FunctionInfo>;
  readonly types: readonly TypeName[];
  readonly settings: readonly Setting[];
}

const MAX_EXAMPLES = 3;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Builder extends Mutable<
  Pick<FunctionInfo, 'name' | 'kind' | 'expression' | 'relation' | 'description' | 'examples'>
> {
  readonly overloads: Overload[];
  readonly signatures: Set<string>;
}

const KINDS: Record<string, FunctionKind> = {
  scalar: 'scalar',
  aggregate: 'aggregate',
  window: 'window',
  table: 'table',
  macro: 'macro',
  table_macro: 'table',
};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const optional = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : []);

/** Reads keywords, functions (grouped by name with overloads), types and settings; descriptions and examples are kept once per name. */
export async function loadVocabulary(connection: Duckdb.DuckDBConnection): Promise<Vocabulary> {
  const read = async (sql: string): Promise<unknown[][]> =>
    (await connection.runAndReadAll(sql)).getRowsJson();

  const keywords = (
    await read('SELECT keyword_name, keyword_category FROM duckdb_keywords() ORDER BY 1')
  ).map(([name, category]): Keyword => ({ name: text(name).toUpperCase(), category: text(category) }));
  const types = (
    await read(
      `SELECT DISTINCT type_name, type_category FROM duckdb_types()
       WHERE regexp_matches(type_name, '^[a-z_][a-z0-9_ ]*$') ORDER BY 1`,
    )
  ).map(([name, category]): TypeName => ({ name: text(name), category: optional(category) }));
  const settings = (await read('SELECT name, input_type, description FROM duckdb_settings() ORDER BY 1')).map(
    ([name, type, description]): Setting => ({
      name: text(name),
      type: text(type),
      description: text(description),
    }),
  );
  const rows = await read(
    `SELECT function_name, function_type, description, examples, return_type, parameters, parameter_types, varargs
     FROM duckdb_functions()
     WHERE function_type <> 'pragma' AND regexp_matches(function_name, '^[a-zA-Z][a-zA-Z0-9_]*$')
     ORDER BY function_name, function_type, len(parameters)`,
  );

  const builders = new Map<string, Builder>();
  for (const [name, type, description, examples, returns, parameters, parameterTypes, varargs] of rows) {
    const key = text(name).toLowerCase();
    const kind = KINDS[text(type)] ?? 'scalar';
    const typesOf = texts(parameterTypes);
    // DuckDB lists the named parameters of a table function after the positional ones without marking them.
    const positional = kind === 'table' ? (POSITIONAL_PARAMETERS[key] ?? Infinity) : Infinity;
    const overload: Overload = {
      parameters: texts(parameters).map((parameter, index): Parameter => {
        const declared = typesOf[index];
        return {
          name: parameter,
          type: declared === undefined || declared === '' ? 'ANY' : declared,
          ...(index >= positional ? { named: true } : {}),
        };
      }),
      returns: optional(returns),
      varargs: optional(varargs),
    };
    const builder = builders.get(key) ?? {
      name: text(name),
      kind,
      expression: false,
      relation: false,
      description: undefined,
      examples: [],
      overloads: [],
      signatures: new Set<string>(),
    };
    builders.set(key, builder);
    if (builder.kind === 'table') builder.kind = kind;
    builder.expression ||= kind !== 'table';
    builder.relation ||= kind === 'table';
    builder.description ??= optional(description);
    if (builder.examples.length === 0) builder.examples = texts(examples).slice(0, MAX_EXAMPLES);
    const signature = JSON.stringify(overload);
    if (!builder.signatures.has(signature)) {
      builder.signatures.add(signature);
      builder.overloads.push(overload);
    }
  }
  const functions = new Map<string, FunctionInfo>();
  for (const [key, { signatures: _signatures, ...builder }] of builders) {
    functions.set(key, { ...builder, qualified: false, procedure: false, lakeArgument: false });
  }
  // The service loads no extension, so DuckDB does not list them.
  for (const fn of GLOBAL_LAKE_FUNCTIONS) functions.set(fn.name, fn);
  return {
    keywords,
    reserved: new Set(
      keywords.filter(({ category }) => category !== 'unreserved').map(({ name }) => name.toLowerCase()),
    ),
    functions,
    lakeFunctions: new Map(LAKE_FUNCTIONS.map((fn) => [fn.name, fn])),
    types,
    settings,
  };
}
