import { quoteIdentifier } from '../catalog/ddl';

/** A token of `sql_tokenize` with UTF-16 offsets; `word` is the exact text of the script from `start` to `end`. */
export interface SqlToken {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly word: string;
}

const NOT_A_WORD = new Set(['OPERATOR', 'STRING_LITERAL', 'NUMBER_LITERAL', 'COMMENT', 'TERMINATOR']);

/** What the token tests read: the type and the text, whatever the offsets count. */
type TokenText = Pick<SqlToken, 'type' | 'word'>;

export function isDot(token: TokenText): boolean {
  return token.word === '.';
}

export function isWord(token: TokenText): boolean {
  return !NOT_A_WORD.has(token.type) && !isDot(token);
}

/** An opening or a closing parenthesis; one inside a string or a quoted name is part of that token. */
export const isOpen = (token: TokenText | undefined): boolean =>
  token?.type === 'OPERATOR' && token.word === '(';
export const isClose = (token: TokenText | undefined): boolean =>
  token?.type === 'OPERATOR' && token.word === ')';

/** The index of the parenthesis that closes the one at `open`, or -1. */
export function closing(tokens: readonly TokenText[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isOpen(tokens[index])) depth++;
    else if (isClose(tokens[index]) && --depth === 0) return index;
  }
  return -1;
}

// Quotes are escaped by doubling, so a closed token holds an even number of them.
function closedBy(word: string, quote: string): boolean {
  return word.length >= 2 && word.endsWith(quote) && word.split(quote).length % 2 === 1;
}

/** Whether a name must be quoted: not a plain word, or a word that DuckDB reserves (`reserved` in lower case). */
export function needsQuotes(name: string, reserved: ReadonlySet<string>): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name.toLowerCase());
}

/** A name as SQL text: quoted when it needs quotes, or when the user writes it quoted. */
export function quoteName(name: string, reserved: ReadonlySet<string>, quoted = false): string {
  return quoted || needsQuotes(name, reserved) ? quoteIdentifier(name) : name;
}

/** The unquoted spelling of an identifier token (an unterminated quote is accepted). */
export function unquote(word: string): string {
  if (!word.startsWith('"')) return word;
  return (closedBy(word, '"') ? word.slice(1, -1) : word.slice(1)).replaceAll('""', '"');
}

/** An unquoted word in upper case; undefined for quoted identifiers, strings, operators and numbers. */
export function keywordOf(token: TokenText | undefined): string | undefined {
  return token && isWord(token) && !token.word.startsWith('"') ? token.word.toUpperCase() : undefined;
}

/** Whether a quoted identifier, string or comment has its closing delimiter. */
export function isClosed(token: SqlToken): boolean {
  const { word } = token;
  if (token.type === 'COMMENT')
    return word.startsWith('--') ? /[\r\n]$/.test(word) : word.length >= 4 && word.endsWith('*/');
  if (token.type === 'STRING_LITERAL') {
    const dollar = /^\$[^$]*\$/.exec(word)?.[0];
    return dollar ? word.length >= dollar.length * 2 && word.endsWith(dollar) : closedBy(word, "'");
  }
  return closedBy(word, '"');
}
