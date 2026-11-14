import { SECRET_MASK } from '../secrets';

// The Query History keeps SQL text on disk. Before it does, the values that a statement hands over as secrets are
// replaced: the options of CREATE SECRET, a SET of a setting that holds a key or token, and the password of a connection
// string in a literal. It works on tokens, so the rest of the statement stays as written. The tokens come from this small
// lexer, not from DuckDB, because the history also keeps what never reached an engine. What it cannot follow (an
// unterminated string or option list) it masks up to the end of the statement.

type Kind = 'space' | 'comment' | 'string' | 'name' | 'word' | 'number' | 'terminator' | 'symbol';

interface Lexeme {
  readonly kind: Kind;
  readonly start: number;
  readonly end: number;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** The values that the span replaces. */
  readonly hidden: readonly string[];
}

/** The masked text, and the values it replaced: an error message may quote them too. */
export interface MaskedSql {
  readonly text: string;
  readonly hidden: readonly string[];
}

const MASKED_VALUE = `'${SECRET_MASK}'`;
const SPACE = /\s+/y;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const DOLLAR = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/y;
// The options of CREATE SECRET whose values are kinds, not secrets; they stay readable.
const KEPT_OPTIONS = new Set(['TYPE', 'PROVIDER']);
const CREATE_MODIFIERS = new Set(['PERSISTENT', 'TEMPORARY', 'TEMP']);
const SET_MODIFIERS = new Set(['GLOBAL', 'SESSION', 'LOCAL', 'VARIABLE']);
// A setting or variable whose name says that it holds a secret: `s3_secret_access_key`, `s3_session_token`, ...
const SECRET_SETTING = /key|secret|token|password|credential|connection_string/i;
// In a literal: `scheme://user:password@host`, and `password=...` of a libpq connection string.
const URL_PASSWORD = /(:\/\/[^\s:/?#']*):([^\s/?#']*)@/g;
const KEYWORD_PASSWORD = /(\bpassword\s*=\s*)(''(?:[^']|'''')*''|[^\s']+)/gi;
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

function at(pattern: RegExp, text: string, start: number): number | undefined {
  pattern.lastIndex = start;
  return pattern.exec(text) ? pattern.lastIndex : undefined;
}

/** Where a quoted text that starts at `start` ends; doubled quotes (and escapes, for E'') stay inside. */
function quoted(text: string, start: number, quote: string, backslash = false): number {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (backslash && character === '\\') index += 2;
    else if (character !== quote) index++;
    else if (text[index + 1] === quote) index += 2;
    else return index + 1;
  }
  return text.length;
}

// Block comments nest in DuckDB, as in PostgreSQL.
function blockComment(text: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < text.length) {
    if (text.startsWith('/*', index)) {
      depth++;
      index += 2;
    } else if (text.startsWith('*/', index)) {
      index += 2;
      if (--depth === 0) return index;
    } else index++;
  }
  return text.length;
}

function lexeme(text: string, start: number): Lexeme {
  const one = (kind: Kind, end: number): Lexeme => ({ kind, start, end });
  const character = text[start] ?? '';
  const space = at(SPACE, text, start);
  if (space !== undefined) return one('space', space);
  if (text.startsWith('--', start)) {
    const end = text.indexOf('\n', start);
    return one('comment', end === -1 ? text.length : end);
  }
  if (text.startsWith('/*', start)) return one('comment', blockComment(text, start));
  if (character === "'") return one('string', quoted(text, start, "'"));
  if (/[EeXxBb]/.test(character) && text[start + 1] === "'") {
    return one('string', quoted(text, start + 1, "'", /[Ee]/.test(character)));
  }
  if (character === '"') return one('name', quoted(text, start, '"'));
  if (character === ';') return one('terminator', start + 1);
  const dollar = at(DOLLAR, text, start);
  if (dollar !== undefined) {
    const close = text.indexOf(text.slice(start, dollar), dollar);
    return one('string', close === -1 ? text.length : close + dollar - start);
  }
  const word = at(WORD, text, start);
  if (word !== undefined) return one('word', word);
  const number = at(NUMBER, text, start);
  return number === undefined ? one('symbol', start + 1) : one('number', number);
}

function lex(text: string): Lexeme[] {
  const lexemes: Lexeme[] = [];
  for (let start = 0; start < text.length;) {
    const next = lexeme(text, start);
    lexemes.push(next);
    start = next.end;
  }
  return lexemes;
}

/** The statements of a text, each as its lexemes without spaces and comments. */
function statements(lexemes: readonly Lexeme[]): Lexeme[][] {
  const all: Lexeme[][] = [[]];
  for (const item of lexemes) {
    if (item.kind === 'terminator') all.push([]);
    else if (item.kind !== 'space' && item.kind !== 'comment') all.at(-1)?.push(item);
  }
  return all.filter((statement) => statement.length > 0);
}

class Masker {
  readonly spans: Span[] = [];

  constructor(private readonly text: string) {}

  keyword(item: Lexeme | undefined): string | undefined {
    return item?.kind === 'word' ? this.text.slice(item.start, item.end).toUpperCase() : undefined;
  }

  symbol(item: Lexeme | undefined): string | undefined {
    return item?.kind === 'symbol' ? this.text.slice(item.start, item.end) : undefined;
  }

  /** Replaces the lexemes from the first to the last of `range` with `'***'`. */
  mask(range: readonly Lexeme[]): void {
    const first = range[0];
    const last = range.at(-1);
    if (!first || !last) return;
    const original = this.text.slice(first.start, last.end);
    // An error message may quote the value as written or the contents of its literals.
    const literals = [...original.matchAll(/'((?:[^']|'')*)'/g)].map(([, inner = '']) =>
      inner.replaceAll("''", "'"),
    );
    this.spans.push({
      start: first.start,
      end: last.end,
      text: MASKED_VALUE,
      hidden: [original, ...literals],
    });
  }

  /** Masks the option values of `CREATE [OR REPLACE] [PERSISTENT|TEMPORARY] SECRET`; false for another statement. */
  createSecret(words: readonly Lexeme[]): boolean {
    if (this.keyword(words[0]) !== 'CREATE') return false;
    let index = this.keyword(words[1]) === 'OR' && this.keyword(words[2]) === 'REPLACE' ? 3 : 1;
    while (CREATE_MODIFIERS.has(this.keyword(words[index]) ?? '')) index++;
    if (this.keyword(words[index]) !== 'SECRET') return false;
    const open = words.findIndex((item, position) => position > index && this.symbol(item) === '(');
    if (open === -1) {
      this.mask(words.slice(index + 1));
      return true;
    }
    let option: Lexeme[] = [];
    let depth = 0;
    for (const [position, item] of words.slice(open + 1).entries()) {
      const symbol = this.symbol(item) ?? '';
      if (depth === 0 && (symbol === ',' || symbol === ')')) {
        this.option(option);
        option = [];
        if (symbol === ')') {
          // Anything after the option list makes the statement invalid; it is masked all the same.
          this.mask(words.slice(open + 2 + position));
          return true;
        }
      } else {
        if (OPENERS.has(symbol)) depth++;
        else if (CLOSERS.has(symbol)) depth = Math.max(0, depth - 1);
        option.push(item);
      }
    }
    this.option(option);
    return true;
  }

  /** `KEY value`: the value is masked unless the option names a kind (TYPE, PROVIDER) with one word or literal. */
  option(option: readonly Lexeme[]): void {
    const [key, ...value] = option;
    if (key?.kind !== 'word' && key?.kind !== 'name') {
      this.mask(option);
      return;
    }
    const name = this.text.slice(key.start, key.end).replaceAll('"', '').toUpperCase();
    const kept = value.length === 1 && (value[0]?.kind === 'word' || value[0]?.kind === 'string');
    if (!(KEPT_OPTIONS.has(name) && kept)) this.mask(value);
  }

  /** Masks the value of `SET [GLOBAL|SESSION|LOCAL|VARIABLE] name = value` when the name looks like a secret. */
  setSecret(words: readonly Lexeme[]): void {
    if (this.keyword(words[0]) !== 'SET') return;
    let index = 1;
    while (SET_MODIFIERS.has(this.keyword(words[index]) ?? '')) index++;
    const name = words[index];
    if (!name || !SECRET_SETTING.test(this.text.slice(name.start, name.end))) return;
    const next = words[index + 1];
    const assigns = this.symbol(next) === '=' || this.keyword(next) === 'TO';
    this.mask(words.slice(index + (assigns ? 2 : 1)));
  }

  /** The password parts of the connection strings in the literals that no statement rule masked. */
  literalPasswords(lexemes: readonly Lexeme[]): void {
    const covered = (item: Lexeme): boolean =>
      this.spans.some(({ start, end }) => item.start >= start && item.end <= end);
    for (const item of lexemes) {
      if (item.kind !== 'string' || covered(item)) continue;
      const literal = this.text.slice(item.start, item.end);
      const hidden: string[] = [];
      const masked = literal
        .replace(URL_PASSWORD, (_match, before: string, password: string) => {
          hidden.push(password);
          return `${before}:${SECRET_MASK}@`;
        })
        .replace(KEYWORD_PASSWORD, (_match, before: string, password: string) => {
          hidden.push(password, password.replaceAll("''", "'"));
          return `${before}${SECRET_MASK}`;
        });
      if (masked !== literal) this.spans.push({ start: item.start, end: item.end, text: masked, hidden });
    }
  }
}

/**
 * The text with the secrets that its statements hand over replaced: the option values of CREATE SECRET (except TYPE
 * and PROVIDER), the value of a SET of a setting named like a key, token or password, and the passwords of connection
 * strings in literals.
 */
export function maskSecretStatements(text: string): MaskedSql {
  const lexemes = lex(text);
  const masker = new Masker(text);
  for (const words of statements(lexemes)) {
    if (!masker.createSecret(words)) masker.setSecret(words);
  }
  masker.literalPasswords(lexemes);
  let masked = '';
  let position = 0;
  const hidden: string[] = [];
  for (const span of masker.spans.toSorted((a, b) => a.start - b.start)) {
    if (span.start < position) continue;
    masked += text.slice(position, span.start) + span.text;
    hidden.push(...span.hidden);
    position = span.end;
  }
  return { text: masked + text.slice(position), hidden };
}
