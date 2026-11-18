// How the SQL session plans a script before it runs it: the `{{name}}` placeholders replaced and the inline defaults of
// `$name{default}` blanked out, the statements cut by DuckDB's tokens and checked by its parser, each with what it does
// and the way back to the script as written; and how a statement gets the values of its `$name` placeholders.
import type * as Duckdb from '@duckdb/node-api';
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import type { Engine } from '../duckdb/engine';
import { messageOf } from '../errors';
import {
  dateParts,
  findPlaceholders,
  numberValue,
  replacePlaceholders,
  sqlText,
  withoutDefault,
} from './parameters';
import type { BoundValue, RunParameters } from './parameters';
import { tokenRows } from './parser-engine';
import { splitScript, statementSpans, textTokens } from './script';
import type { ScriptStatement } from './script';
import { statementKind } from './statement-kind';
import type { SqlToken } from './tokens';

/** The text that a statement runs as, and the way back from an offset in it to the statement as written. */
export interface Runnable {
  readonly text: string;
  /** An offset into `text` as an offset into the statement as written; `end` for the end of a range. */
  readonly back: (offset: number, end?: boolean) => number;
}

/**
 * A statement of a script as it runs: `sql`, `offset` and `keyword` as written (the placeholders kept), `text` with its
 * `{{name}}` replaced, and whether it may change the catalog (`statement-kind.ts`).
 */
export interface Planned extends ScriptStatement, Runnable {
  readonly changesCatalog: boolean;
  /**
   * A query in which nothing writes and which has no placeholders: the results may run its text again, for the
   * summary of its columns or Aggregate in DuckDB.
   */
  readonly readsOnly: boolean;
  /** The tokens of `text`, with offsets into `text`. */
  readonly tokens: readonly SqlToken[];
  /** The names of the parameters that the statement uses. */
  readonly parameters: readonly string[];
}

/** A script that could not be split, with the text that was split and the way back from it to the script as written. */
export class SplitFailure extends Error {
  constructor(
    cause: unknown,
    readonly text: string,
    readonly toOriginal: (offset: number, end?: boolean) => number,
  ) {
    super(messageOf(cause), { cause });
  }
}

type Parser = Pick<Duckdb.DuckDBConnection, 'runAndReadAll' | 'extractStatements'>;

/**
 * The statements of a script: its `{{name}}` replaced by their SQL text and the braces of `$name{default}` by blanks
 * (DuckDB knows no inline default), then cut at the terminators of DuckDB's tokens; the parser has to agree on the
 * number. Throws a `SplitFailure`, also for a placeholder without a value.
 */
export async function planScript(
  parser: Parser,
  script: string,
  parameters: RunParameters | undefined,
): Promise<Planned[]> {
  const written = await tokenRows(parser, script);
  const placeholders = findPlaceholders(script, textTokens(script, written));
  const missing = placeholders.find(({ kind, name }) => kind === 'text' && !parameters?.text.has(name));
  const { text, toOriginal } = replacePlaceholders(script, placeholders, (placeholder) =>
    placeholder.kind === 'text' ? parameters?.text.get(placeholder.name) : withoutDefault(placeholder),
  );
  try {
    if (missing) throw new Error(`The placeholder {{${missing.name}}} has no value`);
    const rows = text === script ? written : await tokenRows(parser, text);
    // Both cut the tokens alike, so the n-th span is the n-th statement.
    const spans = statementSpans(textTokens(text, rows));
    const statements = splitScript(text, rows).map((statement, index): Planned => {
      const tokens = spans[index]?.tokens ?? [];
      const start = toOriginal(statement.offset);
      const end = toOriginal(statement.offset + statement.sql.length, true);
      const used = placeholders.filter((placeholder) => placeholder.start >= start && placeholder.end <= end);
      return {
        sql: script.slice(start, end),
        offset: start,
        keyword: statement.keyword,
        changesCatalog: statementKind(tokens) === 'writes',
        readsOnly: statementKind(tokens) === 'reads' && used.length === 0,
        text: statement.sql,
        tokens: tokens.map((token) => ({
          ...token,
          start: token.start - statement.offset,
          end: token.end - statement.offset,
        })),
        back: (offset, last) => toOriginal(statement.offset + offset, last) - start,
        parameters: [...new Set(used.map(({ name }) => name))],
      };
    });
    if (statements.length > 0) {
      const parsed = await parser.extractStatements(text);
      if (parsed.count !== statements.length) {
        throw new Error(
          `The script could not be split into statements safely (${statements.length} found, ${parsed.count} parsed).`,
        );
      }
    }
    return statements;
  } catch (cause) {
    throw new SplitFailure(cause, text, toOriginal);
  }
}

/**
 * The text a statement runs as on a Quack catalog: each `$name` becomes `getvariable('name')` after a
 * `SET VARIABLE name = <literal>` through `run`, because the quack extension loses bound parameters (duckdb-quack#323).
 * Elsewhere the statement runs as planned and `bindValues` binds the values.
 */
export async function quackRunnable(
  statement: Planned,
  values: ReadonlyMap<string, BoundValue> | undefined,
  run: (sql: string) => Promise<unknown>,
): Promise<Runnable> {
  // The planned text has no inline defaults any more: each `$name` is just that.
  const used = findPlaceholders(statement.text, statement.tokens).filter(
    ({ kind, name }) => kind === 'value' && values?.has(name),
  );
  if (used.length === 0) return statement;
  for (const name of new Set(used.map((placeholder) => placeholder.name))) {
    const value = values?.get(name);
    if (value) await run(`SET VARIABLE ${quoteIdentifier(name)} = ${sqlText(value.type, value.text)}`);
  }
  const rewritten = replacePlaceholders(
    statement.text,
    used,
    ({ name }) => `getvariable(${quoteLiteral(name)})`,
  );
  return {
    text: rewritten.text,
    back: (offset, end) => statement.back(rewritten.toOriginal(offset, end), end),
  };
}

/** Binds the values of the named parameters; one without a value stays unbound, and DuckDB names it. */
export function bindValues(
  prepared: Duckdb.DuckDBPreparedStatement,
  values: ReadonlyMap<string, BoundValue> | undefined,
  engine: Engine,
): void {
  if (!values || values.size === 0) return;
  for (let index = 1; index <= prepared.parameterCount; index++) {
    const value = values.get(prepared.parameterName(index));
    if (value?.type === 'date') {
      const parts = dateParts(value.text);
      if (parts) prepared.bindDate(index, engine.DuckDBDateValue.fromParts(parts));
    } else if (value?.type === 'number') {
      bindNumber(prepared, index, value.text, engine);
    } else if (value) {
      prepared.bindVarchar(index, value.text);
    }
  }
}

// Exact where DuckDB has an exact type: BIGINT, HUGEINT, DECIMAL up to 38 digits; DOUBLE beyond and with an exponent.
function bindNumber(
  prepared: Duckdb.DuckDBPreparedStatement,
  index: number,
  text: string,
  engine: Engine,
): void {
  const number = numberValue(text);
  if (number?.kind === 'integer') {
    const { value } = number;
    if (BigInt.asIntN(64, value) === value) prepared.bindBigInt(index, value);
    else if (BigInt.asIntN(128, value) === value) prepared.bindHugeInt(index, value);
    else prepared.bindDouble(index, Number(value));
  } else if (number?.kind === 'decimal') {
    prepared.bindDecimal(index, engine.decimalValue(number.unscaled, number.width, number.scale));
  } else if (number) {
    prepared.bindDouble(index, number.value);
  }
}
