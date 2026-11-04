// The columns that the text of a query gives: the select list of a CTE or a subquery, the rows of VALUES.
import type { ScopeRelation } from './context';
import { isDot, isWord, keywordOf, unquote } from './tokens';
import type { SqlToken } from './tokens';

/** The columns of a CTE, a subquery or a VALUES list as its SQL text gives them; nothing is run to learn them. */
export interface TextColumns {
  /** The items of the select list of the first SELECT, in order. */
  readonly items: readonly TextColumn[];
  /** The relations that the select list reads: what `*` and a column name stand for. */
  readonly scope: readonly ScopeRelation[];
  /** The column aliases of a CTE, `WITH c(a, b) AS (...)`: they rename the first columns. */
  readonly renamed: readonly string[];
}

export type TextColumn =
  /** `a`, `t.a`, `x AS a`, `a: x`, `x a`; `path` when the value is a column (or field) reference. */
  | {
      readonly kind: 'column';
      readonly alias: string | undefined;
      readonly path: readonly string[] | undefined;
    }
  /** `*` or `t.*`, without the columns that EXCLUDE drops, with the names that RENAME gives (lower case keys). */
  | {
      readonly kind: 'star';
      readonly qualifier: readonly string[];
      readonly exclude: readonly string[];
      readonly rename: ReadonlyMap<string, string>;
    }
  /** One column whose name is not known: an expression without an alias. */
  | { readonly kind: 'expression' }
  /** Any number of columns: `COLUMNS(...)`, `UNNEST(...)`, a star with other modifiers. */
  | { readonly kind: 'unknown' };

const UNKNOWN: TextColumn = { kind: 'unknown' };
const STAR: TextColumn = { kind: 'star', qualifier: [], exclude: [], rename: new Map() };

/** The columns of a body, when its text or the column aliases of its CTE say anything about them. */
export function textColumns(
  items: readonly TextColumn[] | undefined,
  scope: readonly ScopeRelation[],
  renamed: readonly string[],
): TextColumns | undefined {
  if (!items && renamed.length === 0) return undefined;
  return { items: items ?? [UNKNOWN], scope, renamed };
}

/** The words that end the select list. */
const LIST_ENDS = new Set([
  ...['FROM', 'WHERE', 'GROUP', 'HAVING', 'QUALIFY', 'WINDOW', 'ORDER', 'LIMIT', 'OFFSET'],
  ...['UNION', 'INTERSECT', 'EXCEPT'],
]);

/** Calls that give any number of columns. */
const EXPANDING = new Set(['COLUMNS', 'UNNEST']);

const opens = (token: SqlToken | undefined): boolean =>
  token?.type === 'OPERATOR' && ['(', '[', '{'].includes(token.word);
const closes = (token: SqlToken | undefined): boolean =>
  token?.type === 'OPERATOR' && [')', ']', '}'].includes(token.word);

// The depth of each token: 0 outside all parentheses, brackets and braces; a bracket has the depth around it.
function depthsOf(tokens: readonly SqlToken[]): number[] {
  let depth = 0;
  return tokens.map((token) => {
    if (closes(token)) depth -= 1;
    const at = depth;
    if (opens(token)) depth += 1;
    return at;
  });
}

// The parts of a list between the commas at depth 0.
function split(tokens: readonly SqlToken[]): SqlToken[][] {
  const depths = depthsOf(tokens);
  const parts: SqlToken[][] = [[]];
  tokens.forEach((token, index) => {
    if (token.word === ',' && depths[index] === 0) parts.push([]);
    else parts.at(-1)?.push(token);
  });
  return parts;
}

// The tokens inside the brackets that open at `index`, and the index after the closing one.
function group(tokens: readonly SqlToken[], index: number): { inside: SqlToken[]; next: number } {
  const depths = depthsOf(tokens);
  const end = tokens.findIndex((token, at) => at > index && closes(token) && depths[at] === depths[index]);
  const stop = end < 0 ? tokens.length : end;
  return { inside: tokens.slice(index + 1, stop), next: stop + 1 };
}

/**
 * The columns that a query gives, read from its tokens: the select list of its first SELECT, `col0`, `col1`, ... of
 * VALUES, and all columns for `FROM t` and `TABLE t`. Undefined when the text does not say (PIVOT, a parenthesis).
 */
export function queryColumns(tokens: readonly SqlToken[]): TextColumn[] | undefined {
  const first = keywordOf(tokens[0]);
  if (first === 'VALUES') return valuesColumns(tokens);
  if (first === 'TABLE') return [STAR];
  const depths = depthsOf(tokens);
  const top = (index: number): string => (depths[index] === 0 ? (keywordOf(tokens[index]) ?? '') : '');
  if (tokens.some((_, index) => ['PIVOT', 'UNPIVOT'].includes(top(index)))) return undefined;
  const select = tokens.findIndex((_, index) => top(index) === 'SELECT');
  if (select < 0) return tokens.some((_, index) => top(index) === 'FROM') ? [STAR] : undefined;
  const start = listStart(tokens, select + 1);
  const end = tokens.findIndex((_, index) => index >= start && LIST_ENDS.has(top(index)));
  // DuckDB allows a comma after the last item.
  const items = split(tokens.slice(start, end < 0 ? tokens.length : end)).filter((item) => item.length > 0);
  return items.map(itemColumn);
}

// The select list starts after DISTINCT, DISTINCT ON (...) or ALL.
function listStart(tokens: readonly SqlToken[], index: number): number {
  const word = keywordOf(tokens[index]);
  if (word === 'ALL') return index + 1;
  if (word !== 'DISTINCT') return index;
  const on = keywordOf(tokens[index + 1]) === 'ON' && opens(tokens[index + 2]);
  return on ? group(tokens, index + 2).next : index + 1;
}

// DuckDB names the columns of VALUES col0, col1, ... after the values of its first row.
function valuesColumns(tokens: readonly SqlToken[]): TextColumn[] | undefined {
  if (tokens[1]?.word !== '(') return undefined;
  return split(group(tokens, 1).inside).map((_, index) => ({
    kind: 'column',
    alias: `col${index}`,
    path: undefined,
  }));
}

function itemColumn(item: readonly SqlToken[]): TextColumn {
  if (item.some((token, index) => EXPANDING.has(keywordOf(token) ?? '') && opens(item[index + 1]))) {
    return UNKNOWN;
  }
  const named = aliased(item);
  if (named) return { kind: 'column', alias: named.alias, path: referencePath(named.value) };
  const path = referencePath(item);
  if (path) return { kind: 'column', alias: undefined, path };
  return starOf(item) ?? { kind: 'expression' };
}

// `x AS a`, `a: x` and `x a`; a word after a keyword (`INTERVAL 1 DAY`, `x::INT`) is no alias.
function aliased(item: readonly SqlToken[]): { alias: string; value: SqlToken[] } | undefined {
  const [first, second] = item;
  if (first && isWord(first) && second?.word === ':' && item.length > 2) {
    return { alias: unquote(first.word), value: item.slice(2) };
  }
  const [before, last] = item.slice(-2);
  if (item.length < 2 || !before || !last || !isWord(last)) return undefined;
  if (keywordOf(before) === 'AS') return { alias: unquote(last.word), value: item.slice(0, -2) };
  return last.type !== 'KEYWORD' && endsOperand(before)
    ? { alias: unquote(last.word), value: item.slice(0, -1) }
    : undefined;
}

function endsOperand(token: SqlToken): boolean {
  if (isDot(token)) return false;
  if (isWord(token)) return token.type !== 'KEYWORD';
  return closes(token) || token.type === 'STRING_LITERAL' || token.type === 'NUMBER_LITERAL';
}

// `a`, `t.a`, `t.s.f`: names and dots only, no keyword.
function referencePath(tokens: readonly SqlToken[]): string[] | undefined {
  const names = tokens.filter((_, index) => index % 2 === 0);
  const valid =
    tokens.length % 2 === 1 &&
    names.every((token) => isWord(token) && token.type !== 'KEYWORD') &&
    tokens.every((token, index) => index % 2 === 0 || isDot(token));
  return valid ? names.map(({ word }) => unquote(word)) : undefined;
}

// `*` and `t.*` with EXCLUDE, REPLACE and RENAME; another modifier (`LIKE`, ...) leaves the columns unknown.
function starOf(item: readonly SqlToken[]): TextColumn | undefined {
  const at = item.findIndex((token) => token.word === '*' && token.type === 'OPERATOR');
  const dot = item[at - 1];
  const qualifier = at === 0 ? [] : dot && isDot(dot) ? referencePath(item.slice(0, at - 1)) : undefined;
  if (at < 0 || !qualifier) return undefined;
  const exclude: string[] = [];
  const rename = new Map<string, string>();
  for (let index = at + 1; index < item.length;) {
    const keyword = keywordOf(item[index]);
    const { elements, next } = modifierList(item, index + 1);
    if (keyword === 'EXCLUDE') {
      exclude.push(...elements.map((element) => lastName(element).toLowerCase()));
    } else if (keyword === 'RENAME' && elements.every((element) => keywordOf(element.at(-2)) === 'AS')) {
      elements.forEach((element) =>
        rename.set(lastName(element.slice(0, -2)).toLowerCase(), lastName(element)),
      );
    } else if (keyword !== 'REPLACE') {
      return UNKNOWN;
    }
    index = next;
  }
  return { kind: 'star', qualifier, exclude, rename };
}

// The list after EXCLUDE, REPLACE or RENAME: in parentheses, or one name.
function modifierList(item: readonly SqlToken[], index: number): { elements: SqlToken[][]; next: number } {
  if (opens(item[index])) {
    const { inside, next } = group(item, index);
    return { elements: split(inside), next };
  }
  let end = index + 1;
  while (item[end]?.word === '.') end += 2;
  return { elements: [item.slice(index, end)], next: end };
}

const lastName = (tokens: readonly SqlToken[]): string => unquote(tokens.at(-1)?.word ?? '');
