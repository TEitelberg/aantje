import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { caretRange, splitScript, utf16Offsets } from '../../src/sql/script';
import type { Token } from '../../src/sql/script';

// sql_tokenize, the prepare and the error texts are part of DuckDB itself: no extension is needed.
let instance: DuckDBInstance;
let connection: DuckDBConnection;
beforeAll(async () => {
  instance = await DuckDBInstance.create(':memory:');
  connection = await instance.connect();
});
afterAll(() => {
  connection.closeSync();
  instance.closeSync();
});

async function tokensOf(script: string): Promise<Token[]> {
  const rows = (
    await connection.runAndReadAll('SELECT start, token_type, word FROM sql_tokenize($1)', [script])
  ).getRowsJson() as unknown as [number, string, string][];
  return rows.map(([start, type, word]) => ({ start, type, word }));
}

async function statementsOf(script: string) {
  return splitScript(script, await tokensOf(script));
}

/** The message DuckDB gives for a statement that fails while it runs. */
async function failureOf(sql: string): Promise<string> {
  try {
    const result = await (await connection.prepare(sql)).stream();
    try {
      await result.fetchChunk();
    } finally {
      result.closeSync();
    }
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${sql} did not fail`);
}

describe('utf16Offsets', () => {
  it('converts the UTF-8 byte offsets of DuckDB to UTF-16 offsets, is the identity for ASCII and stops at the end', () => {
    // a: byte 0, euro sign: bytes 1-3, emoji: bytes 4-7, b: byte 8, end: byte 9
    expect([0, 1, 4, 8, 9].map(utf16Offsets('a€😀b'))).toEqual([0, 1, 2, 4, 5]);
    expect([0, 7, 8, 99].map(utf16Offsets('select 1'))).toEqual([0, 7, 8, 8]);
  });
});

describe('splitScript with the tokens of DuckDB', () => {
  it('cuts a script into its statements with their offsets, keywords and exact text', async () => {
    const script =
      'SELECT 1;\n  insert INTO t VALUES (1)  ;\r\nWITH a AS (SELECT 2) SELECT * FROM a;(SELECT 3)';

    const statements = await statementsOf(script);

    expect(statements).toEqual([
      { sql: 'SELECT 1', offset: 0, keyword: 'SELECT' },
      { sql: 'insert INTO t VALUES (1)', offset: script.indexOf('insert'), keyword: 'INSERT' },
      { sql: 'WITH a AS (SELECT 2) SELECT * FROM a', offset: script.indexOf('WITH'), keyword: 'WITH' },
      { sql: '(SELECT 3)', offset: script.indexOf('(SELECT 3)'), keyword: 'SELECT' },
    ]);
  });

  it('keeps a semicolon inside a string, a quoted name, a comment and a dollar-quoted block', async () => {
    const script = [
      'SELECT \'a;b\', "c;d" FROM t; -- not; a split',
      "/* nor; this */ SELECT $$x;y$$, $tag$ ; $tag$; SELECT 'it''s; fine'",
    ].join('\n');

    const statements = await statementsOf(script);

    expect(statements.map(({ sql }) => sql)).toEqual([
      'SELECT \'a;b\', "c;d" FROM t',
      'SELECT $$x;y$$, $tag$ ; $tag$',
      "SELECT 'it''s; fine'",
    ]);
  });

  it('drops empty statements and comments, and finds nothing in a script that has only those', async () => {
    const script = '-- first\n;;  SELECT 1;; ;\n/* last */ -- really last';

    expect(await statementsOf(script)).toEqual([
      { sql: 'SELECT 1', offset: script.indexOf('SELECT'), keyword: 'SELECT' },
    ]);
    for (const empty of ['', '   \n\t', '-- a comment', '/* a */ ; -- b\n;']) {
      expect(await statementsOf(empty), JSON.stringify(empty)).toEqual([]);
    }
  });

  it('counts the offsets in UTF-16 units after non-ASCII text, as the editor does', async () => {
    const script = "SELECT 'ä€😀' AS a;\r\n-- Comment with Ümläuts\r\nSELECT '漢字';\r\nSELECT 3";

    const statements = await statementsOf(script);

    expect(statements.map(({ offset }) => offset)).toEqual([
      0,
      script.indexOf("SELECT '漢字'"),
      script.indexOf('SELECT 3'),
    ]);
    for (const { sql, offset } of statements) {
      expect(script.slice(offset, offset + sql.length)).toBe(sql);
    }
  });
});

describe('caretRange', () => {
  it.each(['', 'ä€😀', '漢字'])(
    'points to the failing expression behind the text "%s", which DuckDB measures in display columns',
    async (before) => {
      const sql = `SELECT '${before}', CAST('abc' AS INT)`;

      const range = caretRange(await failureOf(sql), sql);

      expect(range).toEqual({ offset: sql.indexOf('CAST'), length: "CAST('abc' AS INT)".length });
    },
  );

  it('counts the line in a statement with CRLF line breaks', async () => {
    const sql = "SELECT 'ä€😀' AS b,\r\n   nonexist_col\r\n  FROM (SELECT 1 x) t";

    const range = caretRange(await failureOf(sql), sql);

    expect(range).toEqual({ offset: sql.indexOf('nonexist_col'), length: 'nonexist_col'.length });
  });

  it('gives the whole line when DuckDB has shortened it with an ellipsis, and no range without a position', async () => {
    const long = `SELECT '${'x'.repeat(300)}', CAST('abc' AS INT)`;
    const none = "SELECT error('boom')";

    expect(caretRange(await failureOf(long), long)).toEqual({ offset: 0, length: long.length });
    expect(caretRange(await failureOf(none), none)).toBeUndefined();
  });
});
