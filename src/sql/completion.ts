import type { ColumnInfo, SchemaInfo } from '../catalog/model';
import { quoteIdentifier } from '../catalog/ddl';
import {
  columnDescription,
  columnTooltip,
  schemaTooltip,
  tableDescription,
  tableTooltip,
  viewColumnTooltip,
  viewTooltip,
} from '../tree/format';
import { nameOf } from './catalog';
import type { SqlCatalog, SqlEntry } from './catalog';
import {
  clauseSnippetDrafts,
  lakeCallSnippet,
  namedArgumentDrafts,
  snapshotClauseDrafts,
  snapshotDrafts,
  statementSnippetDrafts,
  TIMESTAMP_SNAPSHOTS,
  VERSION_SNAPSHOTS,
} from './completion-lake';
import { columnLists, textColumnDrafts } from './completion-columns';
import { copyFormatDrafts, copyOptionDrafts, localDrafts } from './completion-duckdb';
import {
  EXPRESSION_KEYWORDS,
  NEXT_KEYWORDS,
  QUERY_KEYWORDS,
  STATEMENT_KEYWORDS,
} from './completion-keywords';
import { callAt, contextAt, DEFAULT_SCHEMA } from './context';
import type { CallContext, CursorContext } from './context';
import type { SqlToken } from './tokens';
import { functionDocumentation, signatureLabel } from './help';
import { namedBy, openLookup, same, typeText } from './lookup';
import type { Lookup, Named } from './lookup';
import type { Position } from './position';
import type { Range } from './script';
import type { FunctionInfo, Vocabulary } from './vocabulary';

export type CompletionKind =
  | 'keyword'
  | 'function'
  | 'type'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'macro'
  | 'snapshot'
  | 'setting'
  | 'snippet'
  | 'parameter'
  | 'hint';

export interface CompletionItem {
  readonly label: string;
  readonly kind: CompletionKind;
  /** Quoted when the name needs it or the word under the cursor is quoted. */
  readonly insertText: string;
  /** `insertText` is snippet syntax: `${1:name}` marks a place to fill in. */
  readonly snippet: boolean;
  readonly detail: string | undefined;
  /** Markdown. */
  readonly documentation: string | undefined;
  /** What VS Code filters by when it differs from the label; inside a quoted word the text with its quotes. */
  readonly filterText: string | undefined;
  /** Keeps the display order. */
  readonly sortText: string;
}

export interface Completions {
  /** The word up to the cursor: what an inserted item replaces. */
  readonly insert: Range;
  /** The whole word: what a replacing item replaces. */
  readonly replace: Range;
  readonly items: readonly CompletionItem[];
  /**
   * The columns of views that are still being read, which the items lack; it settles when the reads end, and a new
   * request then offers them. Undefined when the list is complete.
   */
  readonly pending: Promise<void> | undefined;
}

// Spacing between the ranks of two tables, so columns of the first table sort ahead of the second.
const RANKS_PER_TABLE = 100_000;

export interface Draft {
  readonly label: string;
  readonly kind: CompletionKind;
  readonly insertText: string;
  readonly snippet?: boolean;
  readonly detail?: string | undefined;
  readonly documentation?: string | undefined;
  readonly filterText?: string | undefined;
  /** Items of a lower group come first. */
  readonly group: number;
  /** Within a group by this, then by the label. */
  readonly rank?: number;
}

/** The ordered completion items at an offset; undefined inside a string literal, a comment or a number. */
export async function completionsAt(
  tokens: readonly SqlToken[],
  offset: number,
  vocabulary: Vocabulary,
  catalog: SqlCatalog,
): Promise<Completions | undefined> {
  const context = contextAt(tokens, offset, catalog.lake);
  if (context.position === 'inert') return undefined;
  const lookup = await openLookup(catalog);
  const drafts = await draftsAt(context, vocabulary, lookup, callAt(tokens, offset));
  const sorted = drafts.sort(
    (a, b) => a.group - b.group || (a.rank ?? 0) - (b.rank ?? 0) || compareIgnoringCase(a.label, b.label),
  );
  return {
    insert: context.insert,
    replace: context.replace,
    items: sorted.map((draft, index) => ({
      label: draft.label,
      kind: draft.kind,
      insertText: draft.insertText,
      snippet: draft.snippet ?? false,
      detail: draft.detail,
      documentation: draft.documentation,
      // VS Code filters by the text from the start of the range, which holds the opening quote.
      filterText: context.quoted ? draft.insertText : draft.filterText,
      sortText: String(index).padStart(6, '0'),
    })),
    pending: lookup.pending(),
  };
}

type Quote = (name: string) => string;

export interface Env {
  readonly drafts: Draft[];
  readonly context: CursorContext;
  readonly vocabulary: Vocabulary;
  readonly lookup: Lookup;
  /** The call whose arguments the cursor is in. */
  readonly call: CallContext | undefined;
  readonly quote: Quote;
  /** Keywords in list order; one listed by an earlier group is skipped. */
  keywords(names: readonly string[], group: number): void;
  allKeywords(group: number): void;
  functions(group: number, wanted: (fn: FunctionInfo) => boolean): void;
}

function envOf(
  context: CursorContext,
  vocabulary: Vocabulary,
  lookup: Lookup,
  call: CallContext | undefined,
): Env {
  const drafts: Draft[] = [];
  const listed = new Set<string>();
  const keyword = (name: string, group: number, rank?: number): void => {
    if (listed.has(name)) return;
    listed.add(name);
    drafts.push({ label: name, kind: 'keyword', insertText: name, group, rank });
  };
  return {
    drafts,
    context,
    vocabulary,
    lookup,
    call,
    quote: (name) =>
      context.quoted || needsQuotes(name, vocabulary.reserved) ? quoteIdentifier(name) : name,
    keywords: (names, group) => {
      for (const [rank, name] of names.entries()) keyword(name, group, rank);
    },
    allKeywords: (group) => {
      for (const { name } of vocabulary.keywords) keyword(name, group);
    },
    functions: (group, wanted) => {
      for (const fn of vocabulary.functions.values()) {
        if (wanted(fn)) drafts.push(functionDraft(fn, group, lookup.lake));
      }
    },
  };
}

type PositionDrafts = (env: Env) => void | Promise<void>;

const DRAFTS_AT: Record<Position, PositionDrafts> = {
  statement: (env) => {
    const { qualifier, statement, clause, inParentheses } = env.context;
    if (qualifier.length > 0) return;
    env.keywords(STATEMENT_KEYWORDS, 0);
    // Not in a subquery, after UNION or after WITH.
    if (statement === undefined && clause === '' && !inParentheses) statementSnippetDrafts(env, 1);
  },
  keyword: (env) => {
    const { qualifier, clause, statement } = env.context;
    if (qualifier.length > 0) return;
    // A query that starts with FROM goes on with SELECT.
    const fromFirst = statement === 'FROM' && clause === 'from' ? ['SELECT'] : [];
    env.keywords([...fromFirst, ...(NEXT_KEYWORDS[clause] ?? [])], 0);
    clauseSnippetDrafts(env, 1);
    env.allKeywords(2);
  },
  relation: async (env) => {
    await relationDrafts(env);
    const { statement, qualifier } = env.context;
    if (qualifier.length === 0 && (statement === 'DESCRIBE' || statement === 'SUMMARIZE')) {
      env.keywords(QUERY_KEYWORDS, 5);
    }
  },
  from: relationDrafts,
  'column-path': relationDrafts,
  'new-relation': schemaDrafts,
  schema: schemaDrafts,
  expression: expressionDrafts,
  'target-column': expressionDrafts,
  value: expressionDrafts,
  column: (env) => (env.context.qualifier.length > 0 ? undefined : scopeDrafts(env, { columnsOnly: true })),
  'copy-option': copyOptionDrafts,
  'copy-format': copyFormatDrafts,
  type: typeDrafts,
  setting: settingDrafts,
  call: callDrafts,
  'snapshot-clause': snapshotClauseDrafts,
  'snapshot-version': (env) => snapshotDrafts(env, VERSION_SNAPSHOTS),
  'snapshot-timestamp': (env) => snapshotDrafts(env, TIMESTAMP_SNAPSHOTS),
  name: () => undefined,
  inert: () => undefined,
};

async function draftsAt(
  context: CursorContext,
  vocabulary: Vocabulary,
  lookup: Lookup,
  call: CallContext | undefined,
): Promise<Draft[]> {
  const env = envOf(context, vocabulary, lookup, call);
  await DRAFTS_AT[context.position](env);
  if (context.position === 'value' || context.position === 'expression') namedArgumentDrafts(env);
  return env.drafts;
}

// Case-insensitive and locale-independent: the order is the same everywhere.
function compareIgnoringCase(a: string, b: string): number {
  const [first, second] = [a.toLowerCase(), b.toLowerCase()];
  return first < second ? -1 : first > second ? 1 : 0;
}

/** Whether a name must be quoted: not a plain word, or a word that DuckDB reserves. */
export function needsQuotes(name: string, reserved: ReadonlySet<string>): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name.toLowerCase());
}

// A function of DuckLake that takes the lake's name is inserted with it.
function functionDraft(fn: FunctionInfo, group: number, lake: string): Draft {
  const [overload] = fn.overloads;
  return {
    label: fn.name,
    kind: 'function',
    insertText: fn.lakeArgument ? lakeCallSnippet(fn, lake) : fn.name,
    snippet: fn.lakeArgument,
    detail: overload && signatureLabel(fn.name, overload),
    documentation: functionDocumentation(fn, lake),
    group,
  };
}

function entryDraft(entry: SqlEntry, text: string, group: number, label = nameOf(entry)): Draft {
  return entry.kind === 'table'
    ? {
        label,
        kind: 'table',
        insertText: text,
        detail: tableDescription(entry.table),
        documentation: tableTooltip(entry.schema, entry.table),
        filterText: label,
        group,
      }
    : {
        label,
        kind: 'view',
        insertText: text,
        detail: 'view',
        documentation: viewTooltip(entry.schema, entry.view),
        filterText: label,
        group,
      };
}

function schemaDraft(schema: SchemaInfo, text: string, group: number): Draft {
  return {
    label: schema.name,
    kind: 'schema',
    insertText: text,
    detail: 'schema',
    documentation: schemaTooltip(schema),
    filterText: schema.name,
    group,
  };
}

function lakeDraft(lake: string, group: number, quote: Quote): Draft {
  return { label: lake, kind: 'schema', insertText: quote(lake), detail: 'DuckLake catalog', group };
}

function macroDraft(name: string, detail: string, quote: Quote, group: number): Draft {
  return { label: name, kind: 'macro', insertText: quote(name), detail, group };
}

function schemaDrafts({ drafts, context, lookup, quote }: Env): void {
  const [first, ...more] = context.qualifier;
  if (
    first === undefined ||
    (more.length === 0 && context.position === 'schema' && same(first, lookup.lake))
  ) {
    for (const schema of lookup.schemas) drafts.push(schemaDraft(schema, quote(schema.name), 0));
  }
}

function typeDrafts({ drafts, vocabulary }: Env): void {
  for (const { name, category } of vocabulary.types) {
    drafts.push({
      label: name.toUpperCase(),
      kind: 'type',
      insertText: name.toUpperCase(),
      detail: category?.toLowerCase(),
      group: 0,
    });
  }
}

function settingDrafts({ drafts, vocabulary }: Env): void {
  for (const { name, type, description } of vocabulary.settings) {
    drafts.push({
      label: name,
      kind: 'setting',
      insertText: name,
      detail: type,
      documentation: description,
      group: 0,
    });
  }
}

function callDrafts({ drafts, context, vocabulary, lookup, quote }: Env): void {
  const [first] = context.qualifier;
  if (first === undefined) {
    drafts.push(lakeDraft(lookup.lake, 0, quote));
    for (const fn of vocabulary.functions.values()) {
      if (fn.procedure) drafts.push(functionDraft(fn, 1, lookup.lake));
    }
  } else if (context.qualifier.length === 1 && same(first, lookup.lake)) {
    for (const fn of vocabulary.lakeFunctions.values()) {
      if (fn.procedure) drafts.push(functionDraft(fn, 0, lookup.lake));
    }
  }
}

async function relationDrafts(env: Env): Promise<void> {
  if (env.context.qualifier.length === 0) await unqualifiedRelationDrafts(env);
  else await qualifiedRelationDrafts(env);
}

async function unqualifiedRelationDrafts({ drafts, context, vocabulary, lookup, quote }: Env): Promise<void> {
  const from = context.position === 'from';
  for (const name of context.ctes) {
    drafts.push({
      label: name,
      kind: 'table',
      insertText: quote(name),
      detail: 'common table expression',
      group: 0,
    });
  }
  for (const schema of lookup.schemas) drafts.push(schemaDraft(schema, quote(schema.name), 1));
  if (from) drafts.push(lakeDraft(lookup.lake, 1, quote));
  for (const entry of lookup.entries) {
    if (same(entry.schema.name, DEFAULT_SCHEMA)) {
      drafts.push(entryDraft(entry, quote(nameOf(entry)), 2));
    } else {
      const label = `${entry.schema.name}.${nameOf(entry)}`;
      drafts.push(entryDraft(entry, `${quote(entry.schema.name)}.${quote(nameOf(entry))}`, 3, label));
    }
  }
  if (!from) return;
  for (const macro of await lookup.catalog.macros(DEFAULT_SCHEMA)) {
    if (macro.kind === 'table') drafts.push(macroDraft(macro.name, 'table macro', quote, 2));
  }
  for (const fn of vocabulary.functions.values()) {
    if (fn.relation) drafts.push(functionDraft(fn, 4, lookup.lake));
  }
}

async function qualifiedRelationDrafts(env: Env): Promise<void> {
  const { context, lookup } = env;
  const columnPath = context.position === 'column-path';
  const named = await namedBy(
    context.qualifier,
    [],
    lookup,
    columnPath ? { unqualifiedTable: DEFAULT_SCHEMA } : {},
  );
  for (const item of named) {
    switch (item.kind) {
      case 'lake':
        lakeRelationDrafts(env);
        break;
      case 'schema':
        await schemaRelationDrafts(env, item.schema);
        break;
      case 'relation':
        if (columnPath) columnDrafts(env, item.entry, await lookup.columns(item.entry));
        break;
      case 'column':
        if (columnPath) fieldDrafts(env, item.column.children);
        break;
      case 'derived':
      case 'text-column':
        break;
    }
  }
}

function lakeRelationDrafts({ drafts, context, vocabulary, lookup, quote }: Env): void {
  for (const schema of lookup.schemas) drafts.push(schemaDraft(schema, quote(schema.name), 0));
  if (context.position !== 'from') return;
  for (const fn of vocabulary.lakeFunctions.values()) {
    if (fn.relation) drafts.push(functionDraft(fn, 1, lookup.lake));
  }
}

async function schemaRelationDrafts(
  { drafts, context, lookup, quote }: Env,
  schema: SchemaInfo,
): Promise<void> {
  for (const entry of lookup.entriesOf(schema.name)) drafts.push(entryDraft(entry, quote(nameOf(entry)), 0));
  if (context.position !== 'from') return;
  for (const macro of await lookup.catalog.macros(schema.name)) {
    if (macro.kind === 'table') drafts.push(macroDraft(macro.name, 'table macro', quote, 1));
  }
}

async function expressionDrafts(env: Env): Promise<void> {
  const { context } = env;
  await expressionColumnDrafts(env);
  if (context.qualifier.length > 0) return;
  if (context.position === 'target-column') {
    if (context.statement === 'ALTER') env.keywords(['COLUMN'], 4);
    return;
  }
  env.functions(3, (fn) => fn.expression);
  env.keywords(EXPRESSION_KEYWORDS, 4);
  env.allKeywords(5);
}

async function expressionColumnDrafts(env: Env): Promise<void> {
  const { context, lookup } = env;
  const { qualifier } = context;
  if (context.position === 'value') {
    if (qualifier.length === 0) await macroDrafts(env);
    return;
  }
  if (qualifier.length > 0) {
    // A lambda parameter hides a relation of the same name.
    if (context.locals.some((local) => same(local, qualifier[0] ?? ''))) return;
    for (const named of await namedBy(qualifier, context.scope, lookup)) await namedDrafts(env, named);
    return;
  }
  if (context.position === 'target-column') {
    const target = context.target && lookup.entry(context.target.schema, context.target.table);
    if (target) columnDrafts(env, target, await lookup.columns(target));
    return;
  }
  localDrafts(env);
  await scopeDrafts(env);
}

// The columns of the relations in scope; unless `columnsOnly`, their aliases and the macros too.
async function scopeDrafts(env: Env, { columnsOnly = false } = {}): Promise<void> {
  const { drafts, context, lookup, quote } = env;
  const lists = await columnLists(context.scope, lookup);
  // A column name shared by two relations of the query needs its qualifier.
  const counts = new Map<string, number>();
  for (const { columns } of lists) {
    for (const { name } of columns) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  }
  const shared = (column: string): boolean => (counts.get(column.toLowerCase()) ?? 0) > 1;
  for (const [index, list] of lists.entries()) {
    const { name } = list;
    const qualifierOf = (column: string): string | undefined =>
      shared(column) && name !== undefined ? quote(name) : undefined;
    const options = { qualifierOf, firstRank: index * RANKS_PER_TABLE };
    if (list.entry) {
      columnDrafts(env, list.entry, list.columns, options);
    } else {
      // A subquery without alias cannot qualify a shared column.
      const columns =
        name === undefined ? list.columns.filter((column) => !shared(column.name)) : list.columns;
      textColumnDrafts(env, columns, options);
    }
  }
  if (columnsOnly) return;
  const seen = new Set<string>();
  for (const { entry, name } of lists) {
    if (!entry || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    drafts.push({
      label: name,
      kind: entry.kind,
      insertText: quote(name),
      detail: `${entry.schema.name}.${nameOf(entry)}`,
      group: 1,
    });
  }
  await macroDrafts(env);
}

async function namedDrafts(env: Env, named: Named): Promise<void> {
  const { drafts, lookup, quote } = env;
  switch (named.kind) {
    case 'relation':
      columnDrafts(env, named.entry, await lookup.columns(named.entry));
      break;
    case 'column':
      fieldDrafts(env, named.column.children);
      break;
    case 'schema':
      for (const entry of lookup.entriesOf(named.schema.name))
        drafts.push(entryDraft(entry, quote(nameOf(entry)), 1));
      for (const macro of await lookup.catalog.macros(named.schema.name)) {
        if (macro.kind === 'scalar') drafts.push(macroDraft(macro.name, 'scalar macro', quote, 2));
      }
      break;
    case 'lake':
      for (const schema of lookup.schemas) drafts.push(schemaDraft(schema, quote(schema.name), 1));
      break;
    case 'derived':
      textColumnDrafts(env, named.columns);
      break;
    case 'text-column':
      break;
  }
}

// Scalar macros of the default schema are called without a schema.
async function macroDrafts({ drafts, lookup, quote }: Env): Promise<void> {
  for (const macro of await lookup.catalog.macros(DEFAULT_SCHEMA)) {
    if (macro.kind === 'scalar') drafts.push(macroDraft(macro.name, 'scalar macro', quote, 2));
  }
}

// `qualifierOf` gives the qualifier of the columns that need one.
function columnDrafts(
  env: Env,
  entry: SqlEntry,
  columns: readonly ColumnInfo[],
  {
    qualifierOf,
    firstRank = 0,
  }: { qualifierOf?: (column: string) => string | undefined; firstRank?: number } = {},
): void {
  const { drafts, quote } = env;
  if (entry.kind === 'view' && !env.lookup.catalog.viewsTrusted()) viewHint(env);
  for (const [position, column] of columns.entries()) {
    const qualifier = qualifierOf?.(column.name);
    drafts.push({
      label: qualifier === undefined ? column.name : `${qualifier}.${column.name}`,
      kind: 'column',
      insertText: `${qualifier === undefined ? '' : `${qualifier}.`}${quote(column.name)}`,
      detail: columnDescription({ ...column, type: typeText(column) }),
      documentation:
        entry.kind === 'table'
          ? columnTooltip(entry.schema, entry.table, [column.name], column)
          : viewColumnTooltip(entry.schema, entry.view, column),
      filterText: column.name,
      group: 0,
      rank: firstRank + position,
    });
  }
}

// Once per list, after the columns; accepting it keeps the typed word.
function viewHint({ drafts, context }: Env): void {
  if (drafts.some(({ kind }) => kind === 'hint')) return;
  drafts.push({
    label: 'No columns of views',
    kind: 'hint',
    insertText: context.quoted ? quoteIdentifier(context.partial) : context.partial,
    detail: "the connection's views are not trusted",
    documentation:
      'aantje learns the columns of a view only by binding it, which runs the SQL stored in the catalog with your rights. It does so only for a connection whose views you trusted, and never asks while you type: expand the `Columns` folder of a view in the explorer, or run **Select Top 1000 Rows** on a view, and confirm.',
    filterText: context.partial,
    group: 0,
    rank: Number.MAX_SAFE_INTEGER,
  });
}

function fieldDrafts({ drafts, quote }: Env, fields: readonly ColumnInfo[]): void {
  for (const [rank, field] of fields.entries()) {
    drafts.push({
      label: field.name,
      kind: 'column',
      insertText: quote(field.name),
      detail: columnDescription({ ...field, type: typeText(field) }),
      group: 0,
      rank,
    });
  }
}
