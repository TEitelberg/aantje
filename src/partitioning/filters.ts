// The columns of one table that the queries of the Query History filter on, read from DuckDB's parse tree
// (`json_serialize_sql`): equality, range, join and other predicates of WHERE and JOIN ON. The tree is as deep as the
// SQL, so lists replace recursion.
import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import { LAKE } from '../data/attach';
import { isObject } from '../guards';

/** How a predicate uses a column: `x = 1`, `x IN (...)`; `x < 1`, `BETWEEN`; `a.x = b.y`; anything else. */
export type FilterKind = 'equality' | 'range' | 'join' | 'other';

/** How the queries use one column of the table in their filters. */
export interface FilterUse {
  /** The queries that filter on the column. */
  readonly queries: number;
  /** The queries that use it in a predicate of each kind. */
  readonly equality: number;
  readonly range: number;
  readonly join: number;
  readonly other: number;
}

/** The table whose filters are wanted, and its top-level columns. */
export interface FilterTarget {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly string[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const COMPARISON_KIND: Readonly<Record<string, FilterKind>> = {
  COMPARE_EQUAL: 'equality',
  COMPARE_NOT_DISTINCT_FROM: 'equality',
  COMPARE_LESSTHAN: 'range',
  COMPARE_GREATERTHAN: 'range',
  COMPARE_LESSTHANOREQUALTO: 'range',
  COMPARE_GREATERTHANOREQUALTO: 'range',
};

// The scope of one SELECT: the names under which the table is in its FROM.
interface Scope {
  readonly names: ReadonlySet<string>;
}

/** Whether a table reference names the target: catalog `lake` or none, schema `main` when it names none. */
function namesTarget(ref: Record<string, unknown>, target: FilterTarget): boolean {
  const catalog = text(ref['catalog_name']);
  const schema = text(ref['schema_name']) || 'main';
  return (
    (catalog === '' || sameIdentifier(catalog, LAKE)) &&
    sameIdentifier(schema, target.schema) &&
    sameIdentifier(text(ref['table_name']), target.name)
  );
}

// The relations of a FROM clause: the names of the target, the join conditions and the
// subqueries, which are queries of their own.
function readFrom(
  from: unknown,
  target: FilterTarget,
): { names: Set<string>; conditions: unknown[]; queries: unknown[] } {
  const found = { names: new Set<string>(), conditions: [] as unknown[], queries: [] as unknown[] };
  const todo: unknown[] = [from];
  for (let ref = todo.pop(); ref !== undefined; ref = todo.pop()) {
    if (!isObject(ref)) continue;
    switch (ref['type']) {
      case 'JOIN':
        todo.push(ref['left'], ref['right']);
        found.conditions.push(ref['condition']);
        break;
      case 'BASE_TABLE':
        if (namesTarget(ref, target))
          found.names.add(foldIdentifier(text(ref['alias']) || text(ref['table_name'])));
        break;
      case 'SUBQUERY':
        found.queries.push(isObject(ref['subquery']) ? ref['subquery']['node'] : undefined);
        break;
      default:
        break;
    }
  }
  return found;
}

/** The column of the target that a reference names in the scope; undefined for another relation's column. */
function columnOf(names: readonly string[], scope: Scope, target: FilterTarget): string | undefined {
  if (scope.names.size === 0) return undefined;
  const column =
    names.length === 1
      ? names[0]
      : names.length === 2 && scope.names.has(foldIdentifier(names[0] ?? ''))
        ? names[1]
        : undefined;
  // An unqualified name is the target's when the target has such a column.
  return column === undefined
    ? undefined
    : target.columns.find((candidate) => sameIdentifier(candidate, column));
}

// Whether an expression holds a column reference, not counting subqueries.
function hasColumn(expression: unknown): boolean {
  const todo: unknown[] = [expression];
  for (let node = todo.pop(); node !== undefined; node = todo.pop()) {
    if (Array.isArray(node)) todo.push(...(node as unknown[]));
    else if (isObject(node) && node['class'] !== 'SUBQUERY') {
      if (node['class'] === 'COLUMN_REF') return true;
      todo.push(...Object.values(node));
    }
  }
  return false;
}

// The kind of the predicate an expression is, for the columns below it; undefined when it only passes the kind on.
function kindOf(node: Record<string, unknown>, outer: FilterKind | undefined): FilterKind | undefined {
  const type = text(node['type']);
  if (node['class'] === 'COMPARISON') {
    if (hasColumn(node['left']) && hasColumn(node['right'])) return 'join';
    return COMPARISON_KIND[type] ?? 'other';
  }
  if (node['class'] === 'BETWEEN') return 'range';
  if (type === 'COMPARE_IN') return outer === 'other' ? 'other' : 'equality';
  if (type === 'OPERATOR_NOT' || type === 'COMPARE_NOT_IN') return 'other';
  if (node['class'] === 'FUNCTION' && outer === undefined) return 'other';
  return outer;
}

/** Walks a predicate and records the target's columns with the kind of predicate they stand in; collects subqueries. */
function readPredicate(
  root: unknown,
  scope: Scope,
  target: FilterTarget,
  seen: Map<string, Set<FilterKind>>,
  queries: unknown[],
  join = false,
): void {
  const todo: { node: unknown; kind: FilterKind | undefined }[] = [
    { node: root, kind: join ? 'join' : undefined },
  ];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    const { node, kind } = at;
    if (Array.isArray(node)) {
      todo.push(...(node as unknown[]).map((child) => ({ node: child, kind })));
      continue;
    }
    if (!isObject(node)) continue;
    if (node['class'] === 'SUBQUERY') {
      queries.push(isObject(node['subquery']) ? node['subquery']['node'] : undefined);
      continue;
    }
    if (node['class'] === 'COLUMN_REF') {
      const column = columnOf(list(node['column_names']).map(text), scope, target);
      if (column !== undefined) {
        const kinds = seen.get(column) ?? new Set<FilterKind>();
        kinds.add(kind ?? (join ? 'join' : 'other'));
        seen.set(column, kinds);
      }
      continue;
    }
    const next = kindOf(node, kind);
    todo.push(...Object.values(node).map((child) => ({ node: child, kind: next })));
  }
}

/** The kinds of filter that one statement of a parse document uses on each column of the target. */
export function statementFilters(statement: unknown, target: FilterTarget): Map<string, Set<FilterKind>> {
  const seen = new Map<string, Set<FilterKind>>();
  const queries: unknown[] = [isObject(statement) ? statement['node'] : undefined];
  for (let node = queries.pop(); node !== undefined; node = queries.pop()) {
    if (!isObject(node)) continue;
    const ctes = isObject(node['cte_map']) ? list(node['cte_map']['map']) : [];
    for (const entry of ctes) {
      if (isObject(entry) && isObject(entry['value'])) queries.push(entry['value']['query_node']);
    }
    if (node['type'] === 'SELECT_NODE') {
      const from = readFrom(node['from_table'], target);
      queries.push(...from.queries);
      const scope: Scope = { names: from.names };
      readPredicate(node['where_clause'], scope, target, seen, queries);
      for (const condition of from.conditions) readPredicate(condition, scope, target, seen, queries, true);
      // Subqueries in the select list or HAVING are queries of their own.
      readPredicate(node['select_list'], { names: new Set() }, target, seen, queries);
    } else {
      queries.push(node['left'], node['right'], ...list(node['children']));
    }
  }
  return seen;
}

/** Sums the filters of the statements of parse documents (one per statement of the history) per column. */
export function filterUses(
  documents: readonly unknown[],
  target: FilterTarget,
): { readonly uses: ReadonlyMap<string, FilterUse>; readonly queries: number } {
  const uses = new Map<
    string,
    { queries: number; equality: number; range: number; join: number; other: number }
  >();
  let queries = 0;
  for (const document of documents) {
    if (!isObject(document) || document['error'] === true) continue;
    for (const statement of list(document['statements'])) {
      const seen = statementFilters(statement, target);
      if (seen.size > 0) queries++;
      for (const [column, kinds] of seen) {
        const use = uses.get(column) ?? { queries: 0, equality: 0, range: 0, join: 0, other: 0 };
        use.queries++;
        for (const kind of kinds) use[kind]++;
        uses.set(column, use);
      }
    }
  }
  return { uses, queries };
}
