/** A row of DuckDB's `sql_tokenize`; `start` is a UTF-8 byte offset into the text. */
export interface Token {
  readonly start: number;
  readonly type: string;
  readonly word: string;
}

export interface ScriptStatement {
  /** The statement without leading comments and without the terminator. */
  readonly sql: string;
  /** UTF-16 offset of `sql` in the script. */
  readonly offset: number;
  /** The first word in upper case, e.g. `SELECT`, `WITH`, `COMMIT`. */
  readonly keyword: string;
}

export interface Range {
  readonly offset: number;
  readonly length: number;
}

/** Replaces a leading byte order mark with a space: DuckDB's tokenizer counts it as no character and shifts every offset. */
export function withoutBom(text: string): string {
  return text.startsWith('\uFEFF') ? ` ${text.slice(1)}` : text;
}

/** Converts UTF-8 byte offsets (DuckDB) into UTF-16 offsets (editor). */
export function utf16Offsets(text: string): (byteOffset: number) => number {
  if (Buffer.byteLength(text) === text.length) {
    return (byteOffset) => Math.min(byteOffset, text.length);
  }
  const map = new Uint32Array(Buffer.byteLength(text) + 1);
  let byte = 0;
  let unit = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character);
    map.fill(unit, byte, byte + bytes);
    byte += bytes;
    unit += character.length;
  }
  map[byte] = unit;
  return (byteOffset) => map[Math.min(byteOffset, byte)] ?? text.length;
}

/** The tokens of one statement, without comments, and the terminator that ends it (none for the last statement). */
export interface StatementSpan<T> {
  readonly tokens: readonly [T, ...T[]];
  readonly terminator: T | undefined;
}

/**
 * Where the statements of a token list are: they end at a terminator, comments belong to none, and a statement without
 * tokens is left out. The editor, the parser of the script and the runner all cut a script this way.
 */
export function statementSpans<T extends { readonly type: string }>(
  tokens: readonly T[],
): StatementSpan<T>[] {
  const spans: StatementSpan<T>[] = [];
  let current: T[] = [];
  const end = (terminator: T | undefined): void => {
    const [first, ...rest] = current;
    if (first) spans.push({ tokens: [first, ...rest], terminator });
    current = [];
  };
  for (const token of tokens) {
    if (token.type === 'TERMINATOR') end(token);
    else if (token.type !== 'COMMENT') current.push(token);
  }
  end(undefined);
  return spans;
}

/** What Run Query runs: the selection unless it is blank, else the whole document. */
export function scriptToRun(
  text: string,
  selection: { readonly start: number; readonly end: number },
): { text: string; base: number } {
  const selected = text.slice(selection.start, selection.end);
  return selected.trim() === '' ? { text, base: 0 } : { text: selected, base: selection.start };
}

/** Where the statement of a span is: from its first token to the end of its last, without the terminator. */
export function spanRange<T extends { readonly start: number; readonly end: number }>(
  span: readonly [T, ...T[]],
): { start: number; end: number } {
  return { start: span[0].start, end: (span.at(-1) ?? span[0]).end };
}

/**
 * The statement at the offset, as Run Statement at Cursor and the lenses pick it: text between statements belongs to the
 * one before, an offset before all statements picks the first. Undefined for a text without a statement.
 */
export function statementSpanAt<T extends { readonly type: string; readonly start: number }>(
  tokens: readonly T[],
  offset: number,
): StatementSpan<T> | undefined {
  const spans = statementSpans(tokens);
  return spans.findLast(({ tokens: [first] }) => first.start <= offset) ?? spans[0];
}

/** Splits a script into statements at terminators; comments and empty statements are dropped. */
export function splitScript(script: string, tokens: readonly Token[]): ScriptStatement[] {
  const unitOf = utf16Offsets(script);
  return statementSpans(tokens).map(({ tokens: [first, ...rest], terminator }) => {
    const offset = unitOf(first.start);
    // The first word of the statement: `(SELECT 1)` is a SELECT, not a bracket.
    const word = [first, ...rest].find((token) => /^[\p{L}_]/u.test(token.word)) ?? first;
    return {
      sql: script.slice(offset, terminator ? unitOf(terminator.start) : script.length).trimEnd(),
      offset,
      keyword: word.word.toUpperCase(),
    };
  });
}

/** The part of `sql` that the error's `LINE n:` excerpt and caret point to; undefined without an excerpt. */
export function caretRange(message: string, sql: string): Range | undefined {
  const match = /\nLINE (\d+): ([^\n]*)\n( *)(\^+)/.exec(message);
  if (!match) return undefined;
  const lineNumber = Number(match[1]);
  const shown = (match[2] ?? '').replace(/\r$/, '');
  const lines = sql.split('\n');
  const line = (lines[lineNumber - 1] ?? '').replace(/\r$/, '');
  const lineStart = lines.slice(0, lineNumber - 1).reduce((sum, previous) => sum + previous.length + 1, 0);
  const whole = { offset: lineStart, length: line.length };
  // The caret counts display columns and DuckDB shortens long lines with `...`: such an excerpt maps to the whole line.
  if (shown !== line) return whole;
  const column = (match[3] ?? '').length - `LINE ${lineNumber}: `.length;
  const from = indexAtColumn(line, column);
  const to = indexAtColumn(line, column + (match[4] ?? '').length);
  return from >= line.length ? whole : { offset: lineStart + from, length: to - from };
}

// A column beyond the line gives the line length.
function indexAtColumn(line: string, column: number): number {
  let width = 0;
  let index = 0;
  for (const character of line) {
    if (width >= column) break;
    width += displayWidth(character);
    index += character.length;
  }
  return index;
}

// East Asian wide and fullwidth blocks and emoji blocks: two display columns each.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

function displayWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (/^\p{M}$/u.test(character) || (code >= 0x200b && code <= 0x200f) || code === 0x2060) return 0;
  return WIDE.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
}
