import { format } from 'sql-formatter';
import { messageOf } from '../errors';
import { findPlaceholders, withoutDefault } from './parameters';
import type { SqlToken } from './tokens';

export type KeywordCase = 'upper' | 'lower' | 'preserve';

export interface FormatOptions {
  /** Spaces per level; the editor's tab size. */
  readonly tabWidth: number;
  readonly useTabs: boolean;
  readonly keywordCase: KeywordCase;
}

/** The setting `aantje.sql.formatKeywordCase`; upper case when it is not one of the three. */
export function keywordCaseOf(value: unknown): KeywordCase {
  return value === 'lower' || value === 'preserve' ? value : 'upper';
}

// The placeholders of the parameters (`parameters.ts`) as parameters of sql-formatter, which keeps each as written:
// `$name{default}` (a quoted text in it may hold a brace), `$name` (not the `$tag$` of a dollar-quoted string) and
// `{{name}}`. Its DuckDB dialect knows no `$name` at all.
const PLACEHOLDERS = [
  String.raw`\$[A-Za-z_]\w*\{(?:'(?:[^'\r\n]|'')*'|"(?:[^"\r\n]|"")*"|[^{}'"\r\n;]|\{[^{}\r\n;]*\})*\}`,
  String.raw`\$[A-Za-z_]\w*(?![\p{L}\p{N}_$])`,
  String.raw`\{\{\s*[A-Za-z_]\w*\s*\}\}`,
].map((regex) => ({ regex }));

/** The SQL formatted with sql-formatter's DuckDB dialect, or the reason it could not be formatted. */
export function formatSql(
  text: string,
  options: FormatOptions,
): { readonly text: string } | { readonly error: string } {
  try {
    return {
      text: format(text, {
        language: 'duckdb',
        tabWidth: options.tabWidth,
        useTabs: options.useTabs,
        keywordCase: options.keywordCase,
        linesBetweenQueries: 1,
        paramTypes: { custom: PLACEHOLDERS },
      }),
    };
  } catch (error) {
    return { error: messageOf(error).split('\n')[0] ?? '' };
  }
}

// An unquoted word: DuckDB reads keywords and unquoted names the same in any case.
const UNQUOTED = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

/**
 * Whether the formatted SQL means the same as the original: the same tokens of DuckDB in the same order, apart from
 * the case of unquoted words; comments must all be there, apart from the blanks around them.
 */
export function sameTokens(before: readonly SqlToken[], after: readonly SqlToken[]): boolean {
  if (before.length !== after.length) return false;
  return before.every((token, index) => {
    const other = after[index];
    if (other?.type !== token.type) return false;
    if (token.type === 'COMMENT') return other.word.trim() === token.word.trim();
    return (
      other.word === token.word ||
      (UNQUOTED.test(token.word) && other.word.toUpperCase() === token.word.toUpperCase())
    );
  });
}

/** A text with DuckDB's tokens. */
interface Tokenized {
  readonly text: string;
  readonly tokens: readonly SqlToken[];
}

/**
 * Whether the formatted SQL keeps the placeholders of the parameters: the same in the same order, none split or joined
 * (`$a {1}` is no inline default, `{ {b} }` no `{{b}}`), which the tokens alone cannot tell.
 */
export function samePlaceholders(before: Tokenized, after: Tokenized): boolean {
  const shape = ({ text, tokens }: Tokenized): string[] =>
    findPlaceholders(text, tokens).map(
      (placeholder) =>
        `${placeholder.kind}:${placeholder.name}:${withoutDefault(placeholder) !== undefined}:${placeholder.inlineDefault?.value ?? ''}`,
    );
  const [was, is] = [shape(before), shape(after)];
  return was.length === is.length && was.every((placeholder, index) => placeholder === is[index]);
}
