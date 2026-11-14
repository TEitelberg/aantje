import { foldIdentifier, sameIdentifier } from '../../catalog/ddl';
import { LAKE } from '../attach';
import { engineVersionQuery, lakeFunctionsQuery, macrosQuery, METADATA, viewsQuery } from './queries';
import type { Rows } from './queries';

// Read-only DuckLake functions. Any other `ducklake_` function can change the lake or delete files
// (`ducklake_cleanup_old_files` does, even on a read-only attach); the configuration lock does not stop that.
const READ_ONLY_FUNCTIONS: ReadonlySet<string> = new Set([
  'ducklake_snapshots',
  'ducklake_current_snapshot',
  'ducklake_last_committed_snapshot',
  'ducklake_options',
  'ducklake_settings',
  'ducklake_table_info',
  'ducklake_list_files',
  'ducklake_table_insertions',
  'ducklake_table_deletions',
  'ducklake_table_changes',
  'ducklake_scan',
]);

// Run SQL assembled while the view runs, which no check of the stored text can see.
const DYNAMIC_SQL_FUNCTIONS: ReadonlySet<string> = new Set([
  'query',
  'query_table',
  'json_execute_serialized_sql',
]);

const CHECKPOINT_FUNCTIONS: ReadonlySet<string> = new Set(['checkpoint', 'force_checkpoint']);

// The read-only functions as the catalog offers them without the prefix (`lake.snapshots()`, `main.table_changes(...)`).
// Any other function reached through a catalog or schema name may write and is refused, unless it is a macro of the lake.
const READ_ONLY_QUALIFIED: ReadonlySet<string> = new Set(
  [...READ_ONLY_FUNCTIONS].map((name) => name.replace(/^ducklake_/, '')),
);

// The maintenance and write functions as the catalog itself offers them, without the prefix. DuckLake stores a view
// without the name of its catalog, so `lake.merge_adjacent_files()` is stored, and later read, as the bare
// `merge_adjacent_files()`, which resolves inside the lake. The list that counts comes from the engine
// (`lakeFunctionsQuery`); this one is the fallback for an engine that cannot list its functions.
const CATALOG_MAINTENANCE_FALLBACK: ReadonlySet<string> = new Set([
  'merge_adjacent_files',
  'set_option',
  'set_commit_message',
  'expire_snapshots',
  'cleanup_old_files',
  'delete_orphaned_files',
  'flush_inlined_data',
  'rewrite_data_files',
  'add_data_files',
]);

// The names listed for one engine version; every read opens a fresh engine, and listing the functions is costly.
let listedFunctions: { readonly version: string; readonly names: ReadonlySet<string> } | undefined;

// The bare names of the lake functions that may change the lake, from the engine plus the fallback list.
export async function maintenanceFunctions(rows: Rows): Promise<ReadonlySet<string>> {
  const version = JSON.stringify((await rows(engineVersionQuery()))[0] ?? null);
  if (listedFunctions?.version === version) {
    return listedFunctions.names;
  }
  const listed = await rows(lakeFunctionsQuery()).catch(() => undefined);
  const names = new Set(
    [
      ...(listed ?? []).flatMap(([name]) =>
        typeof name === 'string' ? [foldIdentifier(name).replace(/^ducklake_/, '')] : [],
      ),
      ...CATALOG_MAINTENANCE_FALLBACK,
    ].filter((name) => !READ_ONLY_QUALIFIED.has(name)),
  );
  // A failed listing is asked again by the next read.
  if (listed) {
    listedFunctions = { version, names };
  }
  return names;
}

// Catalogs that hold built-in functions only.
const SYSTEM_CATALOGS: ReadonlySet<string> = new Set(['system', 'pg_catalog', 'information_schema']);

// The reason a view may not call the function; undefined when it may. A macro of the lake with the name of a
// maintenance function does not make the call harmless: the built-in function of the catalog wins over the macro.
function forbiddenBecause(name: string, maintenance: ReadonlySet<string>): string | undefined {
  if ((name.startsWith('ducklake_') && !READ_ONLY_FUNCTIONS.has(name)) || maintenance.has(name)) {
    return 'which can change the lake or delete its files';
  }
  if (CHECKPOINT_FUNCTIONS.has(name)) {
    return 'which runs maintenance on the lake';
  }
  if (DYNAMIC_SQL_FUNCTIONS.has(name)) {
    return 'which runs SQL that is assembled while the view runs, so it cannot be checked beforehand';
  }
  // `quack_query` runs any SQL on a Quack server, with the token of the user who previews the view.
  if (name.startsWith('quack_')) {
    return 'which talks to a Quack server and can run any SQL there with your token';
  }
  return undefined;
}

interface Definition {
  readonly kind: 'view' | 'macro';
  readonly schema: string;
  readonly name: string;
  /** Result of `json_serialize_sql`. */
  readonly ast: string | null;
}

// Functions a stored statement calls and tables or views it reads, by lower-case name.
interface Uses {
  readonly calls: Set<string>;
  /** Calls that name a catalog or schema (`lake.main.f`), as lower-case name paths, schema and catalog first. */
  readonly qualified: Set<readonly string[]>;
  readonly relations: Set<string>;
  /** References that reach a catalog other than the lake (`__ducklake_metadata_lake`, `memory`, ...), as shown. */
  readonly foreign: Set<string>;
}

function usesOf(ast: string | null): Uses | undefined {
  let parsed: unknown;
  try {
    parsed = ast === null ? undefined : JSON.parse(ast);
  } catch {
    // No readable parse tree: the caller cannot classify the statement.
    return undefined;
  }
  const statements = (parsed as { error?: unknown; statements?: unknown } | undefined)?.statements;
  const root = parsed as { error?: unknown } | undefined;
  // Several statements, a non-SELECT or unparsable text: nothing is known about what it does.
  if (root?.error !== false || !Array.isArray(statements) || statements.length !== 1) {
    return undefined;
  }
  const uses: Uses = { calls: new Set(), qualified: new Set(), relations: new Set(), foreign: new Set() };
  const consider = (catalog: unknown, schema: unknown): void => {
    const foreign = foreignCatalog(
      typeof catalog === 'string' ? catalog : '',
      typeof schema === 'string' ? schema : '',
    );
    if (foreign !== undefined) {
      uses.foreign.add(foreign);
    }
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === 'object' && node !== null) {
      const fields = node as Record<string, unknown>;
      // Names fold as DuckDB folds them, A to Z only, the same fold the catalog lookups use: with a Unicode fold a view
      // "Évil" would be looked up as "évil", never found, and never checked.
      if (typeof fields.function_name === 'string') {
        uses.calls.add(foldIdentifier(fields.function_name));
        const path = (fields.qualified_name as { path?: unknown } | undefined)?.path;
        if (Array.isArray(path) && path.length > 1 && path.every((part) => typeof part === 'string')) {
          uses.qualified.add(path.map((part: string) => foldIdentifier(part)));
        }
        consider(fields.catalog, fields.schema);
      }
      if (fields.type === 'BASE_TABLE' && typeof fields.table_name === 'string') {
        uses.relations.add(foldIdentifier(fields.table_name));
        consider(fields.catalog_name, fields.schema_name);
      }
      Object.values(fields).forEach(walk);
    }
  };
  walk(statements);
  return uses;
}

// Catalogs other than the lake that can hold user objects reached by a two-part name whose first part DuckDB resolves to
// a database (it tries a schema of the current catalog first, then a database): the DuckDB metadata file next to the
// lake, and the engine's own `memory` and `temp` catalogs.
const LOCAL_CATALOGS: ReadonlySet<string> = new Set(['memory', 'temp', foldIdentifier(METADATA)]);

/**
 * The catalog a reference reaches when that is not the lake and not a read-only system catalog, as it should be shown;
 * undefined when the reference stays in the lake, is unqualified, or is a built-in system catalog. `catalog` is the
 * database part of a three-part name (`db.schema.rel`); for a two-part name (`x.rel`) the engine may resolve `x` to a
 * database, so a `schema` that names another catalog is foreign too. Case-insensitive, as DuckDB folds ASCII.
 */
function foreignCatalog(catalog: string, schema: string): string | undefined {
  const folded = foldIdentifier(catalog);
  if (folded !== '') {
    return folded === LAKE || SYSTEM_CATALOGS.has(folded) ? undefined : catalog;
  }
  return LOCAL_CATALOGS.has(foldIdentifier(schema)) ? schema : undefined;
}

// The reason a qualified call is refused; undefined when it is a read-only function, a function of a system catalog or
// a macro of the lake (`macros` holds the folded names of the lake macros that exist). A maintenance function never
// gets here: its bare name is refused first, whether or not a macro carries the same name.
function qualifiedProblem(path: readonly string[], macros: ReadonlySet<string>): string | undefined {
  const name = path.at(-1) ?? '';
  if (READ_ONLY_QUALIFIED.has(name) || SYSTEM_CATALOGS.has(path[0] ?? '') || macros.has(name)) {
    return undefined;
  }
  return 'which is reached through a catalog or schema name and may maintain the lake';
}

interface Problem {
  readonly definition: Definition;
  readonly reason: string;
}

interface Closure {
  readonly problem?: Problem;
  /** The folded names of every relation the views and macros of the closure read; tables among them are checked next. */
  readonly relations: ReadonlySet<string>;
}

// The definitions of one kind visible at `at` with one of the folded `names`; none when nothing is asked for.
async function definitions(
  rows: Rows,
  at: string,
  kind: Definition['kind'],
  names: ReadonlySet<string>,
): Promise<Definition[]> {
  if (names.size === 0) {
    return [];
  }
  const result =
    kind === 'view'
      ? await rows(viewsQuery(at, names))
      : await rows(macrosQuery(at, names)).catch((cause: unknown) => {
          // Older DuckLake versions have no macros.
          if (/ducklake_macro/.test(String(cause)) && /does not exist/i.test(String(cause))) {
            return [];
          }
          throw cause;
        });
  return result.map(([, schema, name, ast]) => ({
    kind,
    schema: String(schema),
    name: String(name),
    ast: typeof ast === 'string' ? ast : null,
  }));
}

// Follows the views and macros the start view names, breadth first, fetching from the catalog only the definitions
// that the current level names (by folded name, in every schema), until the closure is complete: a lake with
// thousands of views costs as much as the few the view reaches. Returns the first definition that cannot be checked or
// calls a forbidden function, and the relations the closure reads.
export async function closureOf(
  rows: Rows,
  at: string,
  start: { readonly schema: string; readonly name: string },
  maintenance: ReadonlySet<string>,
): Promise<Closure> {
  const relations = new Set<string>();
  const requestedViews = new Set([foldIdentifier(start.name)]);
  const requestedMacros = new Set<string>();
  const macros = new Set<string>();
  const named = await definitions(rows, at, 'view', requestedViews);
  let level = named.filter((definition) => sameIdentifier(definition.schema, start.schema));
  // Same-named views of other schemas are followed only once a definition names them, as any other view.
  const spare = named.filter((definition) => !sameIdentifier(definition.schema, start.schema));
  while (level.length > 0) {
    const parsed: { definition: Definition; uses: Uses }[] = [];
    const wantedViews = new Set<string>();
    const wantedMacros = new Set<string>();
    const next: Definition[] = [];
    for (const definition of level) {
      const uses = usesOf(definition.ast);
      if (!uses) {
        return {
          problem: { definition, reason: 'its SQL cannot be parsed into a single SELECT statement' },
          relations,
        };
      }
      const [foreign] = uses.foreign;
      if (foreign !== undefined) {
        return {
          problem: {
            definition,
            reason: `its SQL reaches the catalog ${JSON.stringify(foreign.slice(0, 80))}, which is not the lake (a relation or function of another catalog is not inspected and may change the lake or read a server)`,
          },
          relations,
        };
      }
      for (const call of uses.calls) {
        const because = forbiddenBecause(call, maintenance);
        if (because) {
          return {
            problem: { definition, reason: `its SQL calls ${JSON.stringify(call.slice(0, 80))}, ${because}` },
            relations,
          };
        }
        if (!requestedMacros.has(call)) {
          requestedMacros.add(call);
          wantedMacros.add(call);
        }
      }
      for (const relation of uses.relations) {
        relations.add(relation);
        if (!requestedViews.has(relation)) {
          requestedViews.add(relation);
          wantedViews.add(relation);
        }
      }
      if (uses.relations.has(foldIdentifier(start.name))) {
        next.push(...spare.splice(0));
      }
      parsed.push({ definition, uses });
    }
    next.push(...(await definitions(rows, at, 'view', wantedViews)));
    const found = await definitions(rows, at, 'macro', wantedMacros);
    found.forEach((macro) => macros.add(foldIdentifier(macro.name)));
    next.push(...found);
    // The qualified calls of this level are judged once the macros they may name are known.
    for (const { definition, uses } of parsed) {
      for (const path of uses.qualified) {
        const because = qualifiedProblem(path, macros);
        if (because) {
          return {
            problem: {
              definition,
              reason: `its SQL calls ${JSON.stringify(path.join('.').slice(0, 80))}, ${because}`,
            },
            relations,
          };
        }
      }
    }
    level = next;
  }
  return { relations };
}
