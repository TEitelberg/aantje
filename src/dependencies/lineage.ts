// Column lineage of one view or macro body, read from DuckDB's parse tree (`json_serialize_sql`): for each output column
// the columns of the tables and views it is built from and how it uses them, and every place where the text names a
// lake relation or column, which a rename changes. Names resolve as DuckDB's binder resolves them, as far as the tree
// tells. What it cannot tell (a column of a table function, a name built at run time) is an unknown source, never a
// guess. The analysis follows the nesting of the query; a text nested deeper than the stack allows throws, and the
// caller counts the body as one whose columns cannot be told.
import { foldIdentifier } from '../catalog/ddl';
import { isObject } from '../guards';
import { atClauseOf, locationOf } from '../sql/parse-tree';
import type { Reference } from '../sql/parse-tree';
import {
  aliased,
  commonNames,
  composeUse,
  deduplicated,
  EMPTY_FROM,
  field,
  Flow,
  hasColumnsStar,
  joined,
  lambdaNames,
  list,
  lookup,
  opaqueBinding,
  over,
  positionOf,
  qualified,
  resolve,
  single,
  standing,
  starModifiers,
  text,
  unknownResult,
} from './lineage-scope';
import type {
  Binding,
  Col,
  ColumnKey,
  ColumnSource,
  ColumnUse,
  Cte,
  Found,
  From,
  Json,
  Result,
  Scope,
} from './lineage-scope';

export type { ColumnKey, ColumnSource, ColumnUse } from './lineage-scope';

/** What the analysis knows of the lake while it reads one body. */
export interface LineageEnv {
  /** The lake table or view that a name after FROM stands for, as the dependency graph resolves it; undefined for none. */
  relation(reference: Reference): number | undefined;
  /** The schema and name of a lake table or view. */
  named(node: number): { readonly schema: string; readonly name: string };
  /** The columns of a lake table or view in their order; undefined when the analysis cannot tell them. */
  columns(node: number): readonly string[] | undefined;
  /** The name DuckDB gives a select item without an alias (`(a * 2)`, `sum(b)`); undefined when it is not known. */
  name(expression: Json): string | undefined;
  /** The macro of a call, with its name, when its value depends on more than its arguments: it reads tables. */
  readingCall?(call: Reference): string | undefined;
  /** The parameters of a macro, folded; empty for a view. */
  readonly params: ReadonlySet<string>;
}

/** An output column: its name, its sources one level down and what of it cannot be told. */
export interface OutputColumn {
  readonly name: string;
  readonly sources: readonly ColumnSource[];
  /** What a part of its value comes from where the analysis cannot name a column: `a column of the table function range`. */
  readonly unknown: readonly string[];
  /** The lake column whose name it carries (`a`, `t.a`, `*` without an alias): a rename of that column renames it. */
  readonly carries: ColumnKey | undefined;
}

/**
 * A place in the text that names something of the lake, for a rename; `location` is the UTF-8 byte offset of the name
 * in the parsed text, and `part` the index of the name in a dotted one (`shop.events.id`: 0, 1, 2).
 */
export type Mention =
  /** After FROM: a lake table or view; its name is the last part. */
  | { readonly kind: 'relation'; readonly node: number; readonly location: number }
  /** A column or `*` qualified by the name of a lake table or view that has no alias. */
  | { readonly kind: 'qualifier'; readonly node: number; readonly location: number; readonly part: number }
  /** A column by its name, or by a name that a subquery or CTE carries from it. */
  | { readonly kind: 'column'; readonly key: ColumnKey; readonly location: number; readonly part: number }
  /** A column named where the analysis cannot change the name: `USING`, `NATURAL`, `EXCLUDE`, `REPLACE`, `RENAME`. */
  | { readonly kind: 'fixed'; readonly key: ColumnKey; readonly detail: string }
  /** A name that no relation of the analysis has: a column of a table function, of the caller of a macro, or a typo. */
  | { readonly kind: 'unresolved'; readonly name: string };

export interface BodyLineage {
  /** The output columns; undefined when they cannot be told, and `opaque` says why. */
  readonly columns: readonly OutputColumn[] | undefined;
  readonly opaque: string | undefined;
  readonly mentions: readonly Mention[];
  /** Names that two relations of one FROM offer, which DuckDB refuses; a rename that adds one breaks the text. */
  readonly ambiguous: number;
}

class Analysis {
  readonly mentions: Mention[] = [];
  ambiguous = 0;

  constructor(private readonly env: LineageEnv) {}

  query(node: unknown, outer: Scope | undefined, ctes: ReadonlyMap<string, Cte>): Result {
    if (!isObject(node)) return unknownResult('a query that the analysis does not read');
    const own = this.ctes(node, outer, ctes);
    let result: Result;
    switch (node['type']) {
      case 'SELECT_NODE':
        result = this.select(node, outer, own.visible);
        break;
      case 'SET_OPERATION_NODE':
        result = this.setOperation(node, outer, own.visible);
        break;
      case 'RECURSIVE_CTE_NODE':
        result = this.recursive(node, outer, own.visible, undefined);
        break;
      default:
        result = unknownResult(`a query of the kind ${text(node['type']).toLowerCase()}`);
    }
    // A CTE that the query never reads still names columns, which a rename changes.
    for (const cte of own.defined) cte.result();
    return result;
  }

  // The CTEs of a query: each sees the ones before it, and itself only when recursive. Read once, when first named.
  private ctes(
    node: Json,
    outer: Scope | undefined,
    visible: ReadonlyMap<string, Cte>,
  ): { readonly visible: ReadonlyMap<string, Cte>; readonly defined: readonly Cte[] } {
    const defined: Cte[] = [];
    let scope = visible;
    for (const entry of list(field(node['cte_map'], 'map'))) {
      const value = field(entry, 'value');
      if (!isObject(value)) continue;
      const name = text(field(entry, 'key'));
      const aliases = list(value['aliases']).map(text);
      const query = value['query_node'];
      const before = scope;
      let done: Result | undefined;
      const cte: Cte = {
        name,
        result: () => {
          if (!done) {
            // A CTE that reaches itself without RECURSIVE has no columns to give.
            done = unknownResult(`the CTE ${name}`);
            const read =
              isObject(query) && query['type'] === 'RECURSIVE_CTE_NODE'
                ? this.recursive(query, outer, before, { name, aliases })
                : this.query(query, outer, before);
            done = read.columns ? { ...read, columns: aliased(read.columns, aliases) } : read;
          }
          return done;
        },
      };
      defined.push(cte);
      scope = new Map([...scope, [foldIdentifier(name), cte]]);
    }
    return { visible: scope, defined };
  }

  // A recursive CTE: the anchor gives the columns, which the recursive part reads as the CTE.
  private recursive(
    node: Json,
    outer: Scope | undefined,
    ctes: ReadonlyMap<string, Cte>,
    self: { readonly name: string; readonly aliases: readonly string[] } | undefined,
  ): Result {
    const anchor = this.query(node['left'], outer, ctes);
    const named: Result = anchor.columns
      ? { ...anchor, columns: aliased(anchor.columns, self?.aliases ?? []) }
      : anchor;
    const own = self
      ? new Map([...ctes, [foldIdentifier(self.name), { name: self.name, result: () => named }]])
      : ctes;
    return this.combine('UNION', [named, this.query(node['right'], outer, own)]);
  }

  private setOperation(node: Json, outer: Scope | undefined, ctes: ReadonlyMap<string, Cte>): Result {
    const children = list(node['children']);
    const parts = (children.length > 0 ? children : [node['left'], node['right']]).map((child) =>
      this.query(child, outer, ctes),
    );
    return this.combine(text(node['setop_type']), parts);
  }

  // UNION gives the values of every part; INTERSECT and EXCEPT take the values of the first, the others decide the rows.
  private combine(kind: string, parts: readonly Result[]): Result {
    const rows = new Flow();
    for (const part of parts) rows.merge(part.rows);
    const unknown = parts.find((part) => !part.columns);
    const [first] = parts;
    if (!first?.columns || unknown) return unknownResult(unknown?.why ?? 'an empty set operation', rows);
    const use = (index: number): ColumnUse => (index === 0 || kind.startsWith('UNION') ? 'direct' : 'filter');
    if (kind === 'UNION_BY_NAME') {
      const columns = new Map<string, { name: string; flow: Flow; carries: ColumnKey | undefined }>();
      parts.forEach((part, index) => {
        for (const col of part.columns ?? []) {
          const known = columns.get(foldIdentifier(col.name));
          const entry = known ?? { name: col.name, flow: new Flow(), carries: undefined };
          entry.flow.merge(col.flow, use(index));
          columns.set(foldIdentifier(col.name), entry);
        }
      });
      return { columns: [...columns.values()], why: '', rows };
    }
    if (parts.some((part) => part.columns?.length !== first.columns?.length)) {
      return unknownResult('a set operation whose parts have different columns', rows);
    }
    const columns = first.columns.map((col, at) => {
      const flow = new Flow();
      parts.forEach((part, index) => {
        const other = part.columns?.[at];
        if (other) flow.merge(other.flow, use(index));
      });
      return { name: col.name, flow, carries: col.carries };
    });
    return { columns, why: '', rows };
  }

  private select(node: Json, outer: Scope | undefined, ctes: ReadonlyMap<string, Cte>): Result {
    const from = this.from(node['from_table'], outer, ctes, EMPTY_FROM);
    // An item may name the alias of an item before it (`a + 1 AS x, x * 2 AS y`), after the columns of FROM.
    const aliases = new Map<string, Flow>();
    const scope: Scope = { from, outer, ctes, aliases, lambdas: new Set() };
    let opaque: string | undefined;
    const values: Col[] = [];
    const plain: Flow[] = [];
    for (const item of list(node['select_list']).filter(isObject)) {
      const made = this.item(item, scope);
      if (typeof made === 'string') {
        opaque ??= made;
        continue;
      }
      values.push(...made);
      const [first] = made;
      if (item['class'] === 'COLUMN_REF' && first) plain.push(first.flow);
      const alias = text(item['alias']);
      if (alias !== '' && first) aliases.set(foldIdentifier(alias), first.flow);
    }
    const rows = this.rows(node, scope, values, plain);
    if (opaque) return unknownResult(opaque, rows);
    const columns = deduplicated(values).map((col) => {
      const flow = col.flow.copy();
      flow.merge(rows);
      return { name: col.name, flow, carries: col.carries };
    });
    return { columns, why: '', rows };
  }

  // What decides the rows of a SELECT: FROM's joins and subqueries, WHERE, GROUP BY, HAVING, QUALIFY, DISTINCT ON, and an
  // ORDER BY that a LIMIT cuts.
  private rows(node: Json, scope: Scope, values: readonly Col[], plain: readonly Flow[]): Flow {
    const rows = new Flow();
    rows.merge(scope.from.rows);
    this.expression(node['where_clause'], scope, 'filter', rows);
    for (const group of list(node['group_expressions'])) {
      const position = isObject(group) && group['class'] === 'CONSTANT' ? positionOf(group) : undefined;
      const item = position === undefined ? undefined : values[position - 1];
      if (item) rows.merge(item.flow, 'group');
      else this.expression(group, scope, 'group', rows);
    }
    // GROUP BY ALL groups by the items without an aggregate; a plain column is surely one of them.
    if (node['aggregate_handling'] === 'FORCE_AGGREGATES') {
      for (const flow of plain) rows.merge(flow, 'group');
    }
    this.expression(node['having'], scope, 'filter', rows);
    this.expression(node['qualify'], scope, 'filter', rows);
    const modifiers = list(node['modifiers']).filter(isObject);
    const limited = modifiers.some((modifier) => text(modifier['type']).startsWith('LIMIT'));
    for (const modifier of modifiers) {
      if (modifier['type'] === 'DISTINCT_MODIFIER') {
        this.expression(modifier['distinct_on_targets'], scope, 'group', rows);
      } else if (modifier['type'] === 'ORDER_MODIFIER' && limited) {
        this.expression(modifier['orders'], scope, 'filter', rows);
      }
    }
    return rows;
  }

  // One select item: its columns, or why they cannot be told.
  private item(item: Json, scope: Scope): Col[] | string {
    const alias = text(item['alias']);
    switch (item['class']) {
      case 'STAR':
        return this.star(item, scope);
      case 'COLUMN_REF': {
        const flow = new Flow();
        const found = this.reference(item, scope, 'direct', flow);
        const parts = list(item['column_names']).map(text);
        const named = found?.kind === 'column' && !found.field ? found.col.name : parts.at(-1);
        const carries = found?.kind === 'column' && !found.field ? found.col.carries : undefined;
        return [{ name: alias || (named ?? ''), flow, carries: alias === '' ? carries : undefined }];
      }
      default: {
        // `max(COLUMNS(*))` is one item for every column it matches.
        if (hasColumnsStar(item)) return 'COLUMNS(...), whose columns DuckDB finds when it runs';
        const flow = new Flow();
        this.expression(item, scope, 'derived', flow);
        const name = alias || this.env.name(item);
        return name === undefined
          ? 'a column whose name DuckDB did not give'
          : [{ name, flow, carries: undefined }];
      }
    }
  }

  // `*` and `t.*` with EXCLUDE, REPLACE and RENAME; COLUMNS(...) builds its names at run time.
  private star(item: Json, scope: Scope): Col[] | string {
    if (item['columns'] === true || item['unpacked'] === true)
      return 'COLUMNS(...), whose columns DuckDB finds when it runs';
    const { from } = scope;
    const relation = text(item['relation_name']);
    const location = locationOf(item);
    let bindings = from.bindings.filter((binding) => !binding.hidden);
    if (relation !== '') {
      const binding = qualified(from, [relation], this);
      if (!binding) return `${relation}.*, which names no relation of FROM`;
      if (binding.node !== undefined && location !== undefined) {
        this.mentions.push({ kind: 'qualifier', node: binding.node, location, part: 0 });
      }
      bindings = [binding];
    } else if (from.opaque) {
      return from.opaque;
    }
    const expanded: Col[] = [];
    for (const binding of bindings) {
      if (!binding.columns) return `* over ${binding.why}`;
      for (const col of binding.columns) {
        const stands = relation === '' ? standing(from, col) : col;
        if (stands) expanded.push(stands);
      }
    }
    return this.modified(expanded, starModifiers(item), scope);
  }

  // The columns of `*` after EXCLUDE, REPLACE and RENAME; a column they name carries its name no more.
  private modified(
    expanded: readonly Col[],
    { exclude, replace, rename }: ReturnType<typeof starModifiers>,
    scope: Scope,
  ): Col[] {
    const columns: Col[] = [];
    for (const col of expanded) {
      const key = foldIdentifier(col.name);
      const modified = exclude.has(key) || replace.has(key) || rename.has(key);
      if (modified && col.carries) this.mentions.push({ kind: 'fixed', key: col.carries, detail: 'star' });
      if (exclude.has(key)) continue;
      const value = replace.get(key);
      const flow = value === undefined ? col.flow.copy() : new Flow();
      if (value !== undefined) this.expression(value, scope, 'derived', flow);
      const name = rename.get(key);
      columns.push({ name: name ?? col.name, flow, carries: modified ? undefined : col.carries });
    }
    return columns;
  }

  /**
   * A column reference used as `use`: its sources go into `into`, and the places that name the lake are noted.
   * Undefined for a lambda or macro parameter.
   */
  private reference(node: Json, scope: Scope, use: ColumnUse, into: Flow): Found | undefined {
    const parts = list(node['column_names']).map(text);
    const [head] = parts;
    if (head === undefined) return undefined;
    if (scope.lambdas.has(foldIdentifier(head)) || this.env.params.has(foldIdentifier(head)))
      return undefined;
    const found = resolve(parts, scope, this);
    const location = locationOf(node);
    if (!found) {
      into.unknown.add(`${parts.join('.')}, which no relation of the query has`);
      this.mentions.push({ kind: 'unresolved', name: parts.at(-1) ?? head });
      return undefined;
    }
    if (found.kind === 'unknown') {
      into.merge(found.inputs, composeUse(use, 'derived'));
      into.unknown.add(found.detail);
      this.mentions.push({ kind: 'unresolved', name: parts.at(-1) ?? head });
      return found;
    }
    if (found.kind === 'flow') {
      into.merge(found.flow, use);
      return found;
    }
    if (location !== undefined) {
      if (found.col.carries) {
        this.mentions.push({ kind: 'column', key: found.col.carries, location, part: found.qualifier });
      }
      if (found.qualifier > 0 && found.binding?.node !== undefined) {
        this.mentions.push({
          kind: 'qualifier',
          node: found.binding.node,
          location,
          part: found.qualifier - 1,
        });
      }
    }
    into.merge(found.col.flow, found.field ? composeUse(use, 'derived') : use);
    return found;
  }

  // The relations of a FROM item; `left` are those before it, which a subquery or table function may name (LATERAL).
  private from(ref: unknown, outer: Scope | undefined, ctes: ReadonlyMap<string, Cte>, left: From): From {
    if (!isObject(ref)) return EMPTY_FROM;
    const scope: Scope = { from: left, outer, ctes, aliases: new Map(), lambdas: new Set() };
    const alias = text(ref['alias']);
    const aliases = list(ref['column_name_alias']).map(text);
    switch (ref['type']) {
      case 'EMPTY':
        return EMPTY_FROM;
      case 'BASE_TABLE':
        return this.baseTable(ref, ctes, alias, aliases);
      case 'JOIN':
        return this.join(ref, outer, ctes, left);
      case 'SUBQUERY': {
        const result = this.query(field(ref['subquery'], 'node'), scope, ctes);
        return single(over(alias || 'unnamed_subquery', result, aliases), result.rows);
      }
      case 'EXPRESSION_LIST':
        return single(this.values(ref, scope, alias), new Flow());
      case 'TABLE_FUNCTION': {
        const inputs = new Flow();
        this.expression(field(ref['function'], 'arguments'), scope, 'derived', inputs);
        const name = text(field(ref['function'], 'function_name'));
        return single(opaqueBinding(alias || name, `the table function ${name}`, inputs), new Flow());
      }
      case 'PIVOT': {
        const source = this.from(ref['source'], outer, ctes, left);
        const inputs = new Flow();
        const inner: Scope = { ...scope, from: source };
        for (const key of ['aggregates', 'pivots', 'groups'])
          this.expression(ref[key], inner, 'derived', inputs);
        return single(
          opaqueBinding(alias, 'a PIVOT or UNPIVOT, whose columns DuckDB finds when it runs', inputs),
          source.rows,
        );
      }
      default:
        return single(
          opaqueBinding(alias, `a relation of the kind ${text(ref['type']).toLowerCase()}`, new Flow()),
          new Flow(),
        );
    }
  }

  private baseTable(
    ref: Json,
    ctes: ReadonlyMap<string, Cte>,
    alias: string,
    aliases: readonly string[],
  ): From {
    const name = text(ref['table_name']);
    const schema = text(ref['schema_name']);
    const catalog = text(ref['catalog_name']);
    const cte = catalog === '' && schema === '' ? ctes.get(foldIdentifier(name)) : undefined;
    if (cte) {
      const result = cte.result();
      return single(over(alias || name, result, aliases), result.rows);
    }
    const location = locationOf(ref);
    const at = atClauseOf(ref);
    const node = this.env.relation({
      kind: 'relation',
      catalog,
      schema,
      name,
      ...(location === undefined ? {} : { location }),
      ...(at ? { at } : {}),
    });
    if (node === undefined) {
      const written = [catalog, schema, name].filter((part) => part !== '').join('.');
      return single(
        opaqueBinding(alias || name, `${written}, which is no table or view of the lake`, new Flow()),
        new Flow(),
      );
    }
    if (location !== undefined) this.mentions.push({ kind: 'relation', node, location });
    const named = this.env.named(node);
    const columns = this.env.columns(node)?.map((column) => {
      const key = { node, name: column };
      return { name: column, flow: Flow.of(key), carries: key };
    });
    return single(
      {
        name: alias || named.name,
        schema: alias === '' ? named.schema : '',
        node: alias === '' ? node : undefined,
        columns: columns && aliased(columns, aliases),
        why: `${named.schema}.${named.name}, whose columns the analysis cannot tell`,
        inputs: new Flow(),
        hidden: false,
      },
      new Flow(),
    );
  }

  // VALUES: the columns col0, col1, ... take the values of every row.
  private values(ref: Json, scope: Scope, alias: string): Binding {
    const rows = list(ref['values']).map(list);
    const width = Math.max(0, ...rows.map((row) => row.length));
    const columns = Array.from({ length: width }, (_, index) => {
      const flow = new Flow();
      for (const row of rows) this.expression(row[index], scope, 'derived', flow);
      return { name: `col${index}`, flow, carries: undefined };
    });
    return {
      name: alias || 'valueslist',
      schema: '',
      node: undefined,
      columns,
      why: '',
      inputs: new Flow(),
      hidden: false,
    };
  }

  private join(ref: Json, outer: Scope | undefined, ctes: ReadonlyMap<string, Cte>, left: From): From {
    const before = this.from(ref['left'], outer, ctes, left);
    const after = this.from(ref['right'], outer, ctes, joined(left, before));
    const kind = text(ref['join_type']);
    const hidden = kind === 'SEMI' || kind === 'ANTI';
    const merged = new Map([...before.merged, ...after.merged]);
    const replaced = new Map([...before.replaced, ...after.replaced]);
    const rows = new Flow();
    rows.merge(before.rows);
    rows.merge(after.rows);
    const both: From = {
      bindings: [
        ...before.bindings,
        ...after.bindings.map((binding) => (hidden ? { ...binding, hidden } : binding)),
      ],
      merged,
      replaced,
      rows,
      opaque: before.opaque ?? after.opaque,
    };
    this.expression(
      ref['condition'],
      { from: both, outer, ctes, aliases: new Map(), lambdas: new Set() },
      'join',
      rows,
    );
    const natural = ref['ref_type'] === 'NATURAL';
    if (natural && [...before.bindings, ...after.bindings].some((binding) => !binding.columns)) {
      return { ...both, opaque: 'a NATURAL join over a relation whose columns the analysis cannot tell' };
    }
    const names = natural ? commonNames(before, after) : list(ref['using_columns']).map(text);
    for (const name of names) {
      const [first, second] = [lookup(before, name), lookup(after, name)];
      if (!first || !second) continue;
      rows.merge(first.flow, 'join');
      rows.merge(second.flow, 'join');
      const flow = kind === 'RIGHT' ? second.flow.copy() : first.flow.copy();
      if (kind === 'OUTER' || kind === 'FULL') flow.merge(second.flow, 'derived');
      const stands = { name: first.name, flow, carries: kind === 'RIGHT' ? second.carries : first.carries };
      merged.set(foldIdentifier(name), stands);
      replaced.set(first, stands);
      replaced.set(second, null);
      for (const col of [first, second]) {
        if (col.carries)
          this.mentions.push({ kind: 'fixed', key: col.carries, detail: natural ? 'natural' : 'using' });
      }
    }
    return both;
  }

  /** Adds the columns that an expression reads to `into` with `use`; a subquery is read in a scope of its own. */
  expression(value: unknown, scope: Scope, use: ColumnUse, into: Flow): void {
    const todo: (readonly [unknown, ReadonlySet<string>])[] = [[value, scope.lambdas]];
    for (let at = todo.pop(); at; at = todo.pop()) {
      const [current, lambdas] = at;
      if (Array.isArray(current)) {
        for (const item of current as unknown[]) todo.push([item, lambdas]);
        continue;
      }
      if (!isObject(current)) continue;
      switch (current['class']) {
        case 'COLUMN_REF':
          this.reference(current, { ...scope, lambdas }, use, into);
          continue;
        case 'SUBQUERY':
          this.subquery(current, { ...scope, lambdas }, use, into);
          continue;
        case 'LAMBDA':
          todo.push([current['expr'], new Set([...lambdas, ...lambdaNames(current['lhs'])])]);
          continue;
        case 'STAR':
          into.unknown.add('* or COLUMNS(...) inside an expression');
          continue;
        case 'POSITIONAL_REFERENCE':
          into.unknown.add('a column named by its position');
          continue;
        case 'FUNCTION':
        case 'WINDOW': {
          const reads = this.env.readingCall?.({
            kind: 'scalarMacro',
            catalog: text(current['catalog']),
            schema: text(current['schema']),
            name: text(current['function_name']),
          });
          if (reads) into.unknown.add(`what the macro ${reads} reads`);
          break;
        }
        default:
          break;
      }
      for (const child of Object.values(current)) {
        if (typeof child === 'object' && child !== null) todo.push([child, lambdas]);
      }
    }
  }

  // `(SELECT ...)`, `x IN (SELECT ...)`, `EXISTS (...)`: the compared value and what the subquery gives and decides.
  private subquery(node: Json, scope: Scope, use: ColumnUse, into: Flow): void {
    this.expression(node['child'], scope, use, into);
    const result = this.query(field(node['subquery'], 'node'), scope, scope.ctes);
    into.merge(result.rows, use);
    if (!result.columns) into.unknown.add(result.why);
    for (const col of result.columns ?? []) into.merge(col.flow, use);
  }
}

/**
 * The lineage of one statement of a `json_serialize_sql` document: its output columns with their sources, renamed by
 * `aliases` (the column list of a view), and the places where it names the lake. Throws on a text nested too deep.
 */
export function bodyLineage(
  statement: unknown,
  env: LineageEnv,
  aliases: readonly string[] = [],
): BodyLineage {
  const analysis = new Analysis(env);
  const result = analysis.query(field(statement, 'node'), undefined, new Map());
  return {
    columns: result.columns
      ? aliased(result.columns, aliases).map((col) => ({
          name: col.name,
          sources: [...col.flow.sources.values()],
          unknown: [...col.flow.unknown],
          carries: col.carries,
        }))
      : undefined,
    opaque: result.columns ? undefined : result.why,
    mentions: analysis.mentions,
    ambiguous: analysis.ambiguous,
  };
}
