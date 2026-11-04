import { afterAll, describe, expect, it } from 'vitest';
import { extract, lower } from '../../src/dependencies/references';
import type { Reference } from '../../src/dependencies/references';
import { sharedParser } from './dependencies-support';

const parser = sharedParser();
afterAll(() => parser.dispose());

/** What the real DuckDB parser finds in a statement, as `kind catalog.schema.name` (empty parts left out). */
async function found(sql: string): Promise<string[]> {
  const extraction = extract(await parser.serialize(sql));
  if ('reason' in extraction) {
    throw new Error(`${extraction.reason}: ${extraction.detail}`);
  }
  const short = { relation: 'table', scalarMacro: 'call', tableMacro: 'table call' } as const;
  return extraction.references.map(
    ({ kind, catalog, schema, name }: Reference) =>
      `${short[kind]} ${[catalog, schema, name].filter((part) => part !== '').join('.')}`,
  );
}

/** The statements and what each one names, as one table: the diff names the statement that went wrong. */
const STATEMENTS: Record<string, string[]> = {
  // Names in their parts; a quoted name as it is written.
  'SELECT * FROM lake.shop.events, main.t, plain': ['table lake.shop.events', 'table main.t', 'table plain'],
  'SELECT * FROM "We""ird ü; DROP" , "select"."from" JOIN "Ünï" USING (a)': [
    'table We"ird ü; DROP',
    'table select.from',
    'table Ünï',
  ],
  // Joins, subqueries, set operations, lateral subqueries, the WHERE clause, PIVOT.
  [`SELECT a FROM t1 JOIN t2 USING (a) LEFT JOIN (SELECT * FROM t3) s ON true
    WHERE a IN (SELECT a FROM t4) AND EXISTS (SELECT 1 FROM t5)
    UNION ALL SELECT a FROM t6 INTERSECT SELECT a FROM t7`]: [
    'table t1',
    'table t2',
    'table t3',
    'table t4',
    'table t5',
    'table t6',
    'table t7',
  ],
  'SELECT * FROM a, LATERAL (SELECT * FROM b WHERE b.x = a.x) l': ['table a', 'table b'],
  "SELECT * FROM t PIVOT (sum(a) FOR b IN ('x'))": ['table t', 'call sum'],
  // Calls in every part of the statement; a table function apart from the others; a lambda.
  'SELECT gross(1), sum(x) OVER (PARTITION BY fee(y)) FROM t WHERE ok(z)': [
    'call gross',
    'call sum',
    'call fee',
    'table t',
    'call ok',
  ],
  'SELECT * FROM shop.recent_events(3) e, range(5)': ['table call shop.recent_events', 'table call range'],
  'SELECT list_transform(l, x -> gross(x)) FROM t': ['call list_transform', 'call gross', 'table t'],
  // Function names in lower case, the schema as written.
  'SELECT GROSS(1), "Gross"(2), S.Foo(1)': ['call gross', 'call gross', 'call S.foo'],
  // CTEs: hidden unless qualified; a CTE does not see itself or the ones after it; its scope is its statement.
  'WITH events AS (SELECT 1 a) SELECT * FROM events, shop.events': ['table shop.events'],
  'WITH events AS (SELECT * FROM events) SELECT * FROM events': ['table events'],
  'WITH x AS (SELECT * FROM events), events AS (SELECT 5 a) SELECT * FROM x': ['table events'],
  'SELECT * FROM (WITH events AS (SELECT 2 a) SELECT * FROM events) q, events': ['table events'],
  'SELECT * FROM events WHERE a IN (WITH events AS (SELECT 9 a) SELECT * FROM events)': ['table events'],
  'WITH RECURSIVE r AS (SELECT 1 n UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT * FROM r': ['call +'],
  'WITH a AS (SELECT 1 x), b AS (SELECT * FROM a) SELECT * FROM b, c': ['table c'],
  // The statements that DuckDB writes FROM-first, as TABLE, as VALUES and in parentheses.
  'FROM t': ['table t'],
  'TABLE t': ['table t'],
  'VALUES (1), (2)': [],
  '(SELECT * FROM t)': ['table t'],
};

describe('the tables, views and functions that DuckDB finds in a statement', () => {
  it('finds the exact names of each statement, and compares names in lower case for A to Z only, like DuckDB', async () => {
    const actual: Record<string, string[]> = {};
    for (const sql of Object.keys(STATEMENTS)) {
      actual[sql] = await found(sql);
    }
    expect(actual).toEqual(STATEMENTS);
    expect([lower('Events'), lower('ABCXYZ'), lower('ÄB'), lower('äb')]).toEqual([
      'events',
      'abcxyz',
      'Äb',
      'äb',
    ]);
  });

  it('names the functions whose table is only known at run time', async () => {
    expect(extract(await parser.serialize("SELECT * FROM query_table('events')"))).toEqual({
      references: [{ kind: 'tableMacro', catalog: '', schema: '', name: 'query_table' }],
      dynamic: ['query_table'],
    });
  });

  it('reads a statement nested as deep as a text may be, without a limit of its own', () => {
    const depth = 100_000;
    const table = '{"type":"BASE_TABLE","table_name":"events","schema_name":"shop","catalog_name":""}';
    const document = `{"statements":[${'{"node":'.repeat(depth)}${table}${'}'.repeat(depth)}]}`;
    expect(extract(document)).toEqual({
      references: [{ kind: 'relation', catalog: '', schema: 'shop', name: 'events' }],
      dynamic: [],
    });
  });
});

describe('what the analysis says about a text that is not a SELECT it can read', () => {
  it('gives the reason and never a list of names, and does not trust an answer that is no JSON object', async () => {
    const texts: Record<string, string> = {
      'SELEC 1': 'syntax',
      'INSERT INTO t VALUES (1)': 'unsupported',
      'SELECT 1; DROP TABLE x': 'unsupported',
      '': 'unsupported',
    };
    const reasons: Record<string, unknown> = {};
    for (const sql of Object.keys(texts)) {
      const extraction = extract(await parser.serialize(sql));
      reasons[sql] = 'reason' in extraction ? extraction.reason : extraction;
    }
    expect(reasons).toEqual(texts);
    expect(extract(await parser.serialize('SELEC 1'))).toMatchObject({
      detail: 'syntax error at or near "SELEC"',
    });
    expect(extract('not json')).toEqual({ reason: 'unsupported', detail: 'DuckDB gave no readable answer' });
    expect(extract('[]')).toEqual({ reason: 'unsupported', detail: 'DuckDB gave no readable answer' });
  });

  it('shortens a message to one line of at most 200 characters, cutting only a longer one', () => {
    const detailOf = (message: string): string => {
      const extraction = extract(
        JSON.stringify({ error: true, error_type: 'parser', error_message: message }),
      );
      return 'detail' in extraction ? extraction.detail : '';
    };
    const multiline = detailOf(`syntax error\n${'x'.repeat(300)}`);
    expect([multiline.length, multiline.includes('\n')]).toEqual([200, false]);
    expect(
      [200, 201].map((length) => [
        detailOf('y'.repeat(length)).length,
        detailOf('y'.repeat(length)).endsWith('…'),
      ]),
    ).toEqual([
      [200, false],
      [200, true],
    ]);
  });
});
