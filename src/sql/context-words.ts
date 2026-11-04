// Word lists that the cursor context reads statements with.
import type { FrameKind } from './position';

/** Words that end a table name or start a clause: they are never an alias. */
const STOP = new Set([
  ...['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'QUALIFY', 'LIMIT', 'OFFSET', 'JOIN', 'INNER'],
  ...['LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'ASOF', 'POSITIONAL', 'SEMI', 'ANTI', 'OUTER', 'LATERAL'],
  ...['ON', 'USING', 'UNION', 'INTERSECT', 'EXCEPT', 'SET', 'VALUES', 'RETURNING', 'WITH', 'AT', 'WINDOW'],
  ...['SAMPLE', 'TABLESAMPLE', 'PIVOT', 'UNPIVOT', 'AS', 'BY', 'IS', 'TO', 'ADD', 'DROP', 'RENAME', 'ALTER'],
]);

/** Words in front of a name that are not part of it. */
export const SKIPPED_IN_NAME = new Set(['IF', 'NOT', 'EXISTS', 'ONLY', 'LATERAL', 'TABLE']);

/** An opening parenthesis after one of these starts a group, not a function call. */
export const NOT_A_CALL = new Set([
  ...['IN', 'ANY', 'ALL', 'SOME', 'NOT', 'AND', 'OR', 'ON', 'USING', 'WHERE', 'HAVING', 'SELECT', 'BY'],
  ...['WHEN', 'THEN', 'ELSE', 'CASE', 'BETWEEN', 'AS', 'SET', 'VALUES', 'UNION', 'FROM', 'JOIN', 'EXISTS'],
  ...['DISTINCT', 'RETURNING', 'LIMIT', 'OFFSET', 'QUALIFY', 'LATERAL', 'LIKE', 'ILIKE', 'IS', 'TO'],
]);

const PIVOT_WORDS = ['PIVOT', 'PIVOT_WIDER', 'UNPIVOT', 'PIVOT_LONGER'];

/** The words that end the list of common table expressions. */
export const WITH_ENDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'VALUES', ...PIVOT_WORDS]);

export const SUBQUERY_START = new Set(['SELECT', 'WITH', 'FROM', 'VALUES', 'TABLE', ...PIVOT_WORDS]);

/** The statements that name a table right after their first word. */
export const RELATION_AFTER_FIRST_WORD = new Set(['TRUNCATE', 'DESCRIBE', 'SUMMARIZE', 'COPY']);

export const isStop = (keyword: string | undefined): boolean => keyword !== undefined && STOP.has(keyword);

export const isClauseFrame = (frame: { readonly kind: FrameKind }): boolean =>
  frame.kind === 'statement' || frame.kind === 'subquery';
