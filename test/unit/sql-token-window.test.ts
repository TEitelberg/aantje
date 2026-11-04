import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { utf16Offsets } from '../../src/sql/script';
import { tokenWindow } from '../../src/sql/token-window';
import type { SqlToken } from '../../src/sql/tokens';

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

/** DuckDB's tokens of the whole text, as the language service reads them. */
async function tokenize(text: string): Promise<SqlToken[]> {
  const reader = await connection.runAndReadAll('SELECT start, token_type, word FROM sql_tokenize($1)', [
    text,
  ]);
  const unitOf = utf16Offsets(text);
  return (reader.getRowsJson() as unknown as [number, string, string][]).map(([start, type, word]) => {
    const offset = unitOf(Number(start));
    return { start: offset, end: offset + word.length, type, word };
  });
}

it('gives the tokens of the whole text at least to the end of the statement, reading only from the statement that changed', async () => {
  let read = 0;
  const window = tokenWindow((text) => {
    read += text.length;
    return tokenize(text);
  });
  const script = 'SELECT a, b FROM t WHERE x = 1;\n'.repeat(500);
  // Each step: the text, the cursor, at most how many characters are read for it.
  const steps: [string, number, number][] = [
    [`${script}SELECT `, script.length + 7, script.length + 7],
    [`${script}SELECT a`, script.length + 8, 100],
    [`${script}SELECT a, 'ü😀', "größe"`, script.length + 25, 100],
    // The cursor in an earlier statement: the tokens of the text are known up to there.
    [`${script}SELECT a, 'ü😀', "größe"`, 40, 0],
    // A change at the start: what follows is read again up to the cursor's statement.
    [`SELECT 9;\n${script}SELECT a`, 15, 5000],
    // A quote that opens a string to the end of the text, and its closing again.
    [`SELECT 'a;\n${script}SELECT a`, 12, Infinity],
    [`SELECT 'a';\n${script}SELECT a`, 12, 5000],
    [`/* ${script}SELECT a`, script.length + 10, Infinity],
  ];
  for (const [text, offset, most] of steps) {
    read = 0;
    const tokens = await window.upTo(text, offset);
    const whole = await tokenize(text);
    const end = whole.findIndex((token) => token.type === 'TERMINATOR' && token.start >= offset);
    expect(tokens.length, text.slice(0, 40)).toBeGreaterThanOrEqual(end < 0 ? whole.length : end + 1);
    expect(tokens, text.slice(0, 40)).toEqual(whole.slice(0, tokens.length));
    expect(read, text.slice(0, 40)).toBeLessThanOrEqual(most);
  }
  const last = steps.at(-1)?.[0] ?? '';
  expect(await window.all(last)).toEqual(await tokenize(last));
});
