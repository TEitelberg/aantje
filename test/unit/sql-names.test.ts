import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RelationColumn } from '../../src/data/types';
import { catalogOfReader } from '../../src/sql/catalog';
import type { SqlCatalog } from '../../src/sql/catalog';
import { openLanguageService } from '../../src/sql/language';
import type { Problem } from '../../src/sql/language';
import { nearestNames, quickFixes } from '../../src/sql/problems';
import { LATEST_SNAPSHOT } from '../support/expected';
import { copyDataFixture, engineSkipReason } from './data-support';
import { openHistory, openSales } from './sql-language-support';
import type { OpenCatalog } from './sql-language-support';
import { events, only, openFixtureSession } from './sql-support';

const skipReason = await engineSkipReason();
if (skipReason) console.warn(`The warned statements are not run on a lake: ${skipReason}`);

const service = openLanguageService();
let sales: OpenCatalog;
let history: OpenCatalog;
beforeAll(async () => {
  [sales, history] = await Promise.all([openSales(), openHistory()]);
});
afterAll(async () => {
  await service.dispose();
  await Promise.all([sales.close(), history.close()]);
});

interface Range {
  readonly offset: number;
  readonly length: number;
}

/** The text without its `«»` marks and the ranges they enclose, in order. */
function unmarked(source: string): { text: string; marks: Range[] } {
  const marks: Range[] = [];
  let text = '';
  for (const part of source.split(/(«[^»]*»)/)) {
    if (part.startsWith('«')) {
      marks.push({ offset: text.length, length: part.length - 2 });
      text += part.slice(1, -1);
    } else {
      text += part;
    }
  }
  return { text, marks };
}

async function problemsOf(text: string, catalog: SqlCatalog | undefined): Promise<readonly Problem[]> {
  const found = await service.diagnose(text, 'test', catalog);
  if (!found) throw new Error('The check was replaced.');
  return found;
}

/** Each warning as its range and the names that its quick fix offers. */
async function warnings(text: string, catalog: SqlCatalog): Promise<[number, number, readonly string[]][]> {
  return (await problemsOf(text, catalog)).map((problem) => {
    expect(problem.severity, text).toBe('warning');
    return [problem.offset, problem.length, problem.replacements];
  });
}

// The first quick fix of every warning, from the end of the text backwards so that the offsets stay valid.
function fixed(text: string, problems: readonly Problem[]): string {
  return problems.toReversed().reduce((result, problem) => {
    const [fix] = quickFixes(problem);
    return fix ? result.slice(0, fix.offset) + fix.text + result.slice(fix.offset + fix.length) : result;
  }, text);
}

/** The warned names stand in `«»`, with the names that each quick fix offers. */
const WARNED: Record<string, (readonly string[])[]> = {
  'SELECT * FROM sales.«ordrs»': [['orders']],
  'SELECT * FROM lake.sales.«ordrs» o': [['orders']],
  'SELECT * FROM «plan»': [['plain']],
  'SELECT * FROM lake.«plan»': [['plain']],
  'SELECT * FROM sales.«tmp»': [[]],
  'SELECT «amout» FROM sales.orders': [['amount']],
  'SELECT o.«amout», o.customer.name FROM sales.orders o': [['amount']],
  'SELECT o . «"Amout"» FROM "sales"."orders" AS o': [['"amount"']],
  'FROM sales.orders SELECT «amout»': [['amount']],
  'SELECT id FROM sales.orders WHERE «amout» > 1 ORDER BY «creatd»': [['amount'], ['created']],
  'WITH c AS (SELECT id AS k FROM sales.orders) SELECT c.«kk», «kk» FROM c': [['k'], ['k']],
  'WITH c(a, b) AS (SELECT id, amount FROM sales.orders) SELECT «aa» FROM c': [['a']],
  'SELECT v.«bb» FROM (VALUES (1, 2)) v(a, b)': [['b']],
  'SELECT «col» FROM (VALUES (1, 2))': [['col0', 'col1']],
  'SELECT s.«amout» FROM (SELECT * EXCLUDE (attrs) FROM sales.orders) s': [['amount']],
  'SELECT id FROM sales.orders WHERE id IN (SELECT «xx» FROM plain)': [['x']],
  'SELECT «di» FROM sales.orders o JOIN sales.orders p ON o.id = p.id': [['o.id', 'p.id']],
  'SELECT * FROM «ordrs»': [[]],
  'SELECT 1 AS a;\nCREATE TABLE made (a INTEGER);\nSELECT «amout» FROM sales.orders': [['amount']],
};

const NONE: readonly string[] = [
  // CTEs, aliases, lambdas, values without a column.
  'WITH orders AS (SELECT 1 AS a) SELECT a FROM orders',
  'WITH c(x) AS (SELECT id FROM sales.orders) SELECT x, c.x FROM c',
  'SELECT id AS k, k + 1 FROM sales.orders WHERE k > 0 ORDER BY k',
  'SELECT list_transform([1], x -> x + 1), list_transform([2], lambda y: y * 2) FROM plain',
  'SELECT current_date, current_user, rowid, filename, snapshot_id, o.rowid FROM sales.orders o',
  // Table functions, files, other catalogs, DuckDB's own views.
  "SELECT nope FROM range(3) r(i), read_csv('orders.csv', header = true) WHERE i > 1",
  'SELECT * FROM \'orders.parquet\', "orders.csv"',
  'SELECT * FROM other.t, memory.t, temp.main.t, other_db.main.t, system.main.t',
  'SELECT count(*) FROM duckdb_tables, main.duckdb_views, pg_tables, information_schema.tables',
  // Created, attached or changed by the document.
  'CREATE TEMP TABLE scratch AS SELECT 1 AS a; SELECT a, b FROM scratch',
  'CREATE TABLE sales.made AS SELECT 1 AS a; SELECT b FROM sales.made',
  'ALTER TABLE sales.orders ADD COLUMN extra INTEGER; SELECT extra FROM sales.orders',
  "ATTACH ':memory:' AS other; SELECT * FROM t, sales.nope",
  'USE lake.sales; SELECT * FROM orders',
  // Columns that are not known: a view without trust, made-up names, COLUMNS, a star over a join, PIVOT.
  'SELECT nope FROM sales.big_orders',
  'SELECT o.nope FROM sales.orders o JOIN sales.big_orders b ON true',
  'SELECT s.nope FROM (SELECT amount * 2 FROM sales.orders) s',
  "SELECT nope FROM (SELECT COLUMNS('a.*') FROM sales.orders)",
  'SELECT s.nope FROM (SELECT * FROM sales.orders o JOIN sales.orders p USING (id)) s',
  'SELECT nope FROM sales.orders PIVOT (sum(amount) FOR id IN (1, 2))',
  'SELECT a.nope FROM sales.orders UNION BY NAME SELECT 1 AS nope',
  // Struct fields, the row of a table, correlated and lateral subqueries.
  'SELECT customer.name, o.customer.tags, orders FROM sales.orders o, sales.orders',
  'SELECT id FROM sales.orders WHERE EXISTS (SELECT 1 FROM plain WHERE plain.x = id)',
  'SELECT l.k FROM sales.orders o, LATERAL (SELECT o.id AS k) l',
  // Other snapshots and AT clauses that name none.
  'SELECT a FROM sales.tmp AT (VERSION => 10)',
  'SELECT nope FROM sales.ordrs AT (TIMESTAMP => now())',
  // No queries, and a table of main through the lake's name.
  'INSERT INTO sales.nope VALUES (1)',
  'SELECT x FROM lake.plain',
];

describe('warnings for names that the lake does not have', () => {
  it('marks the name and offers the nearest known ones, and the first fix of each leaves no warning', async () => {
    const actual: Record<string, (readonly string[])[]> = {};
    for (const source of Object.keys(WARNED)) {
      const { text, marks } = unmarked(source);
      const found = await warnings(text, sales.catalog);
      expect(
        found.map(([offset, length]) => ({ offset, length })),
        source,
      ).toEqual(marks);
      actual[source] = found.map(([, , names]) => names);
    }
    expect(actual).toEqual(WARNED);

    for (const source of Object.keys(WARNED).filter((key) =>
      WARNED[key]?.every((names) => names.length > 0),
    )) {
      const { text } = unmarked(source);
      const repaired = fixed(text, await problemsOf(text, sales.catalog));
      expect(await problemsOf(repaired, sales.catalog), repaired).toEqual([]);
    }
  });

  it('gives no warning where the name may exist after all', async () => {
    const actual: Record<string, unknown[]> = {};
    for (const text of NONE) actual[text] = [...(await problemsOf(text, sales.catalog))];
    expect(actual).toEqual(Object.fromEntries(NONE.map((text) => [text, []])));
  });

  it('checks every table against the snapshot of its AT (VERSION => n)', async () => {
    const at = async (source: string): Promise<Range[]> =>
      (await warnings(unmarked(source).text, history.catalog)).map(([offset, length]) => ({
        offset,
        length,
      }));
    for (const source of [
      'SELECT title FROM main.evolved, main.«evolving»',
      'SELECT «title» FROM main.evolving AT (VERSION => 28)',
      'SELECT name FROM main.evolving AT (VERSION => 28)',
      'SELECT x, «y» FROM shop.old_stuff AT (VERSION => 44)',
      'SELECT * FROM shop.«old_stuff»',
      // A column is certainly unknown only when every relation of the query is known.
      'SELECT x, y FROM shop.old_stuff AT (VERSION => 44), shop.«old_stuff»',
      'SELECT * FROM shop.events AT (VERSION => 10), shop.«events» AT (VERSION => 3)',
    ]) {
      expect(await at(source), source).toEqual(unmarked(source).marks);
    }
  });

  it('gives only the syntax error of a text that does not parse, and nothing without a catalog that was read', async () => {
    const broken = await problemsOf('SELECT amout FROM sales.ordrs WHER 1', sales.catalog);
    expect(broken.map(({ severity }) => severity)).toEqual(['error']);

    const unknown = 'SELECT amout FROM sales.ordrs';
    expect(await problemsOf(unknown, undefined)).toEqual([]);
    const failing: SqlCatalog = {
      ...sales.catalog,
      entries: () => Promise.reject(new Error('The catalog went away.')),
    };
    expect(await problemsOf(unknown, failing)).toEqual([]);
    // A catalog that is still being read: the check does not wait for it.
    const loading: SqlCatalog = { ...sales.catalog, schemas: () => new Promise(() => undefined) };
    expect(await problemsOf(unknown, loading)).toEqual([]);
  });

  it('checks the columns of a view only once they were read from a trusted connection', async () => {
    const columns: readonly RelationColumn[] = [{ name: 'id', type: 'INTEGER', nullable: false }];
    let trusted = false;
    let read: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => (read = resolve));
    const catalog = catalogOfReader(sales.reader, LATEST_SNAPSHOT, 'lake', {
      trusted: () => trusted,
      read: () => {
        read();
        return Promise.resolve(columns);
      },
      failed: () => undefined,
    });
    const text = unmarked('SELECT id, «nope» FROM sales.big_orders');
    expect(await warnings(text.text, catalog)).toEqual([]);
    trusted = true;
    // The first check starts the read and gives no warning; the next one knows the columns.
    expect(await warnings(text.text, catalog)).toEqual([]);
    await ready;
    expect((await warnings(text.text, catalog)).map(([offset, length]) => ({ offset, length }))).toEqual(
      text.marks,
    );
  });
});

describe('the nearest names', () => {
  it('offers at most three, the nearest first, and none when nothing is close', () => {
    const known = ['orders', 'order_items', 'Orders_2', 'customers', 'ordrs_archive', 'x'];
    expect(nearestNames('ordrs', known)).toEqual(['orders']);
    expect(nearestNames('ORDER', ['orders', 'order', 'border', 'ordre', 'oder'])).toEqual([
      'order',
      'border',
      'oder',
    ]);
    expect(nearestNames('custmoers', known)).toEqual(['customers']);
    expect(nearestNames('invoices', known)).toEqual([]);
    expect(nearestNames('y', known)).toEqual([]);
  });
});

/** Statements of DuckDB's own SQL that run on the lake with data: none may get a warning. */
const RUNNING: readonly string[] = [
  'SELECT o.id, o.customer.name, customer.tags[1], o.attrs, "Amount", created FROM sales.orders o ORDER BY created',
  'SELECT id, amount * 2 AS twice FROM sales.orders QUALIFY row_number() OVER (PARTITION BY id ORDER BY twice) = 1',
  'WITH t AS (SELECT id, amount FROM sales.orders) SELECT t.id, sum(amount) FROM t GROUP BY ALL HAVING sum(amount) > 0',
  "SELECT * EXCLUDE (attrs) REPLACE (amount * 2 AS amount), COLUMNS('a.*') FROM sales.orders ORDER BY ALL",
  'FROM sales.orders SELECT id, amount',
  "SELECT x, y, z FROM plain UNION ALL SELECT id, 'a', amount FROM sales.orders",
  'SELECT o.id, p.amount FROM sales.orders o ASOF JOIN sales.orders p ON o.id >= p.id',
  'SELECT * FROM sales.orders POSITIONAL JOIN plain',
  'SELECT list_filter([1, 2], lambda v: v > 1) AS f, unnest([1, 2]) AS u, current_date, rowid, filename FROM sales.orders',
  "SELECT v.n, s FROM (VALUES (1, 'a'), (2, 'b')) v(n, s) WHERE v.n > 1",
  'SELECT r.i FROM range(3) r(i)',
  'SELECT id FROM sales.orders WHERE id IN (SELECT x FROM plain) OR EXISTS (SELECT 1 FROM plain WHERE plain.x = id)',
  'SELECT * FROM sales.orders PIVOT (sum(amount) FOR id IN (1, 3))',
  'SELECT orders, o FROM sales.orders, sales.orders o',
  'SELECT * FROM sales.orders AT (VERSION => 5), sales.tmp AT (VERSION => 10)',
  'SELECT count(*) FROM duckdb_tables, lake.sales.orders, lake.main.plain, lake.plain',
  'SUMMARIZE sales.orders',
  'WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r WHERE n < 3) SELECT n FROM r',
  'SELECT o.id FROM sales.orders o, LATERAL (SELECT o.amount AS a) l WHERE l.a > 0',
  'SELECT struct_pack(a := 1, b := id) AS s FROM sales.orders',
  'SELECT id, sum(amount) OVER w FROM sales.orders WINDOW w AS (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)',
  'SELECT DISTINCT ON (id) id, created FROM sales.orders ORDER BY id, created DESC',
  'SELECT 1 AS a, a + 1 AS b',
  'SELECT x FROM main.plain p WHERE p.y IS NULL',
  'TABLE sales.orders',
  'SELECT * FROM sales.orders o JOIN sales.orders p USING (id)',
  'SELECT id FROM sales.orders o WHERE o.amount = (SELECT max(amount) FROM sales.orders i WHERE i.id = o.id)',
];

describe.skipIf(skipReason !== undefined)('the statements on a lake with data', () => {
  it('fail when they are warned about, run once the first fix of each warning is in, and run unwarned otherwise', async () => {
    const fixture = await copyDataFixture('sqlite');
    const session = await openFixtureSession(fixture, 'read-only');
    const errors = async (text: string): Promise<unknown[]> => only(await events(session, text), 'error');
    try {
      for (const source of Object.keys(WARNED).filter((key) => !key.includes(';'))) {
        const { text } = unmarked(source);
        expect(await errors(text), text).toHaveLength(1);
        if (WARNED[source]?.some((names) => names.length === 0)) continue;
        const repaired = fixed(text, await problemsOf(text, sales.catalog));
        expect(await errors(repaired), repaired).toEqual([]);
      }
      for (const text of RUNNING) {
        expect(await errors(text), text).toEqual([]);
        expect(await problemsOf(text, sales.catalog), text).toEqual([]);
      }
    } finally {
      await session.close();
      await fixture.remove();
    }
  });
});
