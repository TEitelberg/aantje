import { format } from 'sql-formatter';
import { messageOf } from '../errors';
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
