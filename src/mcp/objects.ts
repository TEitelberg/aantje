// The tools list_objects and describe_object: the schemas, tables, views and macros of a lake, and one of them with
// its columns, layout, definition and dependencies, as the explorer shows them at its snapshot. Free of the VS Code
// API.
import * as z from 'zod';
import { sqlType } from '../catalog/ddl';
import type { ColumnInfo, MacroInfo, SchemaInfo, TableInfo, TagsInfo, ViewInfo } from '../catalog/model';
import { macroNodeKind, NODE_KINDS } from '../dependencies/graph';
import type { DependencyGraph } from '../dependencies/graph';
import { traverse } from '../dependencies/model';
import type { SqlParser } from '../dependencies/parser';
import { readGraph } from '../dependencies/read';
import { byName } from '../order';
import { named, schemaOf, ToolError } from './catalog';
import type { OpenCatalog } from './catalog';

const text = z.string();
const note = z.string().nullable();

export const OBJECTS = z.object({
  connection: text,
  snapshot: z.number(),
  schemas: z.array(
    z.object({
      name: text,
      comment: note,
      tables: z.array(
        z.object({
          name: text,
          comment: note,
          rows: z.number(),
          rowsApproximate: z.boolean(),
          files: z.number(),
          sizeBytes: z.number(),
        }),
      ),
      views: z.array(z.object({ name: text, comment: note })),
      macros: z.array(z.object({ name: text, kind: z.enum(['scalar', 'table']) })),
    }),
  ),
});

type Objects = z.infer<typeof OBJECTS>;

const tableEntry = (table: TableInfo): Objects['schemas'][number]['tables'][number] => ({
  name: table.name,
  comment: table.comment,
  rows: table.stats.rows,
  rowsApproximate: table.stats.approximate === true,
  files: table.stats.files,
  sizeBytes: table.stats.sizeBytes,
});

/** The schemas of the lake, or the one named, with their tables, views and macros by name. */
export async function listObjects(
  catalog: OpenCatalog,
  schema: string | undefined,
  signal: AbortSignal,
): Promise<Objects> {
  const { reader, snapshot } = catalog;
  const schemas =
    schema === undefined
      ? (await reader.schemas(snapshot)).toSorted(byName)
      : [await schemaOf(catalog, schema)];
  // Views and macros in one statement each; the tables per schema, as the explorer reads them.
  const only = schema === undefined ? null : (schemas[0]?.id ?? null);
  const [views, macros] = await Promise.all([reader.views(only, snapshot), reader.macros(only, snapshot)]);
  const entries: Objects['schemas'] = [];
  for (const { id, name, comment } of schemas) {
    signal.throwIfAborted();
    const tables = await reader.tables(id, snapshot);
    entries.push({
      name,
      comment,
      tables: tables.toSorted(byName).map(tableEntry),
      views: views
        .filter((view) => view.schemaId === id)
        .toSorted(byName)
        .map((view) => ({ name: view.name, comment: view.comment })),
      macros: macros
        .filter((macro) => macro.schemaId === id)
        .toSorted(byName)
        .map((macro) => ({ name: macro.name, kind: macro.kind })),
    });
  }
  return { connection: catalog.profile.name, snapshot, schemas: entries };
}

const KIND = z.enum(NODE_KINDS);
const RELATED = z.object({
  kind: KIND,
  schema: text,
  name: text,
  /** 1 for an object next to this one. */
  depth: z.number(),
  via: z.enum(['reads', 'calls']),
});
const PATH = z.array(text);

export const DESCRIPTION = z.object({
  connection: text,
  snapshot: z.number(),
  kind: KIND,
  schema: text,
  name: text,
  comment: note,
  columns: z
    .array(z.object({ name: text, type: text, nullable: z.boolean(), default: note, comment: note }))
    .optional(),
  rows: z.number().optional(),
  rowsApproximate: z.boolean().optional(),
  files: z.number().optional(),
  sizeBytes: z.number().optional(),
  partitioning: z
    .array(z.object({ column: PATH, transform: text }))
    .nullable()
    .optional(),
  sortOrder: z
    .array(z.object({ expression: text, direction: text, nulls: text }))
    .nullable()
    .optional(),
  tags: z.array(z.object({ column: PATH.nullable(), key: text, value: text })).optional(),
  sql: text.optional(),
  dialect: text.optional(),
  columnAliases: z.array(text).optional(),
  implementations: z
    .array(
      z.object({
        dialect: text,
        parameters: z.array(z.object({ name: text, type: note, default: note })),
        sql: text,
      }),
    )
    .optional(),
  dependencies: z.object({
    uses: z.array(RELATED),
    usedBy: z.array(RELATED),
    brokenReferences: z.array(z.object({ kind: text, schema: text, name: text })),
    unresolved: z.array(z.object({ reason: text, detail: text })),
    cycle: z.boolean(),
    omitted: z.number(),
  }),
});

type Description = z.infer<typeof DESCRIPTION>;

export const OBJECT_KINDS = ['table', 'view', 'macro'] as const;
type ObjectKind = (typeof OBJECT_KINDS)[number];

type Found =
  | { readonly kind: 'table'; readonly item: TableInfo }
  | { readonly kind: 'view'; readonly item: ViewInfo }
  | { readonly kind: 'macro'; readonly item: MacroInfo };

const KIND_WORD: Readonly<Record<ObjectKind, string>> = {
  table: 'a table',
  view: 'a view',
  macro: 'a macro',
};

async function findObject(
  catalog: OpenCatalog,
  schema: SchemaInfo,
  name: string,
  kind: ObjectKind | undefined,
): Promise<Found> {
  const { reader, snapshot } = catalog;
  const [tables, views, macros] = await Promise.all([
    reader.tables(schema.id, snapshot),
    reader.views(schema.id, snapshot),
    reader.macros(schema.id, snapshot),
  ]);
  const found: Found[] = [
    ...named(tables, name).map((item) => ({ kind: 'table' as const, item })),
    ...named(views, name).map((item) => ({ kind: 'view' as const, item })),
    ...named(macros, name).map((item) => ({ kind: 'macro' as const, item })),
  ].filter((candidate) => kind === undefined || candidate.kind === kind);
  const [first] = found;
  if (!first) {
    const what = kind ?? 'table, view or macro';
    throw new ToolError(`The schema "${schema.name}" has no ${what} "${name}" at snapshot ${snapshot}.`);
  }
  if (found.length > 1) {
    const kinds = found.map((candidate) => KIND_WORD[candidate.kind]).join(' and ');
    throw new ToolError(
      `"${name}" in "${schema.name}" names ${kinds}; say which with kind, and use the exact spelling.`,
    );
  }
  return first;
}

const tagList = (tags: TagsInfo): NonNullable<Description['tags']> => [
  ...tags.table.map(({ key, value }) => ({ column: null, key, value })),
  ...tags.columns.map(({ path, key, value }) => ({ column: [...path], key, value })),
];

const columnEntry = (column: ColumnInfo): NonNullable<Description['columns']>[number] => ({
  name: column.name,
  type: sqlType(column),
  nullable: column.nullable,
  default: column.defaultValue,
  comment: column.comment,
});

async function tableDetails(catalog: OpenCatalog, table: TableInfo): Promise<Partial<Description>> {
  const { reader, snapshot } = catalog;
  const columns = await reader.columns(table.id, snapshot);
  const [partitioning, sortOrder, tags] = await Promise.all([
    reader.partitioning(table.id, snapshot, columns),
    reader.sortOrder(table.id, snapshot),
    reader.tags(table.id, snapshot, columns),
  ]);
  return {
    columns: columns.map(columnEntry),
    ...tableEntry(table),
    partitioning:
      partitioning?.columns.map(({ path, transform }) => ({ column: [...path], transform })) ?? null,
    sortOrder:
      sortOrder?.expressions.map(({ expression, direction, nullOrder }) => ({
        expression,
        direction,
        nulls: nullOrder,
      })) ?? null,
    tags: tagList(tags),
  };
}

const viewDetails = (view: ViewInfo): Partial<Description> => ({
  sql: view.sql,
  dialect: view.dialect,
  columnAliases: [...view.columnAliases],
});

const macroDetails = (macro: MacroInfo): Partial<Description> => ({
  implementations: macro.implementations.map(({ dialect, parameters, sql }) => ({
    dialect,
    parameters: parameters.map((parameter) => ({
      name: parameter.name,
      type: parameter.type,
      default: parameter.defaultValue,
    })),
    sql,
  })),
});

/** Everything the object uses and everything that uses it, at any depth, and what its SQL does not resolve. */
function dependenciesOf(graph: DependencyGraph, start: number): Description['dependencies'] {
  const related = (direction: 'dependsOn' | 'usedBy') => {
    const traversal = traverse(graph, start, direction, Number.POSITIVE_INFINITY);
    return {
      cycle: traversal.cycle,
      omitted: traversal.omitted,
      rows: traversal.rows.flatMap(({ node, depth, via }) => {
        const object = graph.nodes[node];
        return object ? [{ kind: object.kind, schema: object.schema, name: object.name, depth, via }] : [];
      }),
    };
  };
  const uses = related('dependsOn');
  const usedBy = related('usedBy');
  return {
    uses: uses.rows,
    usedBy: usedBy.rows,
    brokenReferences: graph.broken
      .filter(({ from }) => from === start)
      .map(({ kind, schema, name }) => ({ kind, schema, name })),
    unresolved: graph.unresolved
      .filter(({ node }) => node === start)
      .map(({ reason, detail }) => ({ reason, detail })),
    cycle: uses.cycle || usedBy.cycle,
    omitted: uses.omitted + usedBy.omitted,
  };
}

const NO_DEPENDENCIES: Description['dependencies'] = {
  uses: [],
  usedBy: [],
  brokenReferences: [],
  unresolved: [],
  cycle: false,
  omitted: 0,
};

/** A table, view or macro with its details and its dependencies at the snapshot of the explorer. */
export async function describeObject(
  catalog: OpenCatalog,
  parser: SqlParser,
  object: { readonly schema: string; readonly name: string; readonly kind?: ObjectKind },
  signal: AbortSignal,
): Promise<Description> {
  const schema = await schemaOf(catalog, object.schema);
  const found = await findObject(catalog, schema, object.name, object.kind);
  signal.throwIfAborted();
  const kind = found.kind === 'macro' ? macroNodeKind(found.item) : found.kind;
  const details =
    found.kind === 'table'
      ? await tableDetails(catalog, found.item)
      : found.kind === 'view'
        ? viewDetails(found.item)
        : macroDetails(found.item);
  const graph = await readGraph(catalog.reader, parser, catalog.snapshot, signal);
  const start = graph.nodes.findIndex((node) => node.kind === kind && node.id === found.item.id);
  return {
    connection: catalog.profile.name,
    snapshot: catalog.snapshot,
    kind,
    schema: schema.name,
    name: found.item.name,
    comment: found.kind === 'macro' ? null : found.item.comment,
    ...details,
    dependencies: start < 0 ? NO_DEPENDENCIES : dependenciesOf(graph, start),
  };
}
