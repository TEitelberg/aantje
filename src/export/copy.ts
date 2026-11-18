// The COPY statement of Run to File and Export: a whole result or relation written to a local file, without the row
// limit of the grid. Catalog names and paths are hostile input: the path is a literal, every column name an identifier.
import { basename, dirname } from 'node:path';
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { markdownHead, nullCell, SQL_LINE_BREAK, SQL_SPECIAL } from './markdown';
import type { MarkdownNull } from './markdown';

/** The formats of the file; the extension of the chosen file decides. */
export type ExportFormat = 'csv' | 'parquet' | 'json' | 'markdown';

/** How a JSON file holds the rows: one object per line (newline-delimited JSON), or one array of objects. */
export type JsonLayout = 'lines' | 'array';

/**
 * The file that a run writes: the local path chosen in the save dialog and its format; for JSON, its layout; for
 * Markdown, how a NULL shows. A CSV file holds every value as DuckDB writes it.
 */
export type ExportTarget =
  | { readonly path: string; readonly format: 'parquet' | 'csv' }
  | { readonly path: string; readonly format: 'json'; readonly layout: JsonLayout }
  | { readonly path: string; readonly format: 'markdown'; readonly nulls: MarkdownNull };

/** A column of a result as DuckDB binds it. */
export interface BoundColumn {
  readonly name: string;
  /** DuckDB type name, e.g. `DECIMAL(10,2)`. */
  readonly type: string;
}

const EXTENSIONS: Readonly<Record<string, ExportFormat>> = {
  csv: 'csv',
  parquet: 'parquet',
  json: 'json',
  ndjson: 'json',
  jsonl: 'json',
  md: 'markdown',
  markdown: 'markdown',
};

/** The extension of a file name in lower case, without the dot; empty for none. */
export function extensionOf(path: string): string {
  return /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
}

/** The format that a file asks for by its extension, in any case; undefined for another extension. */
export function formatOfPath(path: string): ExportFormat | undefined {
  return Object.hasOwn(EXTENSIONS, extensionOf(path)) ? EXTENSIONS[extensionOf(path)] : undefined;
}

/**
 * Whether the COPY statement needs the bound columns of its query: Markdown writes each column as the text of a cell,
 * under a header of the names.
 */
export function needsColumns(target: ExportTarget): boolean {
  return target.format === 'markdown';
}

/** Counts the rows of a query, before a Markdown file is written. */
export function countQuery(query: string): string {
  return `SELECT count(*) FROM (\n${query}\n) AS ${RESULT}`;
}

/** Binds a query without running it; each row of the result holds the name and the type of one column. */
export function describeQuery(query: string): string {
  return `DESCRIBE ${query}`;
}

/**
 * The message for a file that the engine could not write, when its message names the file of the target or the
 * temporary file that DuckDB writes next to it (folder gone, access denied, open in another program); undefined for
 * another failure, such as a data file of the lake that cannot be read.
 */
export function fileWriteFailure(message: string, path: string): string | undefined {
  const match = /Cannot open file "([^"]+)": ([^\r\n]*)/.exec(message);
  const named = match?.[1];
  if (!match || !named || dirname(named) !== dirname(path) || !basename(named).endsWith(basename(path))) {
    return undefined;
  }
  return `Cannot write the file "${path}": ${(match[2] ?? '').replace(/\.$/, '')}.`;
}

// The names of the SELECT around the query for Markdown; the query keeps its own names inside the CTE.
const RESULT = 'aantje_result';
const COLUMNS = 'aantje_columns';

/** Where the query starts in the statement of `copyStatement`: error positions of the engine map back by it. */
export function queryOffset(target: ExportTarget): number {
  return prefixOf(target).length;
}

// The text before the query does not depend on the columns, so that a caller knows where the query starts before it
// binds the columns. A line break follows the query, in case it ends in a comment.
function prefixOf(target: ExportTarget): string {
  return needsColumns(target) ? `COPY (WITH ${RESULT} AS (\n` : 'COPY (\n';
}

/**
 * The statement that writes all rows of `query` to the file of the target: `COPY (<query>) TO '<path>' (...)`. CSV is
 * UTF-8 without a byte order mark, with a header row and commas, every value as DuckDB writes it. Parquet keeps the
 * DuckDB types and is compressed with zstd. JSON is DuckDB's, one object per row with nested values nested. Markdown is
 * a table that a SELECT around the query writes line by line, so it needs the bound `columns`.
 */
export function copyStatement(
  query: string,
  target: ExportTarget,
  columns: readonly BoundColumn[] = [],
): string {
  const source =
    target.format === 'markdown'
      ? `${prefixOf(target)}${query}\n) ${markdownSelect(columns, target.nulls)})`
      : `${prefixOf(target)}${query}\n)`;
  return `${source} TO ${quoteLiteral(target.path)} (${copyOptions(target, columns)})`;
}

function copyOptions(target: ExportTarget, columns: readonly BoundColumn[]): string {
  switch (target.format) {
    case 'parquet':
      return 'FORMAT parquet, COMPRESSION zstd';
    case 'json':
      return target.layout === 'array' ? 'FORMAT json, ARRAY true' : 'FORMAT json';
    case 'markdown':
      // DuckDB has no Markdown writer: its CSV writer puts out the lines of the table as they are, without quotes, after
      // the header; the suffix ends the last line.
      return `FORMAT csv, HEADER false, QUOTE '', ESCAPE '', PREFIX ${quoteLiteral(markdownHead(columns.map(({ name }) => name)))}, SUFFIX ${quoteLiteral('\n')}`;
    case 'csv':
      return "FORMAT csv, HEADER true, DELIMITER ','";
  }
}

// One line of the table per row, from the text of each value: `markdownCell` of markdown.ts in SQL. A struct, map, list
// or array is written as JSON, as the grid shows it; every other value as DuckDB casts it to text.
function markdownSelect(columns: readonly BoundColumn[], nulls: MarkdownNull): string {
  if (columns.length === 0) throw new Error('Markdown needs the columns of the query.');
  const positions = columns.map((_, index) => quoteIdentifier(`c${index + 1}`));
  const cells = columns.map(({ type }, index) => {
    const value = positions[index] ?? '';
    const text = /^(STRUCT|MAP)\(|\]$/.test(type)
      ? `CAST(to_json(${value}) AS VARCHAR)`
      : `CAST(${value} AS VARCHAR)`;
    const escaped = `regexp_replace(regexp_replace(${text}, ${quoteLiteral(SQL_SPECIAL[0])}, ${quoteLiteral(SQL_SPECIAL[1])}, 'g'), ${quoteLiteral(SQL_LINE_BREAK[0])}, ${quoteLiteral(SQL_LINE_BREAK[1])}, 'g')`;
    return `COALESCE(${escaped}, ${quoteLiteral(nullCell(nulls))})`;
  });
  const line = `'| ' || ${cells.join(" || ' | ' || ")} || ' |'`;
  return `SELECT ${line} AS line FROM ${RESULT} AS ${COLUMNS}(${positions.join(', ')})`;
}
