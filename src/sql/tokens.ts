/** A token of `sql_tokenize` with UTF-16 offsets; `word` is the exact text of the script from `start` to `end`. */
export interface SqlToken {
  readonly start: number;
  readonly end: number;
  readonly type: string;
  readonly word: string;
}

const NOT_A_WORD = new Set(['OPERATOR', 'STRING_LITERAL', 'NUMBER_LITERAL', 'COMMENT', 'TERMINATOR']);

export function isDot(token: SqlToken): boolean {
  return token.word === '.';
}

export function isWord(token: SqlToken): boolean {
  return !NOT_A_WORD.has(token.type) && !isDot(token);
}

// Quotes are escaped by doubling, so a closed token holds an even number of them.
function closedBy(word: string, quote: string): boolean {
  return word.length >= 2 && word.endsWith(quote) && word.split(quote).length % 2 === 1;
}

/** The unquoted spelling of an identifier token (an unterminated quote is accepted). */
export function unquote(word: string): string {
  if (!word.startsWith('"')) return word;
  return (closedBy(word, '"') ? word.slice(1, -1) : word.slice(1)).replaceAll('""', '"');
}

/** An unquoted word in upper case; undefined for quoted identifiers, strings, operators and numbers. */
export function keywordOf(token: SqlToken | undefined): string | undefined {
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
