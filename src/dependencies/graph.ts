import type { CatalogEntry, MacroInfo, SchemaInfo, ViewInfo } from '../catalog/model';
import { LAKE } from '../data/attach';
import type { SqlParser } from './parser';
import { compareText } from '../order';
import { extract, lower, messageLine } from './references';
import type { Reference } from './references';

export const NODE_KINDS = ['table', 'view', 'scalarMacro', 'tableMacro'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** A table, view or macro of the catalog at the snapshot. */
export interface DependencyNode {
  readonly kind: NodeKind;
  readonly id: number;
  readonly schemaId: number;
  readonly schema: string;
  readonly name: string;
}

/** `from` uses `to`: a view reads a table or view, a view or macro calls a macro. */
export interface DependencyEdge {
  readonly from: number;
  readonly to: number;
  readonly kind: 'reads' | 'calls';
}

/** A name in the SQL of `from` that no object of the catalog has at the snapshot. */
export interface BrokenReference {
  readonly from: number;
  readonly kind: Reference['kind'];
  /** As written; for a table or view without one, the first schema searched. */
  readonly schema: string;
  readonly name: string;
}

export const UNRESOLVED_REASONS = [
  'dialect',
  'tooLong',
  'syntax',
  'unsupported',
  'callerSchema',
  'catalog',
  'file',
  'dynamic',
] as const;
export type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];

/** Something in the SQL of an object that the analysis cannot follow; `detail` is catalog text. */
export interface Unresolved {
  readonly node: number;
  readonly reason: UnresolvedReason;
  readonly detail: string;
}

export interface DependencyGraph {
  /** Ordered by schema, name and kind; an index into this list names a node everywhere else. */
  readonly nodes: readonly DependencyNode[];
  readonly edges: readonly DependencyEdge[];
  readonly broken: readonly BrokenReference[];
  readonly unresolved: readonly Unresolved[];
  /** The views and macros in the catalog; `parsed` counts those within the limit. */
  readonly objects: number;
  readonly parsed: number;
}

/** What the analysis reads from the catalog at a snapshot. */
export interface CatalogObjects {
  readonly schemas: readonly SchemaInfo[];
  /** Tables and views. */
  readonly entries: readonly CatalogEntry[];
  readonly views: readonly ViewInfo[];
  readonly macros: readonly MacroInfo[];
}

export interface BuildOptions {
  /** The most views and macros that are parsed; the others stay in the graph without edges. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

const OBJECT_LIMIT = 2000;
const MAX_SQL_LENGTH = 200_000;

// Catalogs that are never the lake, and schemas with DuckDB's own relations.
const OTHER_CATALOGS = new Set(['system', 'temp', 'memory']);
const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);
const FILE_NAME = /[\\/]|\.(parquet|csv|tsv|json|jsonl|ndjson|gz|zst|db|duckdb|xlsx)$/i;

// The SQL a node is read from: one text per view and per overload of a macro.
interface Body {
  readonly dialect: string;
  readonly sql: string;
  // A scalar macro holds an expression, parsed as the item of a SELECT.
  readonly expression: boolean;
}

// A scalar and a table macro can share a name.
type MacroSlots = Partial<Record<'scalarMacro' | 'tableMacro', number>>;

const rank: Record<NodeKind, number> = { table: 0, view: 1, scalarMacro: 2, tableMacro: 3 };

function compareNodes(a: DependencyNode, b: DependencyNode): number {
  return (
    compareText(lower(a.schema), lower(b.schema)) ||
    compareText(lower(a.name), lower(b.name)) ||
    rank[a.kind] - rank[b.kind] ||
    a.id - b.id
  );
}

function collectNodes(objects: CatalogObjects): {
  readonly nodes: DependencyNode[];
  readonly bodies: ReadonlyMap<DependencyNode, readonly Body[]>;
} {
  const schemaNames = new Map(objects.schemas.map(({ id, name }) => [id, name]));
  const viewOf = new Map(objects.views.map((view) => [view.id, view]));
  const bodies = new Map<DependencyNode, readonly Body[]>();
  const nodes: DependencyNode[] = [];
  for (const { kind, id, schemaId, name } of objects.entries) {
    const view = kind === 'view' ? viewOf.get(id) : undefined;
    const node = { kind, id, schemaId, schema: schemaNames.get(schemaId) ?? '', name };
    nodes.push(node);
    bodies.set(node, view ? [{ dialect: view.dialect, sql: view.sql, expression: false }] : []);
  }
  for (const macro of objects.macros) {
    const expression = macro.kind === 'scalar';
    const node = {
      kind: expression ? ('scalarMacro' as const) : ('tableMacro' as const),
      id: macro.id,
      schemaId: macro.schemaId,
      schema: schemaNames.get(macro.schemaId) ?? '',
      name: macro.name,
    };
    nodes.push(node);
    bodies.set(
      node,
      macro.implementations.map(({ dialect, sql }) => ({ dialect, sql, expression })),
    );
  }
  nodes.sort(compareNodes);
  return { nodes, bodies };
}

interface Names {
  readonly relations: Map<string, Map<string, number>>;
  readonly macros: Map<string, Map<string, MacroSlots>>;
}

function indexNodes(nodes: readonly DependencyNode[]): Names {
  const relations = new Map<string, Map<string, number>>();
  const macros = new Map<string, Map<string, MacroSlots>>();
  for (const [index, node] of nodes.entries()) {
    const schema = lower(node.schema);
    if (node.kind === 'table' || node.kind === 'view') {
      relations.set(
        schema,
        (relations.get(schema) ?? new Map<string, number>()).set(lower(node.name), index),
      );
    } else {
      const byName = macros.get(schema) ?? new Map<string, MacroSlots>();
      byName.set(lower(node.name), { ...byName.get(lower(node.name)), [node.kind]: index });
      macros.set(schema, byName);
    }
  }
  return { relations, macros };
}

interface Findings {
  readonly edges: Map<string, DependencyEdge>;
  readonly broken: Map<string, BrokenReference>;
  readonly unresolved: Map<string, Unresolved>;
}

interface Scope extends Findings {
  readonly from: number;
  readonly node: DependencyNode;
  readonly names: Names;
  readonly lakeSchemas: ReadonlySet<string>;
  readonly builtin: Awaited<ReturnType<SqlParser['functions']>>;
}

function complain(scope: Scope, reason: UnresolvedReason, detail: string): void {
  const { from } = scope;
  scope.unresolved.set(`${from}|${reason}|${detail}`, { node: from, reason, detail });
}

function connect(scope: Scope, to: number, kind: DependencyEdge['kind']): void {
  const { from } = scope;
  scope.edges.set(`${from}|${to}|${kind}`, { from, to, kind });
}

// The schemas that a name without a schema is looked up in, in the order of DuckDB.
function searched(scope: Scope, reference: Reference): string[] {
  if (reference.schema !== '') return [reference.schema];
  return scope.node.kind === 'view' ? [scope.node.schema, 'main'] : ['main'];
}

function find<T>(scope: Scope, table: Map<string, Map<string, T>>, reference: Reference): T | undefined {
  for (const schema of searched(scope, reference)) {
    const found = table.get(lower(schema))?.get(lower(reference.name));
    if (found !== undefined) return found;
  }
  return undefined;
}

// A name without a schema that only the schema of this macro has.
function ownOnly(scope: Scope, reference: Reference): boolean {
  const { node, names } = scope;
  if (node.kind === 'view' || reference.schema !== '') return false;
  const own = lower(node.schema);
  const has =
    reference.kind === 'relation'
      ? names.relations.get(own)?.has(lower(reference.name))
      : names.macros.get(own)?.get(lower(reference.name))?.[reference.kind] !== undefined;
  return has === true;
}

function miss(scope: Scope, reference: Reference): void {
  const schema = reference.kind === 'relation' ? (searched(scope, reference)[0] ?? '') : reference.schema;
  scope.broken.set(`${scope.from}|${reference.kind}|${lower(schema)}|${lower(reference.name)}`, {
    from: scope.from,
    kind: reference.kind,
    schema,
    name: reference.name,
  });
}

function resolveRelation(scope: Scope, reference: Reference): void {
  if (SYSTEM_SCHEMAS.has(lower(reference.schema))) return;
  const catalog = lower(reference.catalog);
  const found = OTHER_CATALOGS.has(catalog) ? undefined : find(scope, scope.names.relations, reference);
  if (found !== undefined) {
    connect(scope, found, 'reads');
  } else if (catalog !== '' && catalog !== LAKE) {
    // DuckLake omits the lake name in a view's text but not in a macro's, whose alias is free.
    // So any other catalog counts as the lake when the lake has the object.
    complain(
      scope,
      'catalog',
      [reference.catalog, reference.schema, reference.name].filter((part) => part !== '').join('.'),
    );
  } else if (!OTHER_CATALOGS.has(catalog) && ownOnly(scope, reference)) {
    complain(scope, 'callerSchema', `${scope.node.schema}.${reference.name}`);
  } else if (reference.schema === '' && scope.builtin.table.has(lower(reference.name))) {
    return; // `FROM duckdb_tables` is a function without parentheses
  } else if (FILE_NAME.test(reference.name)) {
    complain(scope, 'file', reference.name);
  } else {
    miss(scope, reference);
  }
}

function resolveMacro(scope: Scope, reference: Reference & { readonly kind: keyof MacroSlots }): void {
  const catalog = lower(reference.catalog);
  const found = OTHER_CATALOGS.has(catalog)
    ? undefined
    : find(scope, scope.names.macros, reference)?.[reference.kind];
  if (found !== undefined) {
    connect(scope, found, 'calls');
  } else if (!OTHER_CATALOGS.has(catalog) && ownOnly(scope, reference)) {
    complain(scope, 'callerSchema', `${scope.node.schema}.${reference.name}`);
  } else if (
    catalog === '' &&
    (reference.schema === '' || scope.lakeSchemas.has(lower(reference.schema))) &&
    !scope.builtin.all.has(lower(reference.name))
  ) {
    miss(scope, reference);
  }
}

function resolve(scope: Scope, reference: Reference): void {
  if (reference.kind === 'relation') resolveRelation(scope, reference);
  else resolveMacro(scope, { ...reference, kind: reference.kind });
}

async function analyseBody(
  scope: Scope,
  parser: SqlParser,
  body: Body,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (body.dialect !== 'duckdb') return complain(scope, 'dialect', body.dialect);
  if (body.sql.length > MAX_SQL_LENGTH) return complain(scope, 'tooLong', `${body.sql.length} characters`);
  try {
    const extraction = extract(await parser.serialize(body.expression ? `SELECT (${body.sql}\n)` : body.sql));
    if ('reason' in extraction) return complain(scope, extraction.reason, extraction.detail);
    for (const reference of extraction.references) resolve(scope, reference);
    for (const name of extraction.dynamic) complain(scope, 'dynamic', name);
  } catch (error) {
    // One text that DuckDB or the analysis cannot handle must not take the report of the lake down with it.
    signal?.throwIfAborted();
    complain(scope, 'unsupported', messageLine(error instanceof Error ? error.message : String(error)));
  }
}

/**
 * The graph of tables, views and macros; DuckDB parses (never runs) every view and macro to find what it names.
 * Names resolve as in DuckDB: a view looks in its own schema, then `main`; a macro in `main` only.
 */
export async function buildGraph(
  objects: CatalogObjects,
  parser: SqlParser,
  options: BuildOptions = {},
): Promise<DependencyGraph> {
  const { nodes, bodies } = collectNodes(objects);
  const found: Findings = { edges: new Map(), broken: new Map(), unresolved: new Map() };
  const shared = {
    ...found,
    names: indexNodes(nodes),
    lakeSchemas: new Set(objects.schemas.map(({ name }) => lower(name))),
    builtin: await parser.functions(),
  };
  const limit = options.limit ?? OBJECT_LIMIT;
  let parsed = 0;
  let total = 0;
  for (const [from, node] of nodes.entries()) {
    const texts = bodies.get(node) ?? [];
    if (texts.length === 0) continue;
    total++;
    if (parsed >= limit) continue;
    options.signal?.throwIfAborted();
    parsed++;
    const scope: Scope = { ...shared, from, node };
    for (const body of texts) await analyseBody(scope, parser, body, options.signal);
  }
  return {
    nodes,
    edges: [...found.edges.values()],
    broken: [...found.broken.values()],
    unresolved: [...found.unresolved.values()],
    objects: total,
    parsed,
  };
}
