import type { MacroInfo, SchemaInfo, TableInfo } from '../catalog/model';
import type { TableLayout } from './catalog';
import { callAt, contextAt, DEFAULT_SCHEMA } from './context';
import { isWord } from './tokens';
import type { SqlToken } from './tokens';
import { columnInScope, namedBy, same } from './lookup';
import type { Lookup, Named, ScopeColumn } from './lookup';
import type { Range } from './script';
import {
  columnTooltip,
  inlineCode,
  macroTooltip,
  markdownText,
  schemaTooltip,
  tableTooltip,
  viewColumnTooltip,
  viewTooltip,
} from '../tree/format';
import type { FunctionInfo, Overload, Vocabulary } from './vocabulary';

export interface Hover {
  readonly range: Range;
  readonly markdown: string;
}

export interface SignatureHelp {
  readonly signatures: readonly {
    readonly label: string;
    readonly documentation: string | undefined;
    readonly parameters: readonly string[];
  }[];
  readonly activeSignature: number;
  readonly activeParameter: number;
}

/** `substring(string VARCHAR, start BIGINT) -> VARCHAR` */
export function signatureLabel(name: string, overload: Overload): string {
  const parameters = overload.parameters.map(parameterLabel);
  if (overload.varargs !== undefined) parameters.push(`${overload.varargs}...`);
  return `${name}(${parameters.join(', ')})${overload.returns === undefined ? '' : ` -> ${overload.returns}`}`;
}

function parameterLabel({ name, type, defaultValue, named }: Overload['parameters'][number]): string {
  if (named) return `${name} => ${type}`;
  return `${name} ${type}${defaultValue === undefined ? '' : ` := ${defaultValue}`}`;
}

/** A function's description and examples as Markdown; `{lake}` in an example becomes the lake name. */
export function functionDocumentation(fn: FunctionInfo, lake: string): string | undefined {
  const parts = [
    fn.description,
    ...fn.examples.map((example) => `Example: ${inlineCode(example.replaceAll('{lake}', lake))}`),
  ];
  const text = parts.filter((part) => part !== undefined).join('\n\n');
  return text === '' ? undefined : text;
}

type Callee =
  | { readonly kind: 'function'; readonly info: FunctionInfo }
  | { readonly kind: 'macro'; readonly schema: SchemaInfo; readonly macro: MacroInfo };

async function macroIn(schemaName: string, name: string, lookup: Lookup): Promise<Callee | undefined> {
  const schema = lookup.schema(schemaName);
  if (!schema) return undefined;
  const macro = (await lookup.catalog.macros(schema.name)).find((candidate) => same(candidate.name, name));
  return macro && { kind: 'macro', schema, macro };
}

async function calleeOf(
  qualifier: readonly string[],
  name: string,
  vocabulary: Vocabulary,
  lookup: Lookup,
): Promise<Callee | undefined> {
  const [head, second] = qualifier;
  if (head === undefined) {
    return (await macroIn(DEFAULT_SCHEMA, name, lookup)) ?? functionNamed(vocabulary.functions, name);
  }
  if (same(head, lookup.lake)) {
    if (second === undefined) return functionNamed(vocabulary.lakeFunctions, name);
    return qualifier.length === 2 ? macroIn(second, name, lookup) : undefined;
  }
  return qualifier.length === 1 ? macroIn(head, name, lookup) : undefined;
}

function functionNamed(functions: ReadonlyMap<string, FunctionInfo>, name: string): Callee | undefined {
  const info = functions.get(name.toLowerCase());
  return info && { kind: 'function', info };
}

function overloadsOf(callee: Callee): readonly { label: string; overload: Overload }[] {
  if (callee.kind === 'function') {
    return callee.info.overloads.map((overload) => ({
      label: signatureLabel(callee.info.name, overload),
      overload,
    }));
  }
  return callee.macro.implementations.map(({ parameters }) => {
    const overload: Overload = {
      parameters: parameters.map(({ name, type, defaultValue }) => ({
        name,
        type: type ?? 'ANY',
        ...(defaultValue === null ? {} : { defaultValue }),
      })),
      returns: undefined,
      varargs: undefined,
    };
    return { label: signatureLabel(callee.macro.name, overload), overload };
  });
}

/** The call at the cursor with the parameter being typed; undefined outside a known call. */
export async function signatureAt(
  tokens: readonly SqlToken[],
  offset: number,
  vocabulary: Vocabulary,
  lookup: Lookup,
): Promise<SignatureHelp | undefined> {
  const call = callAt(tokens, offset);
  const callee = call && (await calleeOf(call.qualifier, call.name, vocabulary, lookup));
  if (!call || !callee) return undefined;
  const overloads = overloadsOf(callee);
  const documentation =
    callee.kind === 'function' ? functionDocumentation(callee.info, lookup.lake) : undefined;
  const byName = (overload: Overload): number =>
    call.argumentName === undefined
      ? -1
      : overload.parameters.findIndex(({ name }) => same(name, call.argumentName ?? ''));
  // A named parameter is never passed by position.
  const positional = (overload: Overload): number => overload.parameters.filter(({ named }) => !named).length;
  const fits = (overload: Overload): boolean =>
    byName(overload) >= 0 ||
    (call.argumentName === undefined &&
      (call.activeParameter < positional(overload) || overload.varargs !== undefined));
  const chosen = Math.max(
    0,
    overloads.findIndex(({ overload }) => fits(overload)),
  );
  const active = overloads[chosen]?.overload;
  return {
    signatures: overloads.map(({ label, overload }) => ({
      label,
      documentation,
      parameters: [
        ...overload.parameters.map(parameterLabel),
        ...(overload.varargs === undefined ? [] : [`${overload.varargs}...`]),
      ],
    })),
    activeSignature: chosen,
    activeParameter:
      active && call.argumentName !== undefined ? Math.max(0, byName(active)) : call.activeParameter,
  };
}

/** Describes the word under the offset: a function, or a column, table, view, schema or macro; an ambiguous column gives nothing. */
export async function hoverAt(
  tokens: readonly SqlToken[],
  offset: number,
  vocabulary: Vocabulary,
  lookup: Lookup,
): Promise<Hover | undefined> {
  const index = tokens.findIndex((candidate) => candidate.start <= offset && offset < candidate.end);
  const token = tokens[index];
  if (!token || !isWord(token)) return undefined;
  const closedQuote = token.word.length > 1 && token.word.startsWith('"') && token.word.endsWith('"');
  const context = contextAt(tokens, closedQuote ? token.end - 1 : token.end, lookup.lake);
  if (context.position === 'inert') return undefined;
  const range = { offset: token.start, length: token.end - token.start };
  const name = context.partial;

  if (tokens[index + 1]?.word === '(') {
    const callee = await calleeOf(context.qualifier, name, vocabulary, lookup);
    return callee && { range, markdown: calleeText(callee, lookup.lake) };
  }
  const relationLike = ['relation', 'from', 'new-relation', 'column-path'].includes(context.position);
  const path = [...context.qualifier, name];
  // A lambda parameter hides the column or relation of the same name.
  if (context.locals.some((local) => same(local, path[0] ?? ''))) return undefined;
  const named = await namedBy(
    path,
    context.scope,
    lookup,
    relationLike ? { unqualifiedTable: DEFAULT_SCHEMA } : {},
  );
  const found = relationLike
    ? first(named, ['relation', 'schema', 'lake', 'column'])
    : first(named, ['column', 'text-column', 'relation', 'derived', 'schema', 'lake']);
  if (found?.kind === 'relation' && found.entry.kind === 'table') {
    const { schema, table } = found.entry;
    return {
      range,
      markdown: tableText(schema, table, await lookup.catalog.layout(schema.name, table.name)),
    };
  }
  if (found) return { range, markdown: namedText(found) };
  if (path.length === 1 && !relationLike) {
    const unique = await columnInScope(name, context.scope, lookup);
    return unique && { range, markdown: columnText(unique) };
  }
  return undefined;
}

const columnText = ({ name, source }: ScopeColumn): string =>
  namedText(source ?? { kind: 'text-column', name });

function first(named: readonly Named[], order: readonly Named['kind'][]): Named | undefined {
  for (const kind of order) {
    const match = named.find((candidate) => candidate.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/** The hover text of a name; also the documentation of a completed column that the SQL text gives. */
export function namedText(named: Named): string {
  switch (named.kind) {
    case 'column':
      return named.entry.kind === 'table'
        ? columnTooltip(named.entry.schema, named.entry.table, named.trail, named.column)
        : viewColumnTooltip(named.entry.schema, named.entry.view, named.column);
    case 'relation':
      return named.entry.kind === 'table'
        ? tableTooltip(named.entry.schema, named.entry.table)
        : viewTooltip(named.entry.schema, named.entry.view);
    case 'schema':
      return schemaTooltip(named.schema) ?? `${inlineCode(named.schema.name)} (schema)`;
    case 'lake':
      return 'The attached DuckLake. Its functions only exist in front of its name, e.g. `snapshots()`.';
    case 'derived': {
      const columns = named.columns.map(({ name }) => `- ${inlineCode(name)}`).join('\n');
      return columns === '' ? inlineCode(named.name) : `${inlineCode(named.name)}\n\n${columns}`;
    }
    case 'text-column':
      return inlineCode(named.name);
  }
}

// The tooltip of the tree plus the partition and sort keys, which the tree shows as folders. The transform, the
// direction and the null order are catalog text like the names: they go through `inlineCode` as in the tree.
function tableText(schema: SchemaInfo, table: TableInfo, { partitioning, sortOrder }: TableLayout): string {
  const keys = (partitioning?.columns ?? []).map(({ path, transform }) =>
    transform === 'identity'
      ? inlineCode(path.join('.'))
      : `${inlineCode(path.join('.'))} (${inlineCode(transform)})`,
  );
  const sorts = (sortOrder?.expressions ?? []).map(
    ({ expression, direction, nullOrder }) =>
      `${inlineCode(expression)} ${inlineCode(direction)} ${inlineCode(nullOrder.replaceAll('_', ' '))}`,
  );
  return [
    tableTooltip(schema, table),
    keys.length > 0 ? `Partitioned by ${keys.join(', ')}` : undefined,
    sorts.length > 0 ? `Sorted by ${sorts.join(', ')}` : undefined,
  ]
    .filter((part) => part !== undefined)
    .join('\n\n');
}

function calleeText(callee: Callee, lake: string): string {
  if (callee.kind === 'macro') return macroTooltip(callee.schema, callee.macro);
  const { info } = callee;
  const signatures = overloadsOf(callee).map(({ label }) => label);
  const shown = signatures.slice(0, 6);
  if (signatures.length > shown.length) shown.push(`... and ${signatures.length - shown.length} more`);
  const kind = info.qualified
    ? `${info.kind} function of the lake`
    : info.lakeArgument
      ? `${info.kind} function of DuckLake`
      : `${info.kind} function`;
  return [`\`\`\`sql\n${shown.join('\n')}\n\`\`\``, markdownText(kind), functionDocumentation(info, lake)]
    .filter((part) => part !== undefined)
    .join('\n\n');
}
