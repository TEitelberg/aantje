// The relations and column references of a statement as DuckDB's parse tree (`json_serialize_sql`) gives them.
import { atClauseOf, locationOf, lower } from '../dependencies/references';
import { isObject } from '../guards';

/** A table or view of a FROM clause as written. */
export interface TreeTable {
  readonly catalog: string;
  readonly schema: string;
  readonly name: string;
  /** The `AT (...)` clause: the snapshot of `VERSION => n`, undefined for any other clause. */
  readonly at: { readonly version: number | undefined } | undefined;
}

/** A relation of a FROM clause; `name` qualifies its columns: the alias, else the name of the table or CTE. */
export type TreeRelation =
  | {
      readonly kind: 'table';
      readonly name: string;
      readonly table: TreeTable;
      readonly renamed: readonly string[];
    }
  | {
      readonly kind: 'query';
      readonly name: string | undefined;
      readonly query: TreeQuery;
      readonly renamed: readonly string[];
    }
  | {
      readonly kind: 'values';
      readonly name: string | undefined;
      readonly width: number;
      readonly renamed: readonly string[];
    }
  /** A table function, PIVOT, a recursive CTE, DESCRIBE: the tree does not tell the columns. */
  | { readonly kind: 'opaque'; readonly name: string | undefined };

/** What a query gives: its select list over its relations; no items when the tree does not tell the columns. */
export interface TreeQuery {
  readonly items: readonly SelectItem[] | undefined;
  readonly relations: readonly TreeRelation[];
}

export type SelectItem =
  | { readonly kind: 'named'; readonly name: string }
  /** `*` or `t.*` with the lower case names that EXCLUDE drops and RENAME gives. */
  | {
      readonly kind: 'star';
      readonly relation: string | undefined;
      readonly exclude: ReadonlySet<string>;
      readonly rename: ReadonlyMap<string, string>;
    }
  /** An expression without an alias (DuckDB makes up its name), `COLUMNS(...)`, a qualified EXCLUDE. */
  | { readonly kind: 'unknown' };

/** The relations of one query and the lower case aliases of its select list. */
export interface TreeScope {
  readonly relations: readonly TreeRelation[];
  readonly aliases: ReadonlySet<string>;
}

/** A column reference: the names as written, its UTF-8 offset in the parsed text, and the queries it can read, innermost first. */
export interface ColumnUse {
  readonly path: readonly string[];
  readonly location: number;
  readonly scopes: readonly TreeScope[];
}

/** The CTEs in scope by lower case name; a recursive one has no known query. */
type Ctes = ReadonlyMap<
  string,
  { readonly query: TreeQuery | undefined; readonly aliases: readonly string[] }
>;

const UNKNOWN: TreeQuery = { items: undefined, relations: [] };

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const texts = (value: unknown): string[] => (Array.isArray(value) ? value.map(text) : []);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The column references of one statement of a `json_serialize_sql` document. */
export function columnUses(statement: unknown): ColumnUse[] {
  const uses: ColumnUse[] = [];
  readQuery(isObject(statement) ? statement['node'] : undefined, [], new Map(), uses);
  return uses;
}

function readQuery(node: unknown, outer: readonly TreeScope[], ctes: Ctes, uses: ColumnUse[]): TreeQuery {
  if (!isObject(node)) return UNKNOWN;
  const visible = readCtes(node, outer, ctes, uses);
  switch (node['type']) {
    case 'SELECT_NODE':
      return readSelect(node, outer, visible, uses);
    case 'SET_OPERATION_NODE': {
      // The ORDER BY of a set operation reads its result: its references are not checked.
      const children = Array.isArray(node['children']) ? node['children'] : [node['left'], node['right']];
      const [first] = children.map((child) => readQuery(child, outer, visible, uses));
      return text(node['setop_type']).endsWith('BY_NAME') ? UNKNOWN : (first ?? UNKNOWN);
    }
    case 'RECURSIVE_CTE_NODE':
      readQuery(node['left'], outer, visible, uses);
      readQuery(node['right'], outer, visible, uses);
      return UNKNOWN;
    default:
      return UNKNOWN;
  }
}

// A CTE sees the ones before it, and itself only when recursive.
function readCtes(
  node: Record<string, unknown>,
  outer: readonly TreeScope[],
  ctes: Ctes,
  uses: ColumnUse[],
): Ctes {
  const map = isObject(node['cte_map']) ? list(node['cte_map']['map']) : [];
  let visible = ctes;
  for (const entry of map) {
    if (!isObject(entry) || !isObject(entry['value'])) continue;
    const name = lower(text(entry['key']));
    const aliases = texts(entry['value']['aliases']);
    const body = entry['value']['query_node'];
    if (isObject(body) && body['type'] === 'RECURSIVE_CTE_NODE') {
      visible = new Map([...visible, [name, { query: undefined, aliases }]]);
      readQuery(body, outer, visible, uses);
    } else {
      const query = readQuery(body, outer, visible, uses);
      visible = new Map([...visible, [name, { query, aliases }]]);
    }
  }
  return visible;
}

const EXPRESSIONS = ['select_list', 'where_clause', 'group_expressions', 'having', 'qualify', 'modifiers'];

// A subquery in FROM sees the relations of its query too (LATERAL): more names in scope only mean fewer warnings.
function readSelect(
  node: Record<string, unknown>,
  outer: readonly TreeScope[],
  ctes: Ctes,
  uses: ColumnUse[],
): TreeQuery {
  const relations: TreeRelation[] = [];
  const scope: TreeScope = { relations, aliases: aliasesOf(node['select_list']) };
  const chain = [scope, ...outer];
  readFrom(node['from_table'], { chain, ctes, uses, relations });
  for (const key of EXPRESSIONS) readExpressions(node[key], chain, ctes, uses);
  return { items: list(node['select_list']).map(selectItem), relations };
}

interface FromEnv {
  readonly chain: readonly TreeScope[];
  readonly ctes: Ctes;
  readonly uses: ColumnUse[];
  readonly relations: TreeRelation[];
}

function readFrom(ref: unknown, env: FromEnv): void {
  if (!isObject(ref)) return;
  const name = text(ref['alias']) || undefined;
  const renamed = texts(ref['column_name_alias']);
  switch (ref['type']) {
    case 'JOIN':
      readFrom(ref['left'], env);
      readFrom(ref['right'], env);
      readExpressions(ref['condition'], env.chain, env.ctes, env.uses);
      return;
    case 'BASE_TABLE':
      env.relations.push(tableRelation(ref, env.ctes));
      return;
    case 'SUBQUERY': {
      const subquery = isObject(ref['subquery']) ? ref['subquery']['node'] : undefined;
      const query = readQuery(subquery, env.chain, env.ctes, env.uses);
      env.relations.push({ kind: 'query', name, query, renamed });
      return;
    }
    case 'EXPRESSION_LIST':
      env.relations.push({ kind: 'values', name, width: list(list(ref['values'])[0]).length, renamed });
      return;
    case 'EMPTY':
      return;
    default:
      env.relations.push({ kind: 'opaque', name });
  }
}

// An unqualified name is a CTE when one of that name is in scope; the CTE's column aliases come after the table's.
function tableRelation(ref: Record<string, unknown>, ctes: Ctes): TreeRelation {
  const table: TreeTable = {
    catalog: text(ref['catalog_name']),
    schema: text(ref['schema_name']),
    name: text(ref['table_name']),
    at: atClauseOf(ref),
  };
  const name = text(ref['alias']) || table.name;
  const renamed = texts(ref['column_name_alias']);
  const cte = table.catalog === '' && table.schema === '' ? ctes.get(lower(table.name)) : undefined;
  if (!cte) return { kind: 'table', name, table, renamed };
  if (!cte.query) return { kind: 'opaque', name };
  return {
    kind: 'query',
    name,
    query: cte.query,
    renamed: [...renamed, ...cte.aliases.slice(renamed.length)],
  };
}

function aliasesOf(selectList: unknown): Set<string> {
  return new Set(
    list(selectList).flatMap((item) =>
      isObject(item) && text(item['alias']) ? [lower(text(item['alias']))] : [],
    ),
  );
}

function selectItem(item: unknown): SelectItem {
  if (!isObject(item)) return { kind: 'unknown' };
  const alias = text(item['alias']);
  if (alias !== '') return { kind: 'named', name: alias };
  if (item['class'] === 'COLUMN_REF') {
    const name = texts(item['column_names']).at(-1);
    return name === undefined ? { kind: 'unknown' } : { kind: 'named', name };
  }
  if (item['class'] !== 'STAR' || item['columns'] === true || item['expr'] !== null)
    return { kind: 'unknown' };
  if (list(item['qualified_exclude_list']).length > 0) return { kind: 'unknown' };
  const rename = new Map<string, string>();
  for (const entry of list(item['rename_list'])) {
    if (isObject(entry) && isObject(entry['key']))
      rename.set(lower(text(entry['key']['column'])), text(entry['value']));
  }
  return {
    kind: 'star',
    relation: text(item['relation_name']) || undefined,
    exclude: new Set(texts(item['exclude_list']).map(lower)),
    rename,
  };
}

// The tree is as deep as the SQL, so a list replaces recursion. A lambda's parameters are no columns: its body is
// not checked. A subquery is a query of its own that sees the scopes around it.
function readExpressions(root: unknown, chain: readonly TreeScope[], ctes: Ctes, uses: ColumnUse[]): void {
  const todo: unknown[] = [root];
  while (todo.length > 0) {
    const value = todo.pop();
    if (Array.isArray(value)) {
      todo.push(...(value as unknown[]));
    } else if (!isObject(value) || value['class'] === 'LAMBDA') {
      continue;
    } else if (value['class'] === 'COLUMN_REF') {
      const location = locationOf(value);
      if (location !== undefined) uses.push({ path: texts(value['column_names']), location, scopes: chain });
    } else if (value['class'] === 'STAR') {
      todo.push(
        ...list(value['replace_list']).map((entry) => (isObject(entry) ? entry['value'] : undefined)),
      );
    } else if (text(value['type']).endsWith('_NODE')) {
      readQuery(value, chain, ctes, uses);
    } else {
      todo.push(...Object.values(value));
    }
  }
}
