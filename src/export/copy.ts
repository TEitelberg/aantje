// The COPY statement of Run to File and Export: a whole result or relation written to a local file, without the row
// limit of the grid. Catalog names and paths are hostile input: the path is a literal, every column name an identifier.
import { basename, dirname } from 'node:path';
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import { kindOf } from '../data/grid-values';
import { FORMULA_START, neutralised, PLAIN_NUMBER } from '../grid/model';

/** The formats of the file; the extension of the chosen file decides. */
export type ExportFormat = 'csv' | 'parquet';

/**
 * How a CSV file holds text: `excel` puts a `'` before text that a spreadsheet would read as a formula, as the export of
 * the grid does; `exact` keeps every value as it is, for loading the file elsewhere.
 */
export type CsvText = 'excel' | 'exact';

/** The file that a run writes: the local path chosen in the save dialog, its format and, for CSV, how it holds text. */
export type ExportTarget =
  | { readonly path: string; readonly format: 'parquet' }
  | { readonly path: string; readonly format: 'csv'; readonly text: CsvText };

/** A column of a result as DuckDB binds it. */
export interface BoundColumn {
  readonly name: string;
  /** DuckDB type name, e.g. `DECIMAL(10,2)`. */
  readonly type: string;
}

/** The format that a file asks for by its extension, in any case; undefined for another extension. */
export function formatOfPath(path: string): ExportFormat | undefined {
  const extension = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  return extension === 'csv' || extension === 'parquet' ? extension : undefined;
}

/** Whether the COPY statement needs the bound columns of its query: CSV for Excel neutralises the text columns. */
export function needsColumns(target: ExportTarget): boolean {
  return target.format === 'csv' && target.text === 'excel';
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

// The names of the SELECT around the query for Excel; the query keeps its own names inside the CTE.
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
 * UTF-8 without a byte order mark, with a header row and commas. For Excel a SELECT around the query neutralises the
 * text columns and the header, so it needs the bound `columns`. Parquet keeps the DuckDB types and is compressed with
 * zstd.
 */
export function copyStatement(
  query: string,
  target: ExportTarget,
  columns: readonly BoundColumn[] = [],
): string {
  const source = needsColumns(target)
    ? `${prefixOf(target)}${query}\n) ${neutralisingSelect(columns)})`
    : `${prefixOf(target)}${query}\n)`;
  const options =
    target.format === 'parquet'
      ? 'FORMAT parquet, COMPRESSION zstd'
      : "FORMAT csv, HEADER true, DELIMITER ','";
  return `${source} TO ${quoteLiteral(target.path)} (${options})`;
}

// The columns of the CTE get positional names, so two columns of the same name stay apart; each keeps its own name,
// neutralised like a header of the grid's export.
function neutralisingSelect(columns: readonly BoundColumn[]): string {
  if (columns.length === 0) throw new Error('CSV for Excel needs the columns of the query.');
  const positions = columns.map((_, index) => quoteIdentifier(`c${index + 1}`));
  const values = columns.map(({ name, type }, index) => {
    const value = positions[index] ?? '';
    const shown = mayReadAsFormula(type) ? neutralisedSql(`CAST(${value} AS VARCHAR)`) : value;
    return `${shown} AS ${quoteIdentifier(neutralised(name))}`;
  });
  return `SELECT ${values.join(', ')} FROM ${RESULT} AS ${COLUMNS}(${positions.join(', ')})`;
}

// The CSV text of a number or a boolean is never read as a formula, and that of a struct, map, list or array starts with
// `{` or `[`. Every other type is written as text that may start like one: VARCHAR, a date, an ENUM, JSON, a BLOB, an
// INTERVAL (`-1 day`) and a UNION (the value of its member). The CSV writer casts each value to VARCHAR, so the cast here
// changes no text.
function mayReadAsFormula(type: string): boolean {
  const kind = kindOf(type);
  return kind === 'text' || (kind === 'nested' && !/^(STRUCT|MAP)\(|\]$/.test(type));
}

/** `neutralised` of the grid in SQL, on a VARCHAR value: the same two patterns, which RE2 reads like JavaScript. */
function neutralisedSql(value: string): string {
  const formula = `regexp_matches(${value}, ${quoteLiteral(FORMULA_START.source)})`;
  const minus = `starts_with(${value}, '-') AND NOT regexp_matches(${value}, ${quoteLiteral(PLAIN_NUMBER.source)})`;
  return `CASE WHEN ${formula} OR (${minus}) THEN '''' || ${value} ELSE ${value} END`;
}
