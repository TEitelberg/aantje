// The parameters of a SQL text, for the SQL editor and the templates alike: what the header declares
// (`-- param: name | type | default | description`), where the placeholders stand (`$name` for a value that is bound,
// `$name{default}` for one with an inline default, `{{name}}` for text that is replaced), what a value of each type
// turns into, and the values remembered per scope. Pure and free of the VS Code API and of the run code; the dialog
// that asks for the values is `parameters.vscode.ts`.
import { quoteIdentifier, quoteLiteral } from '../catalog/ddl';
import type { Diagnostic } from './syntax';
import { isClose, isDot, isOpen, isWord, keywordOf } from './tokens';
import type { SqlToken } from './tokens';

/**
 * - `text`: a value as it is; `{{name}}` becomes a quoted literal, `$name` is bound as VARCHAR.
 * - `number`: a decimal number, also with an exponent; checked, written as it is (a negative one in parentheses).
 * - `date`: `YYYY-MM-DD`, a real day; `{{name}}` becomes `DATE '...'`, `$name` is bound as DATE.
 * - `identifier`: a name, quoted as an identifier; only as `{{name}}`, because a name cannot be bound.
 */
export type ParameterType = 'text' | 'number' | 'date' | 'identifier';

export const PARAMETER_TYPES: readonly ParameterType[] = ['text', 'number', 'date', 'identifier'];

/** A parameter as a header line declares it. */
export interface ParameterDeclaration {
  readonly name: string;
  readonly type: ParameterType;
  /** What the dialog proposes when there is no last value. */
  readonly defaultValue?: string;
  readonly description?: string;
}

/** `value`: `$name`, bound to the prepared statement. `text`: `{{name}}`, replaced in the text before it runs. */
export type PlaceholderKind = 'value' | 'text';

/**
 * A placeholder in a text; `start` and `end` are UTF-16 offsets of the whole placeholder: `$` or `{{` to `}}`, and for
 * `$name{default}` to the `}` of the braces, which DuckDB never sees (`withoutDefault`).
 */
export interface Placeholder {
  readonly name: string;
  readonly kind: PlaceholderKind;
  readonly start: number;
  readonly end: number;
  /** The default between the braces right after `$name`; none without braces and for `{}`. */
  readonly inlineDefault?: InlineDefault;
}

/** The default that braces right after a `$name` give: `$limit{1000}`, `$region{'north'}`. */
export interface InlineDefault {
  /** As written between the braces, without the blanks around it; a text in single quotes without its quotes. */
  readonly value: string;
  /** What the value is: a `number`, a `date` (`YYYY-MM-DD`), else (and always in quotes) a `text`. */
  readonly type: ParameterType;
}

/** A parameter that a text uses: its declaration, or `text` without a default for one the header does not declare. */
export interface ScriptParameter extends ParameterDeclaration {
  readonly declared: boolean;
  /** How the text uses it; a name may stand both as `$name` and as `{{name}}`. */
  readonly kinds: readonly PlaceholderKind[];
}

/** The values of one run, from the answers of the dialog (`runParameters`). */
export interface RunParameters {
  /** The SQL text that replaces `{{name}}`. */
  readonly text: ReadonlyMap<string, string>;
  /** The values that `$name` binds. */
  readonly values: ReadonlyMap<string, BoundValue>;
}

/** A value for `$name`: its type and its text as the dialog took it. */
export interface BoundValue {
  readonly type: Exclude<ParameterType, 'identifier'>;
  readonly text: string;
}

/** A number as the session binds it: exact where DuckDB has an exact type. */
export type NumberValue =
  | { readonly kind: 'integer'; readonly value: bigint }
  | { readonly kind: 'decimal'; readonly unscaled: bigint; readonly width: number; readonly scale: number }
  | { readonly kind: 'double'; readonly value: number };

/** A text with its placeholders replaced, and the way back from an offset in it to the text as written. */
export interface Substitution {
  readonly text: string;
  /**
   * An offset into `text` as the offset into the original text. Inside a replacement it gives the placeholder's start,
   * or its end when `end` (the end of a range), so that a range in a replacement covers the whole placeholder.
   */
  readonly toOriginal: (offset: number, end?: boolean) => number;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_LINE = /^--\s*param\s*:(.*)$/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
// DuckDB's widest DECIMAL.
const MAX_DECIMAL_WIDTH = 38;
// The keywords that a name of a table, view or schema follows: `FROM t`, `LEFT JOIN t`, `INSERT INTO t`, `DROP TABLE t`.
const BEFORE_NAME = new Set([
  'FROM',
  'JOIN',
  'INTO',
  'UPDATE',
  'TABLE',
  'VIEW',
  'TRUNCATE',
  'USE',
  'DESCRIBE',
  'SUMMARIZE',
]);
// The functions whose arguments a `FROM` separates: `extract(year FROM $day)`, `substring($s FROM $n FOR $m)`.
const FROM_IN_CALL = new Set(['EXTRACT', 'SUBSTRING', 'TRIM', 'OVERLAY']);

/**
 * The declarations of the header: the `-- param:` lines among the comment lines and blank lines at the start of the
 * text. `name | type | default | description`, all but the name optional; an empty or missing type is `text`, an empty
 * default is none. A line that names no valid name or type, or a name declared before, becomes a problem and is skipped.
 */
export function parseParameterHeader(text: string): {
  declarations: ParameterDeclaration[];
  problems: string[];
} {
  const declarations: ParameterDeclaration[] = [];
  const problems: string[] = [];
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (!line.startsWith('--')) break;
    const match = HEADER_LINE.exec(line);
    if (!match) continue;
    const [name = '', type = '', defaultValue = '', ...description] = (match[1] ?? '')
      .split('|')
      .map((field) => field.trim());
    const parsed = declaration(name, type, defaultValue, description.join('|').trim());
    if (typeof parsed === 'string') problems.push(`${parsed} (${line})`);
    else if (declarations.some((known) => known.name === parsed.name)) {
      problems.push(`The parameter ${parsed.name} is declared twice; the first line counts (${line})`);
    } else declarations.push(parsed);
  }
  return { declarations, problems };
}

function declaration(
  name: string,
  type: string,
  defaultValue: string,
  description: string,
): ParameterDeclaration | string {
  if (!NAME.test(name)) return `"${name}" is no parameter name: letters, digits and _, not first a digit`;
  const kind = (type === '' ? 'text' : type.toLowerCase()) as ParameterType;
  if (!PARAMETER_TYPES.includes(kind)) {
    return `The type of ${name} is "${type}"; it is one of ${PARAMETER_TYPES.join(', ')}`;
  }
  if (defaultValue !== '') {
    const problem = valueProblem(kind, defaultValue);
    if (problem) return `The default of ${name} is no valid value: ${problem}`;
  }
  return {
    name,
    type: kind,
    ...(defaultValue === '' ? {} : { defaultValue }),
    ...(description === '' ? {} : { description }),
  };
}

/**
 * The placeholders of a text, from DuckDB's tokens (`sql_tokenize`) of that text, so that a `$` or `{{` in a string, a
 * dollar-quoted block, a quoted name or a comment is none. `$name` is a `$` right before an unquoted word (`$1` and `?`
 * are not named and are left to DuckDB); a `{` right after the name opens its inline default, which runs to the
 * matching `}` on the same line, without a `;` (a brace or `;` in quotes does not count); a `{` without it is left to
 * DuckDB. `{{name}}` is two `{` right after each other, a word, and two `}`, blanks allowed inside.
 */
export function findPlaceholders(text: string, tokens: readonly SqlToken[]): Placeholder[] {
  const found: Placeholder[] = [];
  for (let index = 0; index < tokens.length; index++) {
    // Both start with an operator: `$` or `{`.
    if (tokens[index]?.type !== 'OPERATOR') continue;
    const at = valueAt(text, tokens, index) ?? textAt(tokens, index);
    if (!at) continue;
    found.push(at.placeholder);
    index = at.last;
  }
  return found;
}

/** A placeholder that starts at a token, and the index of its last token. */
interface Found {
  readonly placeholder: Placeholder;
  readonly last: number;
}

// `$name`, with the braces of its inline default when they follow.
function valueAt(text: string, tokens: readonly SqlToken[], index: number): Found | undefined {
  const [dollar, name, open] = tokens.slice(index, index + 3);
  if (
    dollar?.type !== 'OPERATOR' ||
    dollar.word !== '$' ||
    !name ||
    name.start !== dollar.end ||
    !isName(name)
  ) {
    return undefined;
  }
  const close = closingBrace(text, tokens, index + 2);
  const last = close === undefined ? undefined : tokens[close];
  const inline = open && last && inlineDefault(text, open, last, tokens.slice(index + 3, close));
  return {
    placeholder: {
      name: name.word,
      kind: 'value',
      start: dollar.start,
      end: last?.end ?? name.end,
      ...(inline ? { inlineDefault: inline } : {}),
    },
    last: close ?? index + 1,
  };
}

// `{{name}}`.
function textAt(tokens: readonly SqlToken[], index: number): Found | undefined {
  const [first, open, name, close, last] = tokens.slice(index, index + 5);
  const found =
    first &&
    isBrace(first, '{') &&
    isBrace(open, '{') &&
    open?.start === first.end &&
    name &&
    isName(name) &&
    isBrace(close, '}') &&
    isBrace(last, '}') &&
    last?.start === close?.end;
  return found && last
    ? { placeholder: { name: name.word, kind: 'text', start: first.start, end: last.end }, last: index + 4 }
    : undefined;
}

function isName(token: SqlToken): boolean {
  return isWord(token) && !token.word.startsWith('"') && NAME.test(token.word);
}

const isBrace = (token: SqlToken | undefined, brace: '{' | '}'): boolean =>
  token?.type === 'OPERATOR' && token.word === brace;

// The index of the `}` that closes the `{` at `open`, which must follow the name right before it: on the same line and
// without a `;`, so that the default never hides the end of a line or of a statement.
function closingBrace(text: string, tokens: readonly SqlToken[], open: number): number | undefined {
  const name = tokens[open - 1];
  if (!isBrace(tokens[open], '{') || tokens[open]?.start !== name?.end) return undefined;
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    const token = tokens[index];
    const before = tokens[index - 1];
    if (!token || !before || token.type === 'TERMINATOR') return undefined;
    // The blanks before the token and the token itself; a string or comment may span lines too.
    if (/[\r\n]/.test(text.slice(before.end, token.end))) return undefined;
    if (isBrace(token, '{')) depth++;
    else if (isBrace(token, '}') && --depth === 0) return index;
  }
  return undefined;
}

// The default between the braces; one text in single quotes is that text, so that it can hold a brace.
function inlineDefault(
  text: string,
  open: SqlToken,
  close: SqlToken,
  inside: readonly SqlToken[],
): InlineDefault | undefined {
  const [only] = inside;
  if (inside.length === 1 && only?.type === 'STRING_LITERAL' && only.word.startsWith("'")) {
    const value = only.word.slice(1, -1).replaceAll("''", "'");
    return value === '' ? undefined : { value, type: 'text' };
  }
  const value = text.slice(open.end, close.start).trim();
  if (value === '') return undefined;
  return { value, type: NUMBER.test(value) ? 'number' : dateParts(value) ? 'date' : 'text' };
}

/**
 * A `$name{default}` as DuckDB reads it: `$name` and blanks where the braces stood, so that every offset after it stays;
 * undefined for a placeholder without braces. Every place that hands the text to DuckDB replaces it so.
 */
export function withoutDefault(placeholder: Placeholder): string | undefined {
  const bound = `$${placeholder.name}`;
  const length = placeholder.end - placeholder.start;
  return placeholder.kind === 'value' && length > bound.length ? bound.padEnd(length) : undefined;
}

/** The first inline default of each name. */
function firstDefaults(placeholders: readonly Placeholder[]): Map<string, InlineDefault> {
  const first = new Map<string, InlineDefault>();
  for (const { name, inlineDefault: inline } of placeholders) {
    if (inline && !first.has(name)) first.set(name, inline);
  }
  return first;
}

/**
 * The parameters that the placeholders use, each once: the declared ones in the order of the header, then the others in
 * the order they first appear. A parameter without a default in the header takes the first inline default of its name
 * among `defaults` (the placeholders of the whole document, when only some of its statements run); one that the header
 * does not declare also takes its type from that default, else it is a `text` without a default.
 */
export function scriptParameters(
  declarations: readonly ParameterDeclaration[],
  placeholders: readonly Placeholder[],
  defaults: readonly Placeholder[] = placeholders,
): ScriptParameter[] {
  const kinds = new Map<string, PlaceholderKind[]>();
  for (const { name, kind } of placeholders) {
    const known = kinds.get(name) ?? [];
    if (!known.includes(kind)) known.push(kind);
    kinds.set(name, known);
  }
  const inline = firstDefaults(defaults);
  const declared = declarations
    .filter(({ name }) => kinds.has(name))
    .map((parameter) => {
      const fallback = parameter.defaultValue ?? inline.get(parameter.name)?.value;
      return {
        ...parameter,
        ...(fallback === undefined ? {} : { defaultValue: fallback }),
        declared: true,
        kinds: kinds.get(parameter.name) ?? [],
      };
    });
  const undeclared = [...kinds]
    .filter(([name]) => !declarations.some((parameter) => parameter.name === name))
    .map(([name, used]): ScriptParameter => {
      const given = inline.get(name);
      return given
        ? { name, type: given.type, defaultValue: given.value, declared: false, kinds: used }
        : { name, type: 'text', declared: false, kinds: used };
    });
  return [...declared, ...undeclared];
}

/**
 * The inline defaults that the dialog does not propose, for the check while typing: the header gives the parameter a
 * default, or an earlier inline default of the name differs. Each covers the braces.
 */
export function unusedDefaults(
  declarations: readonly ParameterDeclaration[],
  placeholders: readonly Placeholder[],
): Diagnostic[] {
  const first = firstDefaults(placeholders);
  return placeholders.flatMap(({ name, start, end, inlineDefault: inline }) => {
    if (!inline) return [];
    const header = declarations.find((parameter) => parameter.name === name)?.defaultValue;
    const counts = header ?? first.get(name)?.value;
    if (counts === undefined || counts === inline.value) return [];
    const braces = start + 1 + name.length;
    return [
      {
        offset: braces,
        length: end - braces,
        message:
          header === undefined
            ? `The first default of $${name} is ${counts}; this one is not used.`
            : `The header gives $${name} the default ${header}; this one is not used.`,
      },
    ];
  });
}

/**
 * The `$name` placeholders that stand where SQL expects a name, which cannot be bound, for the check while typing: right
 * after `FROM`, `JOIN`, `INTO`, `UPDATE`, `TABLE`, `VIEW`, `TRUNCATE`, `USE`, `DESCRIBE`, `SUMMARIZE` or
 * `IF [NOT] EXISTS`, and right before or after the `.` of a qualified name. A value follows the `FROM` of
 * `IS DISTINCT FROM`, of `extract`, `substring`, `trim` and `overlay` and of `COPY t FROM $file`, and `$code.upper()`
 * calls a function on a value: none of them is marked. `tokens` are DuckDB's tokens of the text, in which a comment is
 * a blank. Each covers its placeholder.
 */
export function boundNames(tokens: readonly SqlToken[], placeholders: readonly Placeholder[]): Diagnostic[] {
  const code = tokens.filter(({ type }) => type !== 'COMMENT');
  const starts = new Map(code.map(({ start }, index) => [start, index]));
  const ends = new Map(code.map(({ end }, index) => [end, index]));
  return placeholders.flatMap(({ name, kind, start, end }) => {
    const first = starts.get(start);
    const last = ends.get(end);
    if (kind !== 'value' || first === undefined || last === undefined || !standsForName(code, first, last)) {
      return [];
    }
    // A default such as `{gold.fact_sales}` is a qualified name, which takes a placeholder per part.
    const qualified = code.slice(first + 2, last).some(isDot)
      ? ' A qualified name takes one placeholder per part, as {{schema}}.{{table}}.'
      : '';
    return [
      {
        offset: start,
        length: end - start,
        message: `A name cannot be bound as $${name}; write {{${name}}} where the name goes and declare it with -- param: ${name} | identifier.${qualified}`,
      },
    ];
  });
}

// Whether the placeholder from `first` to `last`, indices into tokens without comments, stands where a name goes.
function standsForName(tokens: readonly SqlToken[], first: number, last: number): boolean {
  const before = tokens[first - 1];
  const after = tokens[last + 1];
  if (before && isDot(before)) return true;
  if (after && isDot(after)) {
    // The first part of a qualified name, unless a function is called on the value: `$code.upper()`.
    const method = tokens[last + 2];
    if (!(method && isWord(method) && isOpen(tokens[last + 3]))) return true;
  }
  const keyword = keywordOf(before);
  if (keyword === 'FROM') return !valueAfterFrom(tokens, first - 1);
  if (keyword === 'EXISTS') {
    // `IF EXISTS` and `IF NOT EXISTS` of DROP and CREATE; the EXISTS of a query takes a parenthesis.
    const not = keywordOf(tokens[first - 2]) === 'NOT';
    return keywordOf(tokens[first - (not ? 3 : 2)]) === 'IF';
  }
  return keyword !== undefined && BEFORE_NAME.has(keyword);
}

// Whether the `FROM` at `from` is followed by a value: in `IS [NOT] DISTINCT FROM`, inside the parentheses of a function
// in `FROM_IN_CALL`, or outside parentheses in a COPY statement, where it gives the file.
function valueAfterFrom(tokens: readonly SqlToken[], from: number): boolean {
  if (keywordOf(tokens[from - 1]) === 'DISTINCT') return true;
  let depth = 0;
  let copy = false;
  for (let index = from - 1; index >= 0; index--) {
    const token = tokens[index];
    if (!token || token.type === 'TERMINATOR') break;
    if (isClose(token)) depth++;
    else if (isOpen(token)) {
      if (depth === 0) return FROM_IN_CALL.has(keywordOf(tokens[index - 1]) ?? '');
      depth--;
    } else if (depth === 0 && keywordOf(token) === 'COPY') copy = true;
  }
  return copy;
}

/**
 * What the dialog shows first for each parameter: the last value, else the default, else nothing. A default that was
 * changed in the text since the last value was given (`rememberedDefaults`: the defaults of that time) wins over it.
 */
export function initialValues(
  parameters: readonly ParameterDeclaration[],
  remembered: Readonly<Record<string, string>>,
  rememberedDefaults: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  return Object.fromEntries(
    parameters.map(({ name, defaultValue }) => {
      const last = remembered[name];
      const changed = name in rememberedDefaults && rememberedDefaults[name] !== defaultValue;
      return [name, last !== undefined && !changed ? last : (defaultValue ?? last ?? '')];
    }),
  );
}

/** The defaults of the parameters, by name, to remember with their values. */
export const defaultsOf = (parameters: readonly ParameterDeclaration[]): Record<string, string | undefined> =>
  Object.fromEntries(parameters.map(({ name, defaultValue }) => [name, defaultValue]));

/** Why a value does not fit its type, or undefined when it does. */
export function valueProblem(type: ParameterType, value: string): string | undefined {
  switch (type) {
    case 'number':
      return NUMBER.test(value.trim()) ? undefined : 'a number such as 42, -1.5 or 2e6';
    case 'date':
      return dateParts(value) ? undefined : 'a day as YYYY-MM-DD, such as 2026-11-16';
    case 'identifier':
      return value === '' ? 'a name; it cannot be empty' : undefined;
    default:
      return undefined;
  }
}

/** Why a parameter cannot be used as it is (an identifier bound as `$name`), or undefined. */
export function usageProblem(parameter: ScriptParameter): string | undefined {
  return parameter.type === 'identifier' && parameter.kinds.includes('value')
    ? `The parameter ${parameter.name} is an identifier, which cannot be bound as $${parameter.name}. Write {{${parameter.name}}} where the name goes.`
    : undefined;
}

/** The SQL text of a value: a quoted identifier, a quoted literal, a checked number (negative in parentheses), a DATE. */
export function sqlText(type: ParameterType, value: string): string {
  switch (type) {
    case 'identifier':
      return quoteIdentifier(value);
    case 'number': {
      const number = value.trim();
      // In parentheses, so that a minus after another minus cannot form the comment `--`.
      return number.startsWith('-') ? `(${number})` : number.replace(/^\+/, '');
    }
    case 'date':
      return `DATE ${quoteLiteral(value.trim())}`;
    default:
      return quoteLiteral(value);
  }
}

/**
 * The values of a run from the answers of the dialog, checked against their types; a problem when a value does not fit,
 * a parameter has no answer, or it cannot be used as it is.
 */
export function runParameters(
  parameters: readonly ScriptParameter[],
  answers: Readonly<Record<string, string>>,
): { parameters: RunParameters } | { problem: string } {
  const text = new Map<string, string>();
  const values = new Map<string, BoundValue>();
  for (const parameter of parameters) {
    const { name, type, kinds } = parameter;
    const usage = usageProblem(parameter);
    if (usage) return { problem: usage };
    const answer = answers[name];
    if (answer === undefined) return { problem: `The parameter ${name} has no value.` };
    const wrong = valueProblem(type, answer);
    if (wrong) return { problem: `The value of ${name} is no ${type}: give ${wrong}.` };
    if (kinds.includes('text')) text.set(name, sqlText(type, answer));
    if (kinds.includes('value') && type !== 'identifier') {
      values.set(name, { type, text: type === 'text' ? answer : answer.trim() });
    }
  }
  return { parameters: { text, values } };
}

/**
 * Replaces placeholders by the text that `replacement` gives (undefined keeps the placeholder), and maps offsets back.
 * The placeholders must not overlap.
 */
export function replacePlaceholders(
  text: string,
  placeholders: readonly Placeholder[],
  replacement: (placeholder: Placeholder) => string | undefined,
): Substitution {
  const parts: string[] = [];
  // Where each replacement starts and ends in the new text, and where the placeholder ended in the old one.
  const moves: { start: number; end: number; originalStart: number; originalEnd: number }[] = [];
  let read = 0;
  let written = 0;
  for (const placeholder of [...placeholders].sort((a, b) => a.start - b.start)) {
    const replaced = replacement(placeholder);
    if (replaced === undefined || placeholder.start < read) continue;
    const before = text.slice(read, placeholder.start);
    parts.push(before, replaced);
    written += before.length;
    moves.push({
      start: written,
      end: written + replaced.length,
      originalStart: placeholder.start,
      originalEnd: placeholder.end,
    });
    written += replaced.length;
    read = placeholder.end;
  }
  parts.push(text.slice(read));
  return {
    text: parts.join(''),
    toOriginal: (offset, end = false) => {
      let shift = 0;
      for (const move of moves) {
        if (offset < move.start) break;
        if (offset < move.end) return end && offset > move.start ? move.originalEnd : move.originalStart;
        shift = move.originalEnd - move.end;
      }
      return offset + shift;
    },
  };
}

/** A number as the session binds it; undefined for a text that is no number. */
export function numberValue(text: string): NumberValue | undefined {
  const value = text.trim();
  if (!NUMBER.test(value)) return undefined;
  if (/^[+-]?\d+$/.test(value)) return { kind: 'integer', value: BigInt(value) };
  const decimal = /^([+-]?)(\d*)\.(\d*)$/.exec(value);
  if (decimal) {
    const [, sign = '', whole = '', fraction = ''] = decimal;
    const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const width = Math.max(digits.length, fraction.length + 1);
    if (width <= MAX_DECIMAL_WIDTH) {
      return { kind: 'decimal', unscaled: BigInt(`${sign}${digits}`), width, scale: fraction.length };
    }
  }
  return { kind: 'double', value: Number(value) };
}

/** The parts of a `YYYY-MM-DD` day that exists; undefined for anything else. */
export function dateParts(text: string): { year: number; month: number; day: number } | undefined {
  const match = DATE.exec(text.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

/**
 * The last values of the dialog per scope: a document of the SQL editor, a template. In memory, so they last as long
 * as the window; a new ask keeps the values of the parameters it did not ask for.
 */
export class ParameterMemory {
  private readonly scopes = new Map<string, Record<string, string>>();
  // The defaults that the parameters had when their values were given, so that a default changed in the text since
  // wins over the last value (`initialValues`).
  private readonly defaultsAt = new Map<string, Record<string, string | undefined>>();

  get(scope: string): Readonly<Record<string, string>> {
    return this.scopes.get(scope) ?? {};
  }

  /** The defaults of the parameters when their values were remembered. */
  defaults(scope: string): Readonly<Record<string, string | undefined>> {
    return this.defaultsAt.get(scope) ?? {};
  }

  remember(
    scope: string,
    values: Readonly<Record<string, string>>,
    defaults?: Readonly<Record<string, string | undefined>>,
  ): void {
    this.scopes.set(scope, { ...this.scopes.get(scope), ...values });
    if (defaults) this.defaultsAt.set(scope, { ...this.defaultsAt.get(scope), ...defaults });
  }

  forget(scope: string): void {
    this.scopes.delete(scope);
    this.defaultsAt.delete(scope);
  }
}
