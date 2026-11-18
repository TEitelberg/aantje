// The building blocks of the column lineage analysis (`lineage.ts`): the uses of a column, the flow of sources into a
// value, the relations of FROM with their columns, the scopes, and the small readers of DuckDB's parse tree. Pure; the
// page imports the uses from here without the analysis.
import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import { isObject } from '../guards';

export type Json = Record<string, unknown>;

/** How a source column takes part in a view column. */
export const COLUMN_USES = ['direct', 'derived', 'filter', 'join', 'group'] as const;
export type ColumnUse = (typeof COLUMN_USES)[number];

// The uses that decide the rows of a query, not the value of a column.
const ROW_USES: ReadonlySet<ColumnUse> = new Set(['filter', 'join', 'group']);

/** The use of a source seen through a column used as `outer`: a decision on rows stays one, a value is direct only when both are. */
export function composeUse(outer: ColumnUse, inner: ColumnUse): ColumnUse {
  if (ROW_USES.has(outer)) return outer;
  if (ROW_USES.has(inner)) return inner;
  return outer === 'direct' && inner === 'direct' ? 'direct' : 'derived';
}

/** A column of a lake table or view: the index of its node in the dependency graph and its name. */
export interface ColumnKey {
  readonly node: number;
  readonly name: string;
}

export interface ColumnSource {
  readonly key: ColumnKey;
  readonly use: ColumnUse;
}

// The sources of a value, by key and use, and what of it cannot be told.
export class Flow {
  readonly sources = new Map<string, ColumnSource>();
  readonly unknown = new Set<string>();

  static of(key: ColumnKey): Flow {
    const flow = new Flow();
    flow.add({ key, use: 'direct' });
    return flow;
  }

  add(source: ColumnSource): void {
    this.sources.set(`${source.key.node}\u0000${source.key.name}\u0000${source.use}`, source);
  }

  /** Adds what `other` holds as seen through `use`. */
  merge(other: Flow, use: ColumnUse = 'direct'): void {
    for (const { key, use: inner } of other.sources.values()) this.add({ key, use: composeUse(use, inner) });
    for (const detail of other.unknown) this.unknown.add(detail);
  }

  copy(use: ColumnUse = 'direct'): Flow {
    const flow = new Flow();
    flow.merge(this, use);
    return flow;
  }
}

// A column that a relation of FROM offers.
export interface Col {
  readonly name: string;
  readonly flow: Flow;
  readonly carries: ColumnKey | undefined;
}

// A relation of FROM: a lake table or view, a CTE, a subquery, a table function.
export interface Binding {
  /** The name that qualifies its columns: the alias, else the name of the relation. */
  readonly name: string;
  /** A lake relation without an alias: its schema and node, which `schema.table.column` and a rename name. */
  readonly schema: string;
  readonly node: number | undefined;
  /** Undefined when they cannot be told; `why` names the relation then. */
  readonly columns: readonly Col[] | undefined;
  readonly why: string;
  /** What its unknown columns are made of: the columns that the arguments of a table function read. */
  readonly inputs: Flow;
  /** The right side of a SEMI or ANTI join: `*` leaves it out. */
  readonly hidden: boolean;
}

export interface From {
  readonly bindings: readonly Binding[];
  /** The columns that USING and NATURAL joins merge, by folded name: an unqualified name gives them. */
  readonly merged: ReadonlyMap<string, Col>;
  /** A column that a merge stands for in `*` (the left one), or leaves out of it (null, the right one). */
  readonly replaced: ReadonlyMap<Col, Col | null>;
  /** The join conditions, and the rows that the subqueries of FROM decide. */
  readonly rows: Flow;
  /** Why `*` cannot be told: a NATURAL join over a relation of unknown columns. */
  readonly opaque: string | undefined;
}

export interface Result {
  readonly columns: readonly Col[] | undefined;
  readonly why: string;
  /** What decides the rows of the query. */
  readonly rows: Flow;
}

export interface Cte {
  readonly name: string;
  readonly result: () => Result;
}

export interface Scope {
  readonly from: From;
  readonly outer: Scope | undefined;
  readonly ctes: ReadonlyMap<string, Cte>;
  /** The select items of the query by folded alias, which WHERE, GROUP BY and HAVING may name. */
  readonly aliases: ReadonlyMap<string, Flow>;
  /** Lambda parameters in reach, folded. */
  readonly lambdas: ReadonlySet<string>;
}

export type Found =
  | {
      readonly kind: 'column';
      readonly col: Col;
      readonly binding: Binding | undefined;
      /** The number of parts before the column: 0 unqualified, 1 `t.a`, 2 `s.t.a`. */
      readonly qualifier: number;
      /** A field of a struct column (`a.f`): its value is derived from the column. */
      readonly field: boolean;
    }
  | { readonly kind: 'unknown'; readonly detail: string; readonly inputs: Flow }
  | { readonly kind: 'flow'; readonly flow: Flow };

export const EMPTY_FROM: From = {
  bindings: [],
  merged: new Map(),
  replaced: new Map(),
  rows: new Flow(),
  opaque: undefined,
};

export const text = (value: unknown): string => (typeof value === 'string' ? value : '');
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const field = (value: unknown, name: string): unknown => (isObject(value) ? value[name] : undefined);

export const unknownResult = (why: string, rows = new Flow()): Result => ({ columns: undefined, why, rows });

/** Names as DuckDB gives them to the columns of a query: a name taken before, ignoring case, gets `_1`, `_2`, ... */
export function deduplicated(columns: readonly Col[]): Col[] {
  const taken = new Set<string>();
  return columns.map((col) => {
    let name = col.name;
    for (let suffix = 1; taken.has(foldIdentifier(name)); suffix++) name = `${col.name}_${suffix}`;
    taken.add(foldIdentifier(name));
    return name === col.name ? col : { name, flow: col.flow, carries: undefined };
  });
}

/** The first columns named anew by an alias list (`v(a, b)`, `t AS x(a, b)`): they carry no name any more. */
export function aliased(columns: readonly Col[], aliases: readonly string[]): Col[] {
  return columns.map((col, index) => {
    const alias = aliases[index];
    return alias === undefined || alias === '' ? col : { name: alias, flow: col.flow, carries: undefined };
  });
}

// The parameters of a lambda: the names on its left side.
export function lambdaNames(lhs: unknown): string[] {
  const names: string[] = [];
  const todo = [lhs];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    if (Array.isArray(at)) todo.push(...(at as unknown[]));
    else if (isObject(at)) {
      if (at['class'] === 'COLUMN_REF') names.push(...list(at['column_names']).map(text).slice(0, 1));
      else todo.push(...Object.values(at));
    }
  }
  return names.map(foldIdentifier);
}

// A FROM of one relation.
export const single = (binding: Binding, rows: Flow): From => ({
  bindings: [binding],
  merged: new Map(),
  replaced: new Map(),
  rows,
  opaque: undefined,
});

export const opaqueBinding = (name: string, why: string, inputs: Flow): Binding => ({
  name,
  schema: '',
  node: undefined,
  columns: undefined,
  why,
  inputs,
  hidden: false,
});

// A relation over the result of a query (a CTE or a subquery) under its name.
export const over = (name: string, result: Result, aliases: readonly string[]): Binding => ({
  name,
  schema: '',
  node: undefined,
  columns: result.columns && aliased(result.columns, aliases),
  why: result.why,
  inputs: new Flow(),
  hidden: false,
});

// The relations of two FROM parts together, which the right one may name.
export const joined = (a: From, b: From): From =>
  a.bindings.length === 0
    ? b
    : {
        bindings: [...a.bindings, ...b.bindings],
        merged: new Map([...a.merged, ...b.merged]),
        replaced: new Map([...a.replaced, ...b.replaced]),
        rows: new Flow(),
        opaque: a.opaque ?? b.opaque,
      };

// The column of one side of a join by its name: a merged one first.
export function lookup(from: From, name: string): Col | undefined {
  return (
    from.merged.get(foldIdentifier(name)) ??
    from.bindings.flatMap((binding) => binding.columns ?? []).find((col) => sameIdentifier(col.name, name))
  );
}

// The names that both sides of a NATURAL join have.
export function commonNames(left: From, right: From): string[] {
  const names = (from: From): string[] => [
    ...[...from.merged.values()].map((col) => col.name),
    ...from.bindings.flatMap((binding) => binding.columns ?? []).map((col) => col.name),
  ];
  const others = new Set(names(right).map(foldIdentifier));
  const common = names(left).filter((name) => others.has(foldIdentifier(name)));
  return [...new Map(common.map((name) => [foldIdentifier(name), name])).values()];
}

// Whether an expression holds `COLUMNS(...)` or `*`, which DuckDB expands into several items.
export function hasColumnsStar(expression: Json): boolean {
  const todo: unknown[] = [expression];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    if (Array.isArray(at)) todo.push(...(at as unknown[]));
    else if (isObject(at)) {
      if (at['class'] === 'STAR' && (at['columns'] === true || at['unpacked'] === true)) return true;
      // A subquery has items of its own.
      if (at['class'] !== 'SUBQUERY') todo.push(...Object.values(at));
    }
  }
  return false;
}

// The column that `*` gives for a column of a relation: the merge that stands for it, none, or the column itself.
export function standing(from: From, col: Col): Col | undefined {
  let current: Col = col;
  for (let hops = 0; hops < 64 && from.replaced.has(current); hops++) {
    const next = from.replaced.get(current);
    if (next === null || next === undefined) return undefined;
    current = next;
  }
  return current;
}

// `GROUP BY 2`: the position of a select item.
export function positionOf(constant: Json): number | undefined {
  const literal = field(constant, 'literal');
  const value = text(field(literal, 'text'));
  return /^\d+$/.test(value) && field(literal, 'kind') !== 'STRING' ? Number(value) : undefined;
}

/** The EXCLUDE, REPLACE and RENAME lists of a `*`, by folded column name. */
export function starModifiers(item: Json): {
  readonly exclude: ReadonlySet<string>;
  readonly replace: ReadonlyMap<string, unknown>;
  readonly rename: ReadonlyMap<string, string>;
} {
  return {
    exclude: new Set([
      ...list(item['exclude_list']).map((name) => foldIdentifier(text(name))),
      ...list(item['qualified_exclude_list']).map((entry) => foldIdentifier(text(field(entry, 'column')))),
    ]),
    replace: new Map(
      list(item['replace_list']).map((entry) => [
        foldIdentifier(text(field(entry, 'key'))),
        field(entry, 'value'),
      ]),
    ),
    rename: new Map(
      list(item['rename_list']).map((entry) => [
        foldIdentifier(text(field(field(entry, 'key'), 'column'))),
        text(field(entry, 'value')),
      ]),
    ),
  };
}

/** The select items without an alias at every level of a statement, whose names DuckDB has to give. */
export function unnamedItems(statement: unknown): Json[] {
  const found: Json[] = [];
  const todo: unknown[] = [statement];
  for (let at = todo.pop(); at !== undefined; at = todo.pop()) {
    if (Array.isArray(at)) {
      todo.push(...(at as unknown[]));
      continue;
    }
    if (!isObject(at)) continue;
    if (at['type'] === 'SELECT_NODE') {
      for (const item of list(at['select_list'])) {
        if (
          isObject(item) &&
          text(item['alias']) === '' &&
          item['class'] !== 'COLUMN_REF' &&
          item['class'] !== 'STAR'
        ) {
          found.push(item);
        }
      }
    }
    todo.push(...Object.values(at).filter((child) => typeof child === 'object' && child !== null));
  }
  return found;
}

/** Names that two relations of one FROM offer, which DuckDB refuses. */
export interface Counter {
  ambiguous: number;
}

// A name in this scope, then a select alias, then in the scopes around it (a correlated subquery).
export function resolve(parts: readonly string[], scope: Scope, count: Counter): Found | undefined {
  for (let at: Scope | undefined = scope; at; at = at.outer) {
    const found = resolveIn(parts, at.from, count);
    if (found) return found;
    const alias =
      parts.length === 1 && parts[0] !== undefined ? at.aliases.get(foldIdentifier(parts[0])) : undefined;
    if (alias) return { kind: 'flow', flow: alias };
  }
  return undefined;
}

// Longest qualifier first, as DuckDB binds: `s.t.c` before `t.c.f`, `t.c` before the field `c.f`.
function resolveIn(parts: readonly string[], from: From, count: Counter): Found | undefined {
  for (let qualifier = Math.min(3, parts.length - 1); qualifier >= 1; qualifier--) {
    const binding = qualified(from, parts.slice(0, qualifier), count);
    const name = parts[qualifier];
    if (!binding || name === undefined) continue;
    if (!binding.columns) {
      return { kind: 'unknown', detail: `a column of ${binding.why}`, inputs: binding.inputs };
    }
    const col = binding.columns.find((candidate) => sameIdentifier(candidate.name, name));
    if (col) return { kind: 'column', col, binding, qualifier, field: parts.length > qualifier + 1 };
  }
  const [name] = parts;
  if (name === undefined) return undefined;
  const merged = from.merged.get(foldIdentifier(name));
  if (merged)
    return { kind: 'column', col: merged, binding: undefined, qualifier: 0, field: parts.length > 1 };
  const matches = from.bindings.flatMap((binding) =>
    (binding.columns ?? []).filter((col) => sameIdentifier(col.name, name)).map((col) => ({ binding, col })),
  );
  if (matches.length > 1) count.ambiguous++;
  const [match] = matches;
  if (match) return { kind: 'column', ...match, qualifier: 0, field: parts.length > 1 };
  const unknown = from.bindings.filter((binding) => !binding.columns);
  if (unknown.length > 0) {
    const inputs = new Flow();
    for (const binding of unknown) inputs.merge(binding.inputs);
    return {
      kind: 'unknown',
      detail: `a column of ${unknown.map((binding) => binding.why).join(' or ')}`,
      inputs,
    };
  }
  // A relation named as a column is its whole row.
  const whole =
    parts.length === 1 ? from.bindings.find((binding) => sameIdentifier(binding.name, name)) : undefined;
  if (whole?.columns) {
    const flow = new Flow();
    for (const col of whole.columns) flow.merge(col.flow, 'derived');
    return { kind: 'flow', flow };
  }
  return undefined;
}

// The relation of FROM that a qualifier names: `t`, `s.t` or `c.s.t` (the catalog is not compared).
export function qualified(from: From, qualifier: readonly string[], count: Counter): Binding | undefined {
  const [first, second, third] = qualifier;
  if (first === undefined) return undefined;
  if (second === undefined) {
    const matches = from.bindings.filter((binding) => sameIdentifier(binding.name, first));
    if (matches.length > 1) count.ambiguous++;
    return matches[0];
  }
  const [schema, name] = third === undefined ? [first, second] : [second, third];
  return from.bindings.find(
    (binding) =>
      binding.node !== undefined &&
      sameIdentifier(binding.schema, schema) &&
      sameIdentifier(binding.name, name),
  );
}
