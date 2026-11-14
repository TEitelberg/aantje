import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import type { ColumnInfo, SchemaInfo } from '../catalog/model';
import { EMPTY_CATALOG, nameOf } from './catalog';
import type { SqlCatalog, SqlEntry } from './catalog';
import type { ScopeRelation } from './context';
import type { TextColumn, TextColumns } from './context-columns';

/** The catalog of one request plus the by-name lookups that completion, hover and signature help share. */
export interface Lookup {
  readonly lake: string;
  readonly schemas: readonly SchemaInfo[];
  readonly entries: readonly SqlEntry[];
  schema(name: string): SchemaInfo | undefined;
  entry(schema: string, name: string): SqlEntry | undefined;
  entriesOf(schema: string): SqlEntry[];
  columns(entry: SqlEntry): Promise<readonly ColumnInfo[]>;
  /** The reads of view columns that `columns` found running, so it answered without them; settles when they end. */
  pending(): Promise<void> | undefined;
  /** The remaining catalog reads; a failed read gives an empty result. */
  readonly catalog: SqlCatalog;
}

export type Named =
  | { readonly kind: 'lake' }
  | { readonly kind: 'schema'; readonly schema: SchemaInfo }
  | { readonly kind: 'relation'; readonly entry: SqlEntry }
  | {
      readonly kind: 'column';
      readonly entry: SqlEntry;
      readonly column: ColumnInfo;
      /** Names from the top-level column down to `column`. */
      readonly trail: readonly string[];
    }
  /** A CTE, subquery or VALUES list of the query, or a relation with column aliases: the columns its text gives. */
  | { readonly kind: 'derived'; readonly name: string; readonly columns: readonly ScopeColumn[] }
  /** A column of such a relation that reads no column of the catalog. */
  | { readonly kind: 'text-column'; readonly name: string };

/** A column of a relation of the query; `source` is the column of the catalog that it reads, when the text names one. */
export interface ScopeColumn {
  readonly name: string;
  readonly source: CatalogColumn | undefined;
}

type CatalogColumn = Extract<Named, { kind: 'column' }>;

/** Loads schemas and entries once; a failed read (closed connection, changed catalog) counts as empty. */
export async function openLookup(source: SqlCatalog): Promise<Lookup> {
  const safely = async <T>(read: () => Promise<readonly T[]>): Promise<readonly T[]> => {
    try {
      return await read();
    } catch {
      return [];
    }
  };
  const catalog: SqlCatalog = {
    lake: source.lake,
    schemas: () => safely(() => source.schemas()),
    entries: () => safely(() => source.entries()),
    columns: (schema, table) => safely(() => source.columns(schema, table)),
    columnsPending: (schema, table) => source.columnsPending(schema, table),
    viewsTrusted: () => source.viewsTrusted(),
    macros: (schema) => safely(() => source.macros(schema)),
    snapshots: () => safely(() => source.snapshots()),
    layout: (schema, table) => source.layout(schema, table).catch(() => EMPTY_CATALOG.layout(schema, table)),
    at: (snapshot) => source.at(snapshot),
  };
  const [schemas, entries] = await Promise.all([catalog.schemas(), catalog.entries()]);
  const bySchema = new Map<string, Map<string, SqlEntry>>();
  for (const entry of entries) {
    const key = foldIdentifier(entry.schema.name);
    const inSchema = bySchema.get(key) ?? new Map<string, SqlEntry>();
    inSchema.set(foldIdentifier(nameOf(entry)), entry);
    bySchema.set(key, inSchema);
  }
  const columns = new Map<SqlEntry, Promise<readonly ColumnInfo[]>>();
  const pending = new Set<Promise<void>>();
  return {
    lake: catalog.lake,
    schemas,
    entries,
    schema: (name) => schemas.find((schema) => sameIdentifier(schema.name, name)),
    entry: (schema, name) => bySchema.get(foldIdentifier(schema))?.get(foldIdentifier(name)),
    entriesOf: (schema) => [...(bySchema.get(foldIdentifier(schema))?.values() ?? [])],
    columns: (entry) => {
      let promise = columns.get(entry);
      if (!promise) {
        promise = catalog.columns(entry.schema.name, nameOf(entry)).then((found) => {
          const running = catalog.columnsPending(entry.schema.name, nameOf(entry));
          if (running) pending.add(running);
          return found;
        });
        columns.set(entry, promise);
      }
      return promise;
    },
    pending: () => (pending.size > 0 ? Promise.all(pending).then(() => undefined) : undefined),
    catalog,
  };
}

/** All readings of a dotted path (`sales` may be an alias, a table and a schema); a scope relation wins. */
export async function namedBy(
  path: readonly string[],
  scope: readonly ScopeRelation[],
  lookup: Lookup,
  options: { readonly unqualifiedTable?: string } = {},
): Promise<Named[]> {
  const [first, ...rest] = path;
  if (first === undefined) return [];
  const found: Named[] = [];
  const inScope = relationNamed(scope, first);
  if (inScope) return scopeNamed(inScope, first, rest, lookup);
  if (sameIdentifier(first, lookup.lake)) found.push(...(await fromLake(rest, lookup)));
  const schema = lookup.schema(first);
  if (schema) found.push(...(await fromSchema(schema, rest, lookup)));
  const main = options.unqualifiedTable && lookup.entry(options.unqualifiedTable, first);
  if (main) found.push(...(await descend(main, rest, lookup)));
  return found;
}

/** The relation of the query that a name stands for: its alias, or the name of a table or CTE without one. */
function relationNamed(scope: readonly ScopeRelation[], name: string): ScopeRelation | undefined {
  return (
    scope.find(({ alias }) => alias !== undefined && sameIdentifier(alias, name)) ??
    scope.find(
      ({ alias, relation, cte }) =>
        alias === undefined &&
        [relation?.table, cte].some((named) => named !== undefined && sameIdentifier(named, name)),
    )
  );
}

/** The columns of the relation come from the SQL text (a CTE, a subquery, column aliases), not from the catalog. */
export function fromText({ columns, renamed = [] }: ScopeRelation): boolean {
  return columns !== undefined || renamed.length > 0;
}

// `alias`, `alias.column` and the fields of a struct column after it.
async function scopeNamed(
  relation: ScopeRelation,
  name: string,
  rest: readonly string[],
  lookup: Lookup,
): Promise<Named[]> {
  if (!fromText(relation)) {
    const entry = relation.relation && lookup.entry(relation.relation.schema, relation.relation.table);
    return entry ? descend(entry, rest, lookup) : [];
  }
  const columns = await scopeColumns(relation, lookup);
  const [column, ...fields] = rest;
  if (column === undefined) return [{ kind: 'derived', name, columns }];
  const found = columns.find((candidate) => sameIdentifier(candidate.name, column));
  if (found?.source) return fieldOf(found.source, fields);
  return found && fields.length === 0 ? [{ kind: 'text-column', name: found.name }] : [];
}

// One column of a relation in order: a known one, one without a known name, or any number of unknown ones.
type Slot = ScopeColumn | 'unnamed' | 'gap';

const isColumn = (slot: Slot | undefined): slot is ScopeColumn => typeof slot === 'object';

/** The columns of a relation of the query that are certain, in order: a column of an unknown width or name is left out. */
export async function scopeColumns(relation: ScopeRelation, lookup: Lookup): Promise<ScopeColumn[]> {
  return (await slotsOf(relation, lookup)).filter(isColumn);
}

/** The column of that name that exactly one relation of the query has. */
export async function columnInScope(
  name: string,
  scope: readonly ScopeRelation[],
  lookup: Lookup,
): Promise<ScopeColumn | undefined> {
  const lists = await Promise.all(scope.map((relation) => scopeColumns(relation, lookup)));
  const hits = lists.flatMap((columns) => columns.filter((column) => sameIdentifier(column.name, name)));
  return hits.length === 1 ? hits[0] : undefined;
}

// Per lookup and relation: every reference of a select list that reads a CTE asks for the CTE's columns.
const slotCache = new WeakMap<Lookup, WeakMap<ScopeRelation, Promise<Slot[]>>>();

function slotsOf(relation: ScopeRelation, lookup: Lookup): Promise<Slot[]> {
  const cache = slotCache.get(lookup) ?? new WeakMap<ScopeRelation, Promise<Slot[]>>();
  slotCache.set(lookup, cache);
  const slots = cache.get(relation) ?? readSlots(relation, lookup);
  cache.set(relation, slots);
  return slots;
}

async function readSlots(relation: ScopeRelation, lookup: Lookup): Promise<Slot[]> {
  const { columns, renamed = [] } = relation;
  const slots = columns ? await textSlots(columns, lookup) : await catalogSlots(relation, lookup);
  return unique(renameSlots(slots, renamed));
}

// A relation without columns is one whose columns are not known: a view, a table function, an unknown table.
async function catalogSlots({ relation }: ScopeRelation, lookup: Lookup): Promise<Slot[]> {
  const entry = relation && lookup.entry(relation.schema, relation.table);
  const columns = entry ? await lookup.columns(entry) : [];
  if (!entry || columns.length === 0) return ['gap'];
  return columns.map((column) => ({
    name: column.name,
    source: { kind: 'column', entry, column, trail: [column.name] },
  }));
}

async function textSlots({ items, scope, renamed }: TextColumns, lookup: Lookup): Promise<Slot[]> {
  const parts = await Promise.all(items.map((item) => itemSlots(item, scope, lookup)));
  return unique(renameSlots(parts.flat(), renamed));
}

async function itemSlots(item: TextColumn, scope: readonly ScopeRelation[], lookup: Lookup): Promise<Slot[]> {
  switch (item.kind) {
    case 'column': {
      const found = item.path && (await referenced(item.path, scope, lookup));
      const name = item.alias ?? found?.name ?? item.path?.at(-1);
      return name === undefined ? ['unnamed'] : [{ name, source: found?.source }];
    }
    case 'star':
      return starSlots(item, scope, lookup);
    case 'expression':
      return ['unnamed'];
    case 'unknown':
      return ['gap'];
  }
}

// The column that a reference of the select list reads: through its qualifier, or the one relation that has it.
async function referenced(
  path: readonly string[],
  scope: readonly ScopeRelation[],
  lookup: Lookup,
): Promise<ScopeColumn | undefined> {
  const [first] = path;
  if (path.length === 1 && first !== undefined) return columnInScope(first, scope, lookup);
  const named = (await namedBy(path, scope, lookup)).find(
    ({ kind }) => kind === 'column' || kind === 'text-column',
  );
  if (named?.kind === 'column') return { name: named.column.name, source: named };
  return named?.kind === 'text-column' ? { name: named.name, source: undefined } : undefined;
}

// A join with USING or NATURAL keeps a shared column once: after the first relation the positions are not certain.
async function starSlots(
  { qualifier, exclude, rename }: Extract<TextColumn, { kind: 'star' }>,
  scope: readonly ScopeRelation[],
  lookup: Lookup,
): Promise<Slot[]> {
  const [first] = qualifier;
  const named = first !== undefined && qualifier.length === 1 ? relationNamed(scope, first) : undefined;
  const relations = first === undefined ? scope : named ? [named] : [];
  if (relations.length === 0) return ['gap'];
  const lists = await Promise.all(relations.map((relation) => slotsOf(relation, lookup)));
  return lists
    .flatMap((slots, index): Slot[] => (index === 0 ? slots : ['gap', ...slots]))
    .filter((slot) => !isColumn(slot) || !exclude.includes(foldIdentifier(slot.name)))
    .map((slot) => {
      const name = isColumn(slot) ? rename.get(foldIdentifier(slot.name)) : undefined;
      return isColumn(slot) && name !== undefined ? { ...slot, name } : slot;
    });
}

// Column aliases rename the first columns by position; past a column of unknown width the positions are not known.
function renameSlots(slots: readonly Slot[], aliases: readonly string[]): Slot[] {
  if (aliases.length === 0) return [...slots];
  const gap = slots.indexOf('gap');
  const known = gap < 0 ? slots.length : gap;
  const head = aliases.map((name, index): Slot => {
    const slot = index < known ? slots[index] : undefined;
    return { name, source: isColumn(slot) ? slot.source : undefined };
  });
  return aliases.length <= known ? [...head, ...slots.slice(aliases.length)] : [...head, 'gap'];
}

// DuckDB names a repeated column of a subquery `a_1`: only the first keeps the name.
function unique(slots: readonly Slot[]): Slot[] {
  const seen = new Set<string>();
  return slots.map((slot) => {
    if (!isColumn(slot)) return slot;
    const key = slot.name.toLowerCase();
    if (seen.has(key)) return 'unnamed';
    seen.add(key);
    return slot;
  });
}

async function fromLake(rest: readonly string[], lookup: Lookup): Promise<Named[]> {
  const [name, ...more] = rest;
  if (name === undefined) return [{ kind: 'lake' }];
  const schema = lookup.schema(name);
  return schema ? fromSchema(schema, more, lookup) : [];
}

async function fromSchema(schema: SchemaInfo, rest: readonly string[], lookup: Lookup): Promise<Named[]> {
  const [name, ...more] = rest;
  if (name === undefined) return [{ kind: 'schema', schema }];
  const entry = lookup.entry(schema.name, name);
  return entry ? descend(entry, more, lookup) : [];
}

async function descend(entry: SqlEntry, rest: readonly string[], lookup: Lookup): Promise<Named[]> {
  const [name, ...fields] = rest;
  if (name === undefined) return [{ kind: 'relation', entry }];
  const column = (await lookup.columns(entry)).find((candidate) => sameIdentifier(candidate.name, name));
  return column ? fieldOf({ kind: 'column', entry, column, trail: [column.name] }, fields) : [];
}

// The field of a struct column that the names lead to.
function fieldOf(source: CatalogColumn, fields: readonly string[]): Named[] {
  let column: ColumnInfo | undefined = source.column;
  const trail = [...source.trail];
  for (const field of fields) {
    column =
      column?.type === 'struct'
        ? column.children.find((child) => sameIdentifier(child.name, field))
        : undefined;
    if (column) trail.push(column.name);
  }
  return column ? [{ ...source, column, trail }] : [];
}

/** The type as written in SQL: `struct(name varchar)`, `varchar[]`, `map(varchar, int32)`. */
export function typeText(column: ColumnInfo): string {
  switch (column.type) {
    case 'struct':
      return `struct(${column.children.map((field) => `${field.name} ${typeText(field)}`).join(', ')})`;
    case 'list':
      return `${column.children.map(typeText).join('')}[]`;
    case 'map':
      return `map(${column.children.map(typeText).join(', ')})`;
    default:
      return column.type;
  }
}
