// The keywords that completion offers first: at the start of a statement, after a clause and in an expression.

export const STATEMENT_KEYWORDS = [
  ...['SELECT', 'WITH', 'FROM', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'COPY', 'EXPLAIN'],
  ...['DESCRIBE', 'SUMMARIZE', 'USE', 'SET', 'RESET', 'PRAGMA', 'CALL', 'BEGIN', 'COMMIT', 'ROLLBACK'],
  ...['ATTACH', 'DETACH', 'TRUNCATE', 'VALUES', 'CHECKPOINT', 'COMMENT', 'PIVOT', 'UNPIVOT', 'SHOW', 'MERGE'],
];

/** The words that usually come next, by `CursorContext.clause`; the other keywords follow them. */
export const NEXT_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  from: [
    ...['WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'QUALIFY', 'LIMIT', 'JOIN', 'INNER JOIN', 'LEFT JOIN'],
    ...[
      'RIGHT JOIN',
      'FULL JOIN',
      'CROSS JOIN',
      'NATURAL JOIN',
      'ASOF JOIN',
      'POSITIONAL JOIN',
      'ON',
      'USING',
    ],
    ...['AS', 'AT', 'UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT'],
  ],
  into: ['VALUES', 'SELECT', 'DEFAULT VALUES', 'BY NAME', 'ON CONFLICT'],
  update: ['AS', 'SET'],
  delete: ['WHERE', 'USING', 'RETURNING'],
  alter: ['ADD COLUMN', 'DROP COLUMN', 'RENAME COLUMN', 'RENAME TO', 'ALTER COLUMN'],
  drop: ['CASCADE', 'RESTRICT'],
  create: ['AS'],
  comment: ['IS'],
  copy: ['TO', 'FROM'],
  pivot: ['ON', 'USING', 'GROUP BY'],
  unpivot: ['ON'],
  'unpivot-into': ['NAME', 'VALUE'],
  // The parts of a window specification and of its frame.
  over: ['PARTITION BY', 'ORDER BY', 'ROWS', 'RANGE', 'GROUPS'],
  frame: ['BETWEEN', 'UNBOUNDED PRECEDING', 'CURRENT ROW'],
  'frame-start': ['UNBOUNDED PRECEDING', 'CURRENT ROW'],
  'frame-direction': ['PRECEDING', 'FOLLOWING'],
  'frame-current': ['ROW'],
  'frame-and': ['AND'],
  'frame-end': ['UNBOUNDED FOLLOWING', 'CURRENT ROW'],
  'frame-exclude': ['EXCLUDE CURRENT ROW', 'EXCLUDE GROUP', 'EXCLUDE TIES', 'EXCLUDE NO OTHERS'],
  exclude: ['CURRENT ROW', 'GROUP', 'TIES', 'NO OTHERS'],
};

/** DESCRIBE and SUMMARIZE take a query as well as a table. */
export const QUERY_KEYWORDS = ['SELECT', 'FROM', 'WITH'];

export const EXPRESSION_KEYWORDS = [
  ...['AND', 'OR', 'NOT', 'IN', 'LIKE', 'ILIKE', 'BETWEEN', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN'],
  ...['THEN', 'ELSE', 'END', 'CAST', 'EXISTS', 'DISTINCT', 'AS', 'ASC', 'DESC', 'FROM', 'WHERE'],
];
