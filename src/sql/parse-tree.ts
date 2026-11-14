// The readers of DuckDB's parse tree (`json_serialize_sql`) that the SQL editor's name check and the dependencies report
// share: what a statement names, where a relation stands and the snapshot it reads. They only read the document, which
// is as deep as the SQL: a list replaces recursion.
import { foldIdentifier } from '../catalog/ddl';
import { isObject } from '../guards';

/** What a statement names: a table or view after FROM, or a function that may be a macro. */
export interface Reference {
  readonly kind: 'relation' | 'scalarMacro' | 'tableMacro';
  /** As written; empty when the name has no catalog. */
  readonly catalog: string;
  /** As written; empty when the name has no schema. */
  readonly schema: string;
  readonly name: string;
  /** Of a relation: the UTF-8 byte offset of its name in the parsed text, when DuckDB reports one. */
  readonly location?: number;
  /** Of a relation with an `AT (...)` clause: the snapshot of `VERSION => n`; undefined for any other clause. */
  readonly at?: { readonly version: number | undefined };
}

export interface References {
  readonly references: readonly Reference[];
  /** Functions such as `query_table` whose target is only known at run time. */
  readonly dynamic: readonly string[];
}

const DYNAMIC = new Set(['query_table', 'query']);

interface Found {
  readonly references: Reference[];
  readonly dynamic: Set<string>;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The `query_location` of a node; DuckDB writes an unknown one as the largest 64-bit number. */
export function locationOf(node: Record<string, unknown>): number | undefined {
  const location = node['query_location'];
  return typeof location === 'number' && Number.isSafeInteger(location) ? location : undefined;
}

/** The `at_clause` of a table reference: the snapshot of `AT (VERSION => n)`, undefined for any other clause. */
export function atClauseOf(node: Record<string, unknown>): Reference['at'] {
  const clause = node['at_clause'];
  if (!isObject(clause)) return undefined;
  const value =
    isObject(clause['expr']) && clause['expr']['class'] === 'CONSTANT' ? clause['expr'] : undefined;
  const literal = value && isObject(value['literal']) ? text(value['literal']['text']) : '';
  return { version: clause['unit'] === 'VERSION' && /^\d+$/.test(literal) ? Number(literal) : undefined };
}

// Where a relation stands and the snapshot it names; the keys are left out when the tree has neither.
function placeOf(node: Record<string, unknown>): Pick<Reference, 'location' | 'at'> {
  const location = locationOf(node);
  const at = atClauseOf(node);
  return { ...(location === undefined ? {} : { location }), ...(at ? { at } : {}) };
}

// A part of the document still to be read, with the CTE names in scope and a table-function flag.
interface Pending {
  readonly value: unknown;
  readonly scope: ReadonlySet<string>;
  readonly tableFunction: boolean;
}

// Adds the CTE names of `node` to those in scope and queues their queries. The document is as deep as the SQL,
// so a list replaces recursion.
function enter(
  node: Record<string, unknown>,
  scope: ReadonlySet<string>,
  queries: Pending[],
): ReadonlySet<string> {
  const map =
    isObject(node['cte_map']) && Array.isArray(node['cte_map']['map']) ? node['cte_map']['map'] : [];
  let visible = scope;
  for (const entry of map) {
    const query = isObject(entry) && isObject(entry['value']) ? entry['value']['query_node'] : undefined;
    const name = isObject(entry) ? foldIdentifier(text(entry['key'])) : '';
    // A CTE sees the earlier ones, and itself only when recursive; elsewhere its name is a real table.
    const own =
      isObject(query) && query['type'] === 'RECURSIVE_CTE_NODE' ? new Set([...visible, name]) : visible;
    queries.push({ value: query, scope: own, tableFunction: false });
    visible = new Set([...visible, name]);
  }
  return visible;
}

function walk(root: unknown, found: Found): void {
  const todo: Pending[] = [{ value: root, scope: new Set(), tableFunction: false }];
  for (let at = todo.pop(); at; at = todo.pop()) {
    const { value, scope, tableFunction } = at;
    if (Array.isArray(value)) {
      for (const item of value.toReversed()) {
        todo.push({ value: item, scope, tableFunction: false });
      }
      continue;
    }
    if (!isObject(value)) {
      continue;
    }
    const next: Pending[] = [];
    const visible = enter(value, scope, next);
    if (value['type'] === 'BASE_TABLE') {
      const name = text(value['table_name']);
      const catalog = text(value['catalog_name']);
      const schema = text(value['schema_name']);
      if (catalog !== '' || schema !== '' || !visible.has(foldIdentifier(name))) {
        found.references.push({ kind: 'relation', catalog, schema, name, ...placeOf(value) });
      }
      continue;
    }
    const call = text(value['function_name']);
    if (call !== '' && (value['class'] === 'FUNCTION' || value['class'] === 'WINDOW')) {
      found.references.push({
        kind: tableFunction ? 'tableMacro' : 'scalarMacro',
        catalog: text(value['catalog']),
        schema: text(value['schema']),
        name: call,
      });
      if (DYNAMIC.has(foldIdentifier(call))) {
        found.dynamic.add(foldIdentifier(call));
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'cte_map') {
        next.push({
          value: child,
          scope: visible,
          tableFunction: value['type'] === 'TABLE_FUNCTION' && key === 'function',
        });
      }
    }
    for (const item of next.toReversed()) {
      todo.push(item);
    }
  }
}

/** What one statement of a `json_serialize_sql` document names, CTEs left out. */
export function statementReferences(statement: unknown): References {
  const found: Found = { references: [], dynamic: new Set() };
  walk(statement, found);
  return { references: found.references, dynamic: [...found.dynamic] };
}
