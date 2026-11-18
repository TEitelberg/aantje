// What a statement does, judged by DuckDB's tokens, so that a word in a string, a quoted name or a comment does not
// count. The CodeLens offers Analysis (EXPLAIN ANALYZE) by it, the SQL editor reloads the explorer by it, and the check
// while typing parses a statement on its own by it. What is not understood counts as writing.
import { foldIdentifier } from '../catalog/ddl';
import { GLOBAL_LAKE_FUNCTIONS, LAKE_FUNCTIONS } from './ducklake';
import { closing, isClose, isDot, isOpen, isWord, keywordOf, unquote } from './tokens';
import type { SqlToken } from './tokens';

/** What the judgement reads of a token: the session's tokens count bytes, the editor's UTF-16 units. */
export type KindToken = Pick<SqlToken, 'type' | 'word'>;

/**
 * - `reads`: a query in which nothing writes; EXPLAIN ANALYZE can run it, and the catalog stays as it was.
 * - `keeps`: no query, but the catalog stays as it was: `SET`, `USE`, `BEGIN`, `SHOW`, `LOAD`, `EXPLAIN` without `ANALYZE`.
 * - `writes`: anything else, also what is not understood; it may change the catalog.
 */
export type StatementKind = 'reads' | 'keeps' | 'writes';

// The first words of a query.
const QUERIES = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE']);
// Writes that can be built on a query: INSERT ... SELECT, CREATE TABLE ... AS, COPY (SELECT ...) TO.
const WRITES_FROM_QUERY = new Set(['INSERT', 'CREATE', 'COPY']);
// The words between CREATE and the kind of object: CREATE OR REPLACE TEMP TABLE.
const CREATE_PREFIX = new Set(['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'PERSISTENT']);
// The first words of a statement that `json_serialize_sql` may serialize: a query, or one that shows a query.
const SERIALIZED = new Set([...QUERIES, 'DESCRIBE', 'SUMMARIZE', 'SHOW']);
// Statements that leave the catalog as it is, whatever follows them. EXPLAIN and SUMMARIZE are judged by what they run.
const KEEPS_CATALOG = new Set([
  'DESCRIBE',
  'SHOW',
  'PRAGMA',
  'SET',
  'RESET',
  'USE',
  'BEGIN',
  'START',
  'ROLLBACK',
  'ABORT',
  'LOAD',
  'INSTALL',
]);

// Keywords that write or do more than read, wherever they stand: in a CTE, in a subquery.
const WRITING_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'TRUNCATE',
  'CREATE',
  'DROP',
  'ALTER',
  'COPY',
  'ATTACH',
  'DETACH',
  'CALL',
  'CHECKPOINT',
  'VACUUM',
  'EXPORT',
  'IMPORT',
  'INSTALL',
  'LOAD',
]);

// Functions that change state inside a query: the sequences, `query`, which runs SQL given as a string, and the
// procedures of DuckLake, the global ones and those behind the lake's name (`lake.merge_adjacent_files()`).
const WRITING_FUNCTIONS: ReadonlySet<string> = new Set([
  'nextval',
  'setval',
  'query',
  ...[...GLOBAL_LAKE_FUNCTIONS, ...LAKE_FUNCTIONS]
    .filter(({ procedure }) => procedure)
    .map(({ name }) => name),
]);

/** The first word of a statement in upper case, past opening parentheses: `(SELECT 1)` is a SELECT. */
export function firstKeyword(tokens: readonly KindToken[]): string | undefined {
  return keywordOf(tokens.find((token) => !isOpen(token)));
}

/** Whether a token list holds a keyword that writes, or calls a function that does. Fails closed on doubt. */
export function writes(tokens: readonly KindToken[]): boolean {
  return tokens.some((token, index) => {
    const keyword = keywordOf(token);
    if (keyword !== undefined && WRITING_KEYWORDS.has(keyword)) return true;
    return (
      isWord(token) && isOpen(tokens[index + 1]) && WRITING_FUNCTIONS.has(foldIdentifier(unquote(token.word)))
    );
  });
}

// EXPLAIN ANALYZE, or ANALYZE among the options of EXPLAIN (...): DuckDB runs the statement.
function analyzes(tokens: readonly KindToken[]): boolean {
  const at = tokens.findIndex((token) => keywordOf(token) === 'EXPLAIN');
  const next = tokens[at + 1];
  const analyze = (token: KindToken): boolean => ['ANALYZE', 'ANALYSE'].includes(keywordOf(token) ?? '');
  if (next && analyze(next)) return true;
  if (!isOpen(next)) return false;
  const end = closing(tokens, at + 1);
  return tokens.slice(at + 2, end < 0 ? undefined : end).some(analyze);
}

/** What a statement does; see `StatementKind`. */
export function statementKind(tokens: readonly KindToken[]): StatementKind {
  const first = firstKeyword(tokens);
  if (first === undefined) return 'writes';
  if (QUERIES.has(first)) return writes(tokens) ? 'writes' : 'reads';
  if (first === 'EXPLAIN') return analyzes(tokens) && writes(tokens) ? 'writes' : 'keeps';
  if (first === 'SUMMARIZE') return writes(tokens) ? 'writes' : 'keeps';
  return KEEPS_CATALOG.has(first) ? 'keeps' : 'writes';
}

/** Whether the statement runs a query: it is one, or a write built on one; a view or a macro only stores its query. */
export function runsQuery(tokens: readonly KindToken[]): boolean {
  const first = firstKeyword(tokens);
  if (first === undefined) return false;
  if (QUERIES.has(first)) return true;
  if (!WRITES_FROM_QUERY.has(first)) return false;
  if (first === 'CREATE') {
    const kind = tokens.slice(1).find((token) => !CREATE_PREFIX.has(keywordOf(token) ?? ''));
    if (keywordOf(kind) !== 'TABLE') return false;
  }
  return tokens.some(
    (token, index) =>
      keywordOf(token) === 'SELECT' ||
      (keywordOf(token) === 'AS' && QUERIES.has(keywordOf(tokens[index + 1]) ?? '')),
  );
}

/** Whether `json_serialize_sql` may serialize a statement that starts with the keyword (DuckDB serializes no other). */
export function isSerialized(keyword: string): boolean {
  return SERIALIZED.has(keyword);
}

/** An UPDATE or DELETE that hits every row of its table, and the table as the statement names it. */
export interface UnfilteredWrite {
  readonly keyword: 'UPDATE' | 'DELETE';
  readonly target: string;
}

// The keywords that start the statement of a WITH: the first of them outside parentheses is it.
const STATEMENT_WORDS = new Set(['SELECT', 'FROM', 'VALUES', 'TABLE', 'INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * The UPDATE or DELETE (also after a WITH) that has no WHERE outside parentheses, or one that is always true
 * (`WHERE true`, `WHERE 1 = 1`); undefined for any other statement. Judged by the tokens, as `statementKind` is.
 */
export function unfilteredWrite(tokens: readonly KindToken[]): UnfilteredWrite | undefined {
  let depth = 0;
  const outside = tokens.map((token) => {
    if (isOpen(token)) depth++;
    else if (isClose(token)) depth--;
    return depth === 0 && !isClose(token);
  });
  const at = tokens.findIndex(
    (token, index) => outside[index] && STATEMENT_WORDS.has(keywordOf(token) ?? ''),
  );
  const keyword = keywordOf(tokens[at]);
  if (keyword !== 'UPDATE' && keyword !== 'DELETE') return undefined;
  let name = at + 1;
  if (keyword === 'DELETE' && keywordOf(tokens[name++]) !== 'FROM') return undefined;
  if (keyword === 'UPDATE' && keywordOf(tokens[name]) === 'ONLY') name++;
  // The name as written: words joined by dots.
  const target: string[] = [];
  for (let part = tokens[name]; part && isWord(part); part = tokens[(name += 2)]) {
    target.push(part.word);
    const next = tokens[name + 1];
    if (!next || !isDot(next)) break;
    target.push(next.word);
  }
  if (target.length === 0) return undefined;
  const where = tokens.findIndex(
    (token, index) => index > at && outside[index] && keywordOf(token) === 'WHERE',
  );
  if (where >= 0 && !alwaysTrue(conditionOf(tokens.slice(where + 1)))) return undefined;
  return { keyword, target: target.join('') };
}

// The condition of a WHERE: up to RETURNING, without parentheses around all of it.
function conditionOf(tokens: readonly KindToken[]): readonly KindToken[] {
  const end = tokens.findIndex((token) => keywordOf(token) === 'RETURNING');
  let condition = end < 0 ? tokens : tokens.slice(0, end);
  while (isOpen(condition[0]) && closing(condition, 0) === condition.length - 1) {
    condition = condition.slice(1, -1);
  }
  return condition;
}

// `true`, or a literal compared with the same literal (`1 = 1`, `'a' = 'a'`).
function alwaysTrue(condition: readonly KindToken[]): boolean {
  const [left, operator, right] = condition;
  if (condition.length === 1) return keywordOf(left) === 'TRUE';
  return (
    condition.length === 3 &&
    operator?.word === '=' &&
    (left?.type === 'NUMBER_LITERAL' || left?.type === 'STRING_LITERAL') &&
    left.type === right?.type &&
    left.word === right.word
  );
}
