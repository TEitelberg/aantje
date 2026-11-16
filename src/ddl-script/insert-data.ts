import { qualifiedName, quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import type { SnapshotId } from '../catalog/model';
import { kindOf } from '../data/grid-values';
import type { BoundColumn } from '../export/copy';
import { count, groupedPlural } from '../shell/numbers';
import { checkedWrite, commented, isStatement, needing } from './check';
import type { CatalogCheck, Tokenize } from './check';
import { createLines, tableDdl } from './table-ddl';
import type { CreatedTable, TableDdl } from './table-ddl';

// Script as INSERT with Data: a table or view as a CREATE TABLE and INSERT statements with its rows. The engine writes
// the text of each row (`valuesQuery`): every value as '<DuckDB's text of the value>'::<type>, which gives the same
// value of every type back, and NULL as NULL. The script holds no value and no name in a comment. The types come from
// DuckDB and can hold catalog text (the quoted field names of a struct), so one INSERT goes through DuckDB's tokenizer
// (`checkedWrite`), with each distinct type once, and the INSERT statements of the rows are written like it.

/** The rows of one INSERT statement. */
export const BATCH_ROWS = 1000;
/** Above this many rows, aantje asks before it reads them. */
export const ROW_LIMIT = 100_000;
/** Above this size of the script, in bytes (2 MB), aantje asks before it reads the rows. */
export const SIZE_LIMIT = 2 * 1024 * 1024;

/** Whether the rows or the size of the script are above a limit, so that aantje asks before it reads the rows. */
export const overLimits = (rows: number, bytes: number): boolean => rows > ROW_LIMIT || bytes > SIZE_LIMIT;

// Characters that do not survive in an editor or the parser: DuckDB's parser ends the text at a NUL, VS Code turns a
// carriage return into the line break of the document and offers to remove the line and paragraph separators. In a
// value they are written as chr(n), joined to the parts of the literal with ||.
const KEPT_APART = [0, 13, 0x2028, 0x2029];
const KEPT_APART_PATTERN = quoteLiteral('[\\x00\\r\\x{2028}\\x{2029}]');

// The value of a text column (`t1`, ...) in the INSERT: NULL, or the literal with its cast.
function valueSql(text: string, type: string): string {
  const cast = `'::${type}`;
  const kind = kindOf(type);
  // The text of a number or a boolean never holds a quote or one of the characters above.
  if (kind === 'number' || kind === 'boolean') {
    return `CASE WHEN ${text} IS NULL THEN 'NULL' ELSE '''' || ${text} || ${quoteLiteral(cast)} END`;
  }
  const quoted = `replace(${text}, '''', '''''')`;
  const apart = KEPT_APART.reduce(
    (inner, code) => `replace(${inner}, chr(${code}), ''' || chr(${code}) || ''')`,
    quoted,
  );
  return [
    `CASE WHEN ${text} IS NULL THEN 'NULL'`,
    `WHEN regexp_matches(${text}, ${KEPT_APART_PATTERN}) THEN '(''' || ${apart} || ${quoteLiteral(`')${cast.slice(1)}`)}`,
    `ELSE '''' || ${quoted} || ${quoteLiteral(cast)} END`,
  ].join(' ');
}

/**
 * The text of each row of the relation as the INSERT statement holds it, `('1'::INTEGER, NULL, ...)`, in the column
 * `line`. `relation` is the quoted name in the engine; the columns are taken by position, so that two columns of a view
 * with the same name stay apart.
 */
export function valuesQuery(relation: string, columns: readonly BoundColumn[]): string {
  const positions = columns.map((_, index) => quoteIdentifier(`c${index + 1}`));
  const texts = columns.map((_, index) => quoteIdentifier(`t${index + 1}`));
  const casts = positions.map((position, index) => `CAST(${position} AS VARCHAR) AS ${texts[index] ?? ''}`);
  const values = columns.map(({ type }, index) => valueSql(texts[index] ?? '', type));
  return [
    `SELECT '(' || ${values.join(" || ', ' || ")} || ')' AS line`,
    `FROM (SELECT ${casts.join(', ')} FROM (SELECT * FROM ${relation}) AS source(${positions.join(', ')})) AS texts`,
  ].join('\n');
}

/** One row: the rows, the bytes of their text in UTF-8 and the line breaks in it, for `scriptBytes`. */
export function measureQuery(relation: string, columns: readonly BoundColumn[]): string {
  return [
    "SELECT count(*), coalesce(sum(strlen(line)), 0), coalesce(sum(strlen(line) - strlen(replace(line, chr(10), ''))), 0)",
    `FROM (${valuesQuery(relation, columns)}) AS script_rows`,
  ].join('\n');
}

/** What the measure of a relation found: the rows, and the bytes and line breaks of their text in the INSERT statements. */
export interface RowsMeasure {
  readonly rows: number;
  readonly bytes: number;
  readonly lineBreaks: number;
}

/** What the CREATE TABLE is made of: a table as Script as CREATE writes it, or the columns that DuckDB binds for a view. */
export type InsertSource =
  { readonly kind: 'table'; readonly table: CreatedTable } | { readonly kind: 'view' };

export interface InsertInput {
  readonly schemaName: string;
  readonly name: string;
  readonly source: InsertSource;
  /** The columns as DuckDB binds them; their types are the casts of the values. */
  readonly columns: readonly BoundColumn[];
  readonly rows: number;
  /** The snapshot that the rows are read at; undefined: the newest. */
  readonly snapshot: SnapshotId | undefined;
}

/** The script around the INSERT statements of the rows, which `batchText` writes. */
export interface InsertScript {
  /** From the header to the line before the first INSERT, ending in a line break. */
  readonly head: string;
  /** `INSERT INTO "s"."t" VALUES`, the first line of each INSERT. */
  readonly into: string;
  /** False when the INSERT statements are comments, under the notes at the end of `head`. */
  readonly live: boolean;
  /** `COMMIT;` and a line break. */
  readonly tail: string;
}

const RUN_NOTE = `-- Run it in a read/write SQL session: it creates the schema and the table, then inserts the rows ${count(BATCH_ROWS)} at a time, all in one transaction.`;
const VIEW_NOTE =
  '-- The rows of a view as a table, with the columns and types that DuckDB binds for the view.';

function header({ snapshot, rows, source }: InsertInput): string[] {
  const at = snapshot === undefined ? 'the newest snapshot' : `snapshot ${snapshot}`;
  return [
    `-- Script as INSERT with Data at ${at}: ${groupedPlural(rows, 'row')}. Nothing has run.`,
    RUN_NOTE,
    ...(source.kind === 'view' ? [VIEW_NOTE] : []),
  ];
}

// The CREATE TABLE of a view: its columns with the types that DuckDB binds, which are catalog text.
function viewTableDdl(input: InsertInput, check: CatalogCheck): TableDdl {
  const definitions = input.columns.map(({ name, type }) => `  ${quoteIdentifier(name)} ${type}`);
  const made = check(
    `CREATE TABLE ${qualifiedName(input.schemaName, input.name)} (\n${definitions.join(',\n')}\n);`,
    input.columns.map(({ type }) => type),
  );
  return { notes: made.notes, create: made.statement, live: isStatement(made.statement), followUps: [] };
}

/**
 * The script of the rows around their INSERT statements. One INSERT with a NULL of each type stands for them in the
 * check: the INSERT statements of the rows differ from it only in string literals, which cannot open anything.
 */
export async function insertScript(input: InsertInput, tokenize: Tokenize): Promise<InsertScript> {
  const into = `INSERT INTO ${qualifiedName(input.schemaName, input.name)} VALUES`;
  const inserts = input.rows > 0 && input.columns.length > 0;
  const probe = `${into}\n(${input.columns.map(({ type }) => `NULL::${type}`).join(', ')});`;
  const types = [...new Set(input.columns.map(({ type }) => type))];
  const made = await checkedWrite((check) => {
    const ddl =
      input.source.kind === 'table'
        ? tableDdl(input.schemaName, input.source.table, check)
        : viewTableDdl(input, check);
    const checked = check(probe, types);
    // The probe stands last among the notes and statements of the INSERT; the INSERT statements of the rows replace it.
    const insert = !inserts ? [] : !ddl.live ? needing(probe) : [...checked.notes, checked.statement];
    const before = [
      ...header(input),
      'BEGIN TRANSACTION;',
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(input.schemaName)};`,
      ...createLines(ddl),
      ...insert.slice(0, -1),
    ];
    return {
      entries: [...before, ...insert.slice(-1), 'COMMIT;'],
      before,
      live: ddl.live && isStatement(checked.statement),
    };
  }, tokenize);
  return { head: `${made.before.join('\n')}\n`, into, live: made.live, tail: 'COMMIT;\n' };
}

/** One INSERT statement with the rows (each the `line` of `valuesQuery`), ending in a line break; a comment when not live. */
export function batchText(script: Pick<InsertScript, 'into' | 'live'>, lines: readonly string[]): string {
  const statement = `${script.into}\n${lines.join(',\n')};`;
  return `${script.live ? statement : commented(statement)}\n`;
}

/**
 * The size of the script in UTF-8 bytes, from the measure of its rows: head and tail, the first line of each INSERT,
 * the text of the rows and the two characters after each row (`,\n` or `;\n`). A commented INSERT has `-- ` in front
 * of each of its lines, the line breaks inside the values included.
 */
export function scriptBytes(script: InsertScript, measure: RowsMeasure): number {
  const batches = Math.ceil(measure.rows / BATCH_ROWS);
  const bytes =
    Buffer.byteLength(script.head) +
    Buffer.byteLength(script.tail) +
    batches * (Buffer.byteLength(script.into) + 1) +
    measure.bytes +
    measure.rows * 2;
  return script.live ? bytes : bytes + 3 * (batches + measure.rows + measure.lineBreaks);
}
