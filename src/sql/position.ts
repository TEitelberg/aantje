import { isWord, keywordOf } from './tokens';
import type { SqlToken } from './tokens';

/** What the user can type at the cursor; completion picks the items for it. */
export type Position =
  /** Inside a string literal, a comment or a number: nothing to complete. */
  | 'inert'
  /** The start of a statement or of a subquery. */
  | 'statement'
  /** Between the parts of a clause, e.g. after a table name: the next keyword. */
  | 'keyword'
  /** A table or view (INSERT INTO, UPDATE, DROP TABLE, ...). */
  | 'relation'
  /** A table, view or table function after FROM or JOIN. */
  | 'from'
  /** `schema.table.column` of COMMENT ON COLUMN. */
  | 'column-path'
  | 'schema'
  /** The name of a table or view that is being created: only its schema can be completed. */
  | 'new-relation'
  /** A column, function or keyword in an expression. */
  | 'expression'
  /** A column of the table that the statement changes. */
  | 'target-column'
  /** A column of the relations in scope and nothing else: `* EXCLUDE (`, `* REPLACE (x AS`, the IN list of UNPIVOT. */
  | 'column'
  /** An option name in `COPY ... TO 'file' (`. */
  | 'copy-option'
  /** The value of `FORMAT` among the options of COPY. */
  | 'copy-format'
  /** An expression without columns in scope (VALUES, LIMIT, arguments of a table function). */
  | 'value'
  | 'type'
  /** Inside `AT (`: the keywords VERSION and TIMESTAMP. */
  | 'snapshot-clause'
  | 'snapshot-version'
  | 'snapshot-timestamp'
  | 'setting'
  | 'call'
  /** A new name (an alias, a new column): nothing to suggest. */
  | 'name';

export type FrameKind =
  | 'statement'
  | 'subquery'
  | 'call'
  | 'group'
  | 'values'
  | 'insert-columns'
  | 'column-list'
  | 'create-columns'
  | 'snapshot'
  | 'quiet'
  /** `OVER (...)` and `WINDOW w AS (...)`. */
  | 'window'
  /** `PIVOT (...)` or `UNPIVOT (...)` after a relation of FROM; `name` says which. */
  | 'pivot'
  /** The column lists of `* EXCLUDE (...)` and of `UNPIVOT (... IN (...))`. */
  | 'columns'
  | 'replace'
  | 'rename'
  | 'copy-options'
  /** The column aliases of `WITH c(a, b)` and `FROM t x(a, b)`: new names. */
  | 'aliases';

/** A lambda (`lambda x, y: body`) that is being read: its parameters, and whether its body has started. */
export interface Lambda {
  readonly params: string[];
  body: boolean;
}

/** The part of a frame that decides what can be typed, copied at the cursor. */
export interface State {
  kind: FrameKind;
  statement: string | undefined;
  clause: string;
  expectRelation: boolean;
  afterRelation: boolean;
  setTarget: boolean;
  createTarget: boolean;
  columnPath: boolean;
  /** A table function call in FROM or CALL: its arguments are values. */
  inFrom: boolean;
  /** The upper case function name of a call; PIVOT or UNPIVOT for a pivot frame. */
  name: string | undefined;
  lambda: Lambda | undefined;
}

// Open frames at the cursor, innermost first.
type StateChain = readonly { readonly state: State }[];

const word1 = (prev: readonly SqlToken[], back: number): string | undefined => keywordOf(prev.at(-back));
const isOperator = (token: SqlToken | undefined, text: string): boolean =>
  token?.word === text && token.type === 'OPERATOR';
const opensItem = (token: SqlToken | undefined): boolean => isOperator(token, '(') || isOperator(token, ',');

/** A `*` after this token stands for all columns (`SELECT *`, `t.*`, `COLUMNS(*)`); after an operand it multiplies. */
export const startsItem = (token: SqlToken | undefined): boolean =>
  token === undefined ||
  token.word === '.' ||
  opensItem(token) ||
  ['SELECT', 'DISTINCT', 'ALL'].includes(keywordOf(token) ?? '');

/** Where the cursor is, from the open frames and the tokens before it. */
export function positionOf(chain: StateChain, prev: readonly SqlToken[]): Position {
  const [link, ...rest] = chain;
  if (!link) return 'keyword';
  const { state } = link;
  if (isOperator(prev.at(-1), '::')) return 'type';
  const head = headPosition(state, prev);
  if (head) return head;
  switch (state.kind) {
    case 'call':
      if (state.inFrom) return 'value';
      if ((state.name === 'CAST' || state.name === 'TRY_CAST') && word1(prev, 1) === 'AS') return 'type';
      return positionOf(rest, prev);
    case 'group':
      return positionOf(rest, prev);
    case 'replace':
      return word1(prev, 1) === 'AS' ? 'column' : positionOf(rest, prev);
    case 'statement':
    case 'subquery':
      return clausePosition(state, prev);
    default:
      return listPosition(state, prev);
  }
}

// The parameters of a lambda are new names; `* EXCLUDE` without parentheses is followed by a column.
function headPosition(state: State, prev: readonly SqlToken[]): Position | undefined {
  if (state.lambda && !state.lambda.body) return 'name';
  if (word1(prev, 1) === 'EXCLUDE' && isOperator(prev.at(-2), '*') && startsItem(prev.at(-3)))
    return 'column';
  return undefined;
}

function listPosition(state: State, prev: readonly SqlToken[]): Position {
  const last = prev.at(-1);
  switch (state.kind) {
    case 'snapshot':
      return snapshotPosition(prev);
    case 'insert-columns':
    case 'column-list':
      return opensItem(last) ? 'target-column' : 'keyword';
    case 'create-columns':
      if (opensItem(last)) return 'name';
      return last && isWord(last) && opensItem(prev.at(-2)) ? 'type' : 'keyword';
    case 'values':
      return 'value';
    default:
      return duckdbPosition(state, prev);
  }
}

// The frames of DuckDB's own constructs.
function duckdbPosition({ kind, clause, name }: State, prev: readonly SqlToken[]): Position {
  const [one, last] = [word1(prev, 1), prev.at(-1)];
  switch (kind) {
    case 'window':
      return clause === 'partition' || clause === 'order' ? 'expression' : 'keyword';
    case 'pivot':
      return name === 'UNPIVOT' || one === 'AS' ? 'name' : 'expression';
    case 'columns':
      return opensItem(last) ? 'column' : 'keyword';
    case 'rename':
      return one === 'AS' ? 'name' : opensItem(last) ? 'column' : 'keyword';
    case 'copy-options':
      return one === 'FORMAT' ? 'copy-format' : opensItem(last) ? 'copy-option' : 'name';
    default:
      return 'name';
  }
}

function snapshotPosition(prev: readonly SqlToken[]): Position {
  if (isOperator(prev.at(-1), '=>')) {
    const name = word1(prev, 2);
    return name === 'VERSION' ? 'snapshot-version' : name === 'TIMESTAMP' ? 'snapshot-timestamp' : 'name';
  }
  return opensItem(prev.at(-1)) ? 'snapshot-clause' : 'name';
}

// Clauses with a fixed position; any other clause allows a keyword only.
const CLAUSE_POSITIONS = new Map(
  (
    [
      ['statement', 'with union'],
      ['expression', 'select where group order having qualify on returning'],
      ['value', 'limit values'],
      ['schema', 'use schema'],
      ['call', 'call'],
      ['name', 'create-name create-index copy-to copy-from'],
    ] as const
  ).flatMap(([position, clauses]) =>
    clauses.split(' ').map((clause) => [clause, position as Position] as const),
  ),
);

const SETTING_WORDS = new Set(['SET', 'RESET', 'SESSION', 'GLOBAL', 'LOCAL', 'VARIABLE']);

function relationPosition(state: State): Position {
  if (state.createTarget) return 'new-relation';
  if (state.columnPath) return 'column-path';
  if (state.clause === 'pivot' || state.clause === 'unpivot') return 'from';
  return state.clause === 'from' && state.statement !== 'DELETE' ? 'from' : 'relation';
}

function clausePosition(state: State, prev: readonly SqlToken[]): Position {
  if (state.expectRelation) return relationPosition(state);
  if (word1(prev, 1) === 'AS') return state.statement === 'CREATE' ? 'statement' : 'name';
  if (state.afterRelation) return state.statement === 'ALTER' ? alterPosition(prev) : 'keyword';
  switch (state.clause) {
    case '':
      return state.statement === undefined ? 'statement' : 'keyword';
    case 'set':
      return state.setTarget ? 'target-column' : 'expression';
    case 'setting':
      return SETTING_WORDS.has(word1(prev, 1) ?? '') ? 'setting' : 'value';
    case 'unpivot-into':
      return ['NAME', 'VALUE'].includes(word1(prev, 1) ?? '') ? 'name' : 'keyword';
    default:
      return CLAUSE_POSITIONS.get(state.clause) ?? 'keyword';
  }
}

// After `ALTER TABLE t`: ADD, DROP, RENAME and ALTER COLUMN take columns, names and types in turn.
function alterPosition(prev: readonly SqlToken[]): Position {
  const [one, two, three] = [word1(prev, 1), word1(prev, 2), word1(prev, 3)];
  if (one === 'TYPE') return 'type';
  if (one === 'TO') return 'name';
  if (one === 'COLUMN') return two === 'ADD' ? 'name' : 'target-column';
  if (one === 'DROP' || one === 'ALTER') return 'target-column';
  if (two === 'ADD' || (two === 'COLUMN' && three === 'ADD')) return 'type';
  return 'keyword';
}
