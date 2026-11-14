// Warnings for the tables, views and columns that the lake certainly does not have. A false warning is worse than
// a missing one: whatever the text and the catalog do not settle gives none.
import { quoteName } from './tokens';
import { foldIdentifier, sameIdentifier } from '../catalog/ddl';
import { statementReferences } from './parse-tree';
import type { Reference } from './parse-tree';
import { DEFAULT_SCHEMA, nameOf } from './catalog';
import type { SqlCatalog, SqlEntry } from './catalog';
import { openLookup } from './lookup';
import type { Lookup } from './lookup';
import { nearestNames } from './problems';
import type { Problem } from './problems';
import { utf16Offsets } from './script';
import { columnUses } from './tree-scope';
import type { ColumnUse, SelectItem, TreeQuery, TreeRelation, TreeTable } from './tree-scope';

/** A query that DuckDB parsed: one statement of its `json_serialize_sql` document. */
export interface ParsedQuery {
  readonly statement: unknown;
  /** The text that was parsed: the document, or one statement of it. */
  readonly text: string;
  /** Where `text` starts in the document, in UTF-16 units. */
  readonly offset: number;
}

export interface NameCheck {
  readonly catalog: SqlCatalog;
  /** Lower case words that need quotes. */
  readonly reserved: ReadonlySet<string>;
  /** DuckDB's own views (`duckdb_tables`, `pg_tables`), in lower case. */
  readonly system: ReadonlySet<string>;
  /** Lower case words of the statements that are no queries: what they create or change is not known. */
  readonly mentioned: ReadonlySet<string>;
  /** A statement changes where names resolve (USE, ATTACH, SET search_path): only `lake.schema.name` is certain. */
  readonly qualifiedOnly: boolean;
}

// The catalogs that DuckDB always has besides the lake.
const OTHER_CATALOGS = new Set(['memory', 'system', 'temp']);
// A name with these characters is read as a file (`FROM 'orders.parquet'`).
const FILE_LIKE = /[./\\:*?]/;
const SYSTEM_PREFIX = /^(duckdb|pragma|sqlite|pg)_/i;
// Columns that every table of DuckLake has without listing them.
const VIRTUAL_COLUMNS = new Set(['rowid', 'filename', 'file_row_number', 'file_index', 'snapshot_id']);
// Names that DuckDB reads as a function when no column has them.
const VALUE_FUNCTIONS = new Set([
  ...['current_catalog', 'current_date', 'current_role', 'current_schema', 'current_time'],
  ...['current_timestamp', 'current_user', 'localtime', 'localtimestamp', 'session_user', 'user'],
]);

// A shared column comes once per relation that has it.
const MAX_CANDIDATES = 3;

interface Env extends NameCheck {
  lookupAt(version: number | undefined): Promise<Lookup | undefined>;
  readonly relationColumns: WeakMap<TreeRelation, Promise<readonly string[] | undefined>>;
  readonly queryColumns: WeakMap<TreeQuery, Promise<readonly string[] | undefined>>;
}

/** The warnings of the queries, by offset; none when the catalog cannot be read. */
export async function unknownNames(queries: readonly ParsedQuery[], check: NameCheck): Promise<Problem[]> {
  const newest = await strictLookup(check.catalog);
  if (!newest) return [];
  const others = new Map<number, Promise<Lookup | undefined>>();
  const env: Env = {
    ...check,
    lookupAt: (version) => {
      if (version === undefined) return Promise.resolve(newest);
      const found = others.get(version) ?? strictLookup(check.catalog.at(version));
      others.set(version, found);
      return found;
    },
    relationColumns: new WeakMap(),
    queryColumns: new WeakMap(),
  };
  const found = await Promise.all(queries.map((query) => queryProblems(query, env)));
  return found.flat().sort((a, b) => a.offset - b.offset);
}

// Only a catalog whose schemas and objects were read: a failed or empty read must not make every name unknown.
async function strictLookup(catalog: SqlCatalog): Promise<Lookup | undefined> {
  try {
    await Promise.all([catalog.schemas(), catalog.entries()]);
    return await openLookup(catalog);
  } catch {
    return undefined;
  }
}

async function queryProblems(query: ParsedQuery, env: Env): Promise<Problem[]> {
  const unitOf = utf16Offsets(query.text);
  const place = (location: number, names: readonly string[]): NamePart | undefined =>
    lastPart(query, unitOf(location), names);
  const relations = statementReferences(query.statement).references.filter(
    (reference) => reference.kind === 'relation',
  );
  const found = await Promise.all([
    ...relations.map((reference) => relationProblem(reference, place, env)),
    ...columnUses(query.statement).map((use) => columnProblem(use, place, env)),
  ]);
  return found.filter((problem): problem is Problem => problem !== undefined);
}

type Place = (location: number, names: readonly string[]) => NamePart | undefined;

async function relationProblem(reference: Reference, place: Place, env: Env): Promise<Problem | undefined> {
  const { catalog, schema, name, location, at } = reference;
  if (location === undefined) return undefined;
  const resolved = await resolveTable({ catalog, schema, name, at }, env);
  if (resolved.kind !== 'missing') return undefined;
  const part = place(
    location,
    [catalog, schema, name].filter((written) => written !== ''),
  );
  if (!part) return undefined;
  const known = resolved.lookup.entriesOf(resolved.schema).map(nameOf);
  const candidates = nearestNames(name, known).map((found) => ({ name: found }));
  return warning(part, `The lake has no table or view "${resolved.schema}.${name}".`, candidates, env);
}

async function columnProblem(use: ColumnUse, place: Place, env: Env): Promise<Problem | undefined> {
  const [first, second, ...fields] = use.path;
  // `t.column.field` and `schema.table.column` are not checked.
  if (first === undefined || fields.length > 0) return undefined;
  const finding =
    second === undefined ? await unqualified(first, use, env) : await qualified(first, second, use, env);
  const part = finding && place(use.location, use.path);
  return part && warning(part, finding.message, finding.candidates, env);
}

interface Candidate {
  readonly name: string;
  readonly qualifier?: string | undefined;
}

interface Finding {
  readonly message: string;
  readonly candidates: readonly Candidate[];
}

async function unqualified(name: string, use: ColumnUse, env: Env): Promise<Finding | undefined> {
  const key = foldIdentifier(name);
  if (VALUE_FUNCTIONS.has(key) || VIRTUAL_COLUMNS.has(key) || env.mentioned.has(key)) return undefined;
  const relations = use.scopes.flatMap((scope) => scope.relations);
  if (relations.length === 0 || use.scopes.some((scope) => scope.aliases.has(key))) return undefined;
  // `SELECT t FROM t` is the row of t.
  if (relations.some((relation) => relation.name !== undefined && sameIdentifier(relation.name, name)))
    return undefined;
  const lists = await Promise.all(relations.map((relation) => columnsOf(relation, env)));
  if (lists.some((columns) => !columns || columns.some((column) => sameIdentifier(column, name))))
    return undefined;
  const innermost = use.scopes.find((scope) => scope.relations.length > 0)?.relations ?? [];
  const candidates = await scopeCandidates(innermost, env);
  const nearest = nearestNames(
    name,
    candidates.map((candidate) => candidate.name),
  );
  return {
    message: `No relation of the query has a column "${name}".`,
    candidates: nearest
      .flatMap((found) => candidates.filter((candidate) => sameIdentifier(candidate.name, found)))
      .slice(0, MAX_CANDIDATES),
  };
}

// The columns of the relations of a query; a column that two of them have comes with the relation's name.
async function scopeCandidates(relations: readonly TreeRelation[], env: Env): Promise<Candidate[]> {
  const lists = await Promise.all(
    relations.map(async (relation) => ({ relation, columns: await columnsOf(relation, env) })),
  );
  const counts = new Map<string, number>();
  for (const { columns = [] } of lists) {
    for (const column of columns)
      counts.set(foldIdentifier(column), (counts.get(foldIdentifier(column)) ?? 0) + 1);
  }
  return lists.flatMap(({ relation, columns = [] }) =>
    columns.flatMap((column): Candidate[] => {
      if ((counts.get(foldIdentifier(column)) ?? 0) === 1) return [{ name: column }];
      return relation.name === undefined ? [] : [{ name: column, qualifier: relation.name }];
    }),
  );
}

async function qualified(
  qualifier: string,
  name: string,
  use: ColumnUse,
  env: Env,
): Promise<Finding | undefined> {
  const key = foldIdentifier(name);
  if (VIRTUAL_COLUMNS.has(key) || env.mentioned.has(key)) return undefined;
  const relation = relationNamed(use, qualifier);
  if (!relation) return undefined;
  const lists = await Promise.all(
    use.scopes.flatMap((scope) => scope.relations).map((r) => columnsOf(r, env)),
  );
  // `q.c` is the field c of a column q when q's relation lacks c.
  if (lists.some((columns) => !columns || columns.some((column) => sameIdentifier(column, qualifier))))
    return undefined;
  const columns = await columnsOf(relation, env);
  if (!columns || columns.some((column) => sameIdentifier(column, name))) return undefined;
  return {
    message: `"${qualifier}" has no column "${name}".`,
    candidates: nearestNames(name, columns).map((found) => ({ name: found })),
  };
}

// The innermost query that has a relation of that name decides; two of that name are not certain.
function relationNamed(use: ColumnUse, name: string): TreeRelation | undefined {
  for (const scope of use.scopes) {
    const named = scope.relations.filter(
      (relation) => relation.name !== undefined && sameIdentifier(relation.name, name),
    );
    if (named.length > 0) return named.length === 1 ? named[0] : undefined;
  }
  return undefined;
}

type Resolved =
  | { readonly kind: 'known'; readonly entry: SqlEntry; readonly lookup: Lookup }
  | { readonly kind: 'missing'; readonly schema: string; readonly lookup: Lookup }
  | { readonly kind: 'unsure' };

const UNSURE: Resolved = { kind: 'unsure' };

async function resolveTable({ catalog, schema, name, at }: TreeTable, env: Env): Promise<Resolved> {
  if (at && at.version === undefined) return UNSURE;
  if (FILE_LIKE.test(name) || env.mentioned.has(foldIdentifier(name))) return UNSURE;
  if (env.system.has(foldIdentifier(name)) || SYSTEM_PREFIX.test(name)) return UNSURE;
  const lookup = await env.lookupAt(at?.version);
  const inSchema = lookup && schemaOf(catalog, schema, lookup, env);
  if (!lookup || inSchema === undefined) return UNSURE;
  const entry = lookup.entry(inSchema, name);
  return entry ? { kind: 'known', entry, lookup } : { kind: 'missing', schema: inSchema, lookup };
}

// The schema of the lake that the name certainly reads; `x.t` may name the catalog x, which only the lake's own name
// (`lake.t`, the table t of main) or a schema of the lake settles.
function schemaOf(catalog: string, schema: string, lookup: Lookup, env: Env): string | undefined {
  if (catalog !== '') return sameIdentifier(catalog, lookup.lake) ? lookup.schema(schema)?.name : undefined;
  if (env.qualifiedOnly) return undefined;
  if (schema === '') return lookup.schema(DEFAULT_SCHEMA)?.name;
  if (OTHER_CATALOGS.has(foldIdentifier(schema))) return undefined;
  const own = lookup.schema(schema)?.name;
  return own ?? (sameIdentifier(schema, lookup.lake) ? lookup.schema(DEFAULT_SCHEMA)?.name : undefined);
}

// The names of a relation in order; undefined when they are not all certain.
function columnsOf(relation: TreeRelation, env: Env): Promise<readonly string[] | undefined> {
  let found = env.relationColumns.get(relation);
  if (!found) {
    found = readColumns(relation, env);
    env.relationColumns.set(relation, found);
  }
  return found;
}

async function readColumns(relation: TreeRelation, env: Env): Promise<readonly string[] | undefined> {
  switch (relation.kind) {
    case 'table': {
      const resolved = await resolveTable(relation.table, env);
      if (resolved.kind !== 'known') return undefined;
      // A view whose columns are not read (not trusted, still reading, failed) has none.
      const columns = (await resolved.lookup.columns(resolved.entry)).map((column) => column.name);
      return columns.length === 0 ? undefined : renamed(columns, relation.renamed);
    }
    case 'query': {
      const columns = await queryColumnsOf(relation.query, env);
      return columns && renamed(columns, relation.renamed);
    }
    case 'values':
      return renamed(
        Array.from({ length: relation.width }, (_, index) => `col${index}`),
        relation.renamed,
      );
    case 'opaque':
      return undefined;
  }
}

function queryColumnsOf(query: TreeQuery, env: Env): Promise<readonly string[] | undefined> {
  let found = env.queryColumns.get(query);
  if (!found) {
    found = readQueryColumns(query, env);
    env.queryColumns.set(query, found);
  }
  return found;
}

async function readQueryColumns(query: TreeQuery, env: Env): Promise<readonly string[] | undefined> {
  const { items, relations } = query;
  if (!items) return undefined;
  const parts = await Promise.all(items.map((item) => itemColumns(item, relations, env)));
  if (parts.some((part) => part === undefined)) return undefined;
  return unique(parts.flatMap((part) => part ?? []));
}

async function itemColumns(
  item: SelectItem,
  relations: readonly TreeRelation[],
  env: Env,
): Promise<readonly string[] | undefined> {
  switch (item.kind) {
    case 'named':
      return [item.name];
    case 'unknown':
      return undefined;
    case 'star': {
      const { relation: qualifier, exclude, rename } = item;
      const read =
        qualifier === undefined
          ? relations
          : relations.filter(({ name }) => name !== undefined && sameIdentifier(name, qualifier));
      if (read.length === 0) return undefined;
      const lists = await Promise.all(read.map((relation) => columnsOf(relation, env)));
      if (lists.some((columns) => columns === undefined)) return undefined;
      return lists
        .flatMap((columns) => columns ?? [])
        .filter((column) => !exclude.has(foldIdentifier(column)))
        .map((column) => rename.get(foldIdentifier(column)) ?? column);
    }
  }
}

// Column aliases rename the first columns; more aliases than columns, or a repeated name, are not certain.
function renamed(columns: readonly string[], aliases: readonly string[]): readonly string[] | undefined {
  if (aliases.length > columns.length) return undefined;
  return unique([...aliases, ...columns.slice(aliases.length)]);
}

// DuckDB renames a repeated column of a subquery (`a_1`): the names are no longer certain.
function unique(columns: readonly string[]): readonly string[] | undefined {
  return new Set(columns.map(foldIdentifier)).size === columns.length ? columns : undefined;
}

function warning(part: NamePart, message: string, candidates: readonly Candidate[], env: Env): Problem {
  const quote = (name: string): string => quoteName(name, env.reserved, part.quoted);
  return {
    severity: 'warning',
    offset: part.offset,
    length: part.length,
    message,
    replacements: candidates.map(({ name, qualifier }) =>
      qualifier === undefined ? quote(name) : `${quote(qualifier)}.${quote(name)}`,
    ),
  };
}

interface NamePart {
  readonly name: string;
  /** In the document. */
  readonly offset: number;
  readonly length: number;
  readonly quoted: boolean;
}

// The last of the dotted names at a location, in the document; undefined when the text does not spell `names`.
function lastPart(query: ParsedQuery, at: number, names: readonly string[]): NamePart | undefined {
  const parts = namePartsAt(query.text, at);
  if (
    parts.length < names.length ||
    names.some((name, index) => !sameIdentifier(parts[index]?.name ?? '', name))
  ) {
    return undefined;
  }
  const last = parts[names.length - 1];
  return last && { ...last, offset: query.offset + last.offset };
}

const WORD = /[\p{L}_][\p{L}\p{M}\p{N}_$]*/uy;

/** The parts of the dotted name that starts at `offset`: plain or quoted words, with spaces around the dots. */
function namePartsAt(text: string, offset: number): NamePart[] {
  const parts: NamePart[] = [];
  for (let at = offset; ;) {
    const part = wordAt(text, at);
    if (!part) return parts;
    parts.push(part);
    const dot = spacesAfter(text, part.offset + part.length);
    if (text[dot] !== '.') return parts;
    at = spacesAfter(text, dot + 1);
  }
}

function wordAt(text: string, at: number): NamePart | undefined {
  if (text[at] === '"') {
    for (let close = text.indexOf('"', at + 1); close >= 0; close = text.indexOf('"', close + 2)) {
      if (text[close + 1] !== '"') {
        const name = text.slice(at + 1, close).replaceAll('""', '"');
        return { name, offset: at, length: close + 1 - at, quoted: true };
      }
    }
    return undefined;
  }
  WORD.lastIndex = at;
  const match = WORD.exec(text);
  return match ? { name: match[0], offset: at, length: match[0].length, quoted: false } : undefined;
}

function spacesAfter(text: string, at: number): number {
  let index = at;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
}
