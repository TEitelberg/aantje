import type { CatalogReader } from '../../src/catalog/model';
import { buildGraph } from '../../src/dependencies/graph';
import type { BuildOptions, DependencyGraph } from '../../src/dependencies/graph';
import { openSqlParser } from '../../src/dependencies/parser';
import type { SqlParser } from '../../src/dependencies/parser';
import { readObjects } from '../../src/dependencies/read';

/** Every test in a file shares one parser; it opens its DuckDB on the first call. */
export function sharedParser(): SqlParser {
  return openSqlParser();
}

export const nameOf = (graph: DependencyGraph, index: number): string => {
  const node = graph.nodes[index];
  return node ? `${node.schema}.${node.name}` : `#${index}`;
};

/** `shop.big_events reads shop.events`, sorted. */
export const edgeList = (graph: DependencyGraph): string[] =>
  graph.edges.map(({ from, to, kind }) => `${nameOf(graph, from)} ${kind} ${nameOf(graph, to)}`).toSorted();

/** `shop.v: table s.gone`, sorted; a macro is written with its parentheses. */
export const brokenList = (graph: DependencyGraph): string[] =>
  graph.broken
    .map(
      ({ from, kind, schema, name }) =>
        `${nameOf(graph, from)}: ${kind === 'relation' ? 'table' : 'macro'} ${schema === '' ? '' : `${schema}.`}${name}`,
    )
    .toSorted();

/** `shop.v: dialect spark`, sorted. */
export const unresolvedList = (graph: DependencyGraph): string[] =>
  graph.unresolved
    .map(({ node, reason, detail }) => `${nameOf(graph, node)}: ${reason} ${detail}`)
    .toSorted();

/** The graph of a catalog as the report reads it. */
export async function graphOf(
  reader: CatalogReader,
  parser: SqlParser,
  options?: BuildOptions,
  snapshot?: number,
): Promise<DependencyGraph> {
  const at = snapshot ?? (await reader.info()).latestSnapshot;
  return buildGraph(await readObjects(reader, at), parser, options);
}

const quoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** The statement that adds a view to an edited SQLite copy of the history fixture, visible from snapshot 40 on. */
export const addView = (
  id: number,
  schemaId: number,
  name: string,
  sql: string,
  dialect = 'duckdb',
): string =>
  `INSERT INTO ducklake_view VALUES (${id}, 'view-${id}', 40, NULL, ${schemaId}, ${quoted(name)}, ${quoted(dialect)}, ${quoted(sql)}, '')`;

/** The statements that add a macro with one overload, visible from snapshot 40 on. */
export const addMacro = (
  id: number,
  schemaId: number,
  name: string,
  kind: 'scalar' | 'table',
  sql: string,
  dialect = 'duckdb',
): string[] => [
  `INSERT INTO ducklake_macro VALUES (${schemaId}, ${id}, ${quoted(name)}, 40, NULL)`,
  `INSERT INTO ducklake_macro_impl VALUES (${id}, 0, ${quoted(dialect)}, ${quoted(sql)}, '${kind}')`,
];

/** The schemas of the history fixture. */
export const MAIN = 0;
export const SHOP = 1;
