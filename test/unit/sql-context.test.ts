import { afterAll, describe, expect, it } from 'vitest';
import { openLanguageService } from '../../src/sql/language';
import { callAt } from '../../src/sql/context';
import type { CursorContext, ScopeRelation } from '../../src/sql/context';
import { contextOf, marked } from './sql-language-support';

// The cursor analysis works on the tokens of DuckDB's own `sql_tokenize`: no extension and no lake is needed.
const service = openLanguageService();
afterAll(() => service.dispose());

/** The columns that the text gives a relation: `alias=path`, `?` for an expression, `t.*-dropped`, `…` for any number. */
function columnsOf({ columns }: ScopeRelation): string[] | undefined {
  return columns?.items.map((item) => {
    switch (item.kind) {
      case 'column':
        return `${item.alias ?? ''}=${item.path?.join('.') ?? ''}`;
      case 'star':
        return `${[...item.qualifier, '*'].join('.')}-${item.exclude.join(',')}`;
      case 'expression':
        return '?';
      case 'unknown':
        return '…';
    }
  });
}

/** The parts of a context that a row of the tables below states. */
function shape(context: CursorContext): Record<string, unknown> {
  const name = (relation: { schema: string; table: string }): string =>
    `${relation.schema}.${relation.table}`;
  return {
    position: context.position,
    clause: context.clause,
    statement: context.statement,
    qualifier: context.qualifier,
    partial: context.partial,
    scope: context.scope.map(({ alias, relation }) => `${alias ?? ''}=${relation ? name(relation) : '?'}`),
    columns: context.scope.map(columnsOf),
    renamed: context.scope.map(({ renamed, columns }) => renamed ?? columns?.renamed),
    target: context.target && name(context.target),
    ctes: context.ctes,
    locals: context.locals,
    copy: context.copy,
  };
}

type Expected = Partial<ReturnType<typeof shape>>;

/** `text` has the cursor mark `|`; `expected` states what the analysis must find there. */
async function expectContext(text: string, expected: Expected): Promise<void> {
  expect(shape(await contextOf(service, text)), text).toMatchObject(expected);
}

async function expectRows(rows: [string, Expected][]): Promise<void> {
  for (const [text, expected] of rows) await expectContext(text, expected);
}

describe('the cursor analysis', () => {
  it('names the clause and position at the cursor for every statement kind', async () => {
    await expectRows([
      ['|', { position: 'statement', statement: undefined }],
      ['sel|', { position: 'statement', partial: 'sel' }],
      ['select 1; select | from sales.orders', { position: 'expression', scope: ['=sales.orders'] }],
      ['select 1|;', { position: 'inert' }],
      ['select * from sales.orders; |', { position: 'statement', scope: [] }],
      ['select | from sales.orders o', { position: 'expression', clause: 'select', statement: 'SELECT' }],
      ['select * from |', { position: 'from', clause: 'from', scope: [] }],
      ['select * from sales.orders o |', { position: 'keyword', scope: ['o=sales.orders'] }],
      ['select * from sales.orders o left join |', { position: 'from', scope: ['o=sales.orders'] }],
      ['select * from sales.orders o join sales.tmp t on |', { position: 'expression', clause: 'on' }],
      ['select * from sales.orders where amount > 1 and |', { position: 'expression', clause: 'where' }],
      ['select * from sales.orders group by |', { position: 'expression', clause: 'group' }],
      ['select * from sales.orders order by |', { position: 'expression', clause: 'order' }],
      ['select a from sales.orders group by a having |', { position: 'expression', clause: 'having' }],
      ['select a from sales.orders qualify |', { position: 'expression', clause: 'qualify' }],
      [
        'insert into sales.orders values (1) returning |',
        { position: 'expression', clause: 'returning', statement: 'INSERT' },
      ],
      ['select * from sales.orders limit |', { position: 'value', clause: 'limit' }],
      ['select * from read_csv(|)', { position: 'value', clause: 'from' }],
      ['select cast(a as |) from t', { position: 'type' }],
      ['select a::| from t', { position: 'type' }],
      ['select extract(year from |) from t', { position: 'expression', clause: 'select' }],
      ['select | from t union select 1 from sales.orders', { position: 'expression', scope: ['=main.t'] }],
      ['explain select | from sales.orders', { position: 'expression', statement: 'SELECT' }],
      ['insert into |', { position: 'relation', clause: 'into' }],
      ['insert into sales.orders (id, |) values (1)', { position: 'target-column', target: 'sales.orders' }],
      ['insert into sales.orders values (|', { position: 'value', target: 'sales.orders' }],
      [
        'insert into t select | from sales.orders',
        { position: 'expression', scope: ['=sales.orders'], target: 'main.t' },
      ],
      ['update |', { position: 'relation', clause: 'update', statement: 'UPDATE' }],
      [
        'update sales.orders set |',
        { position: 'target-column', target: 'sales.orders', scope: ['=sales.orders'] },
      ],
      [
        'update sales.orders o set amount = 1 where o.|',
        { position: 'expression', scope: ['o=sales.orders'], qualifier: ['o'] },
      ],
      [
        'delete from sales.orders where |',
        { position: 'expression', scope: ['=sales.orders'], target: 'sales.orders' },
      ],
      ['create table x (a int, b |', { position: 'type' }],
      ['create table x (|', { position: 'name' }],
      ['create table if not exists sales.|', { position: 'new-relation', qualifier: ['sales'] }],
      [
        'create or replace table x as select | from sales.orders',
        { position: 'expression', scope: ['=sales.orders'], statement: 'CREATE' },
      ],
      ['create index i on sales.orders (|', { position: 'target-column', target: 'sales.orders' }],
      ['alter table sales.orders drop column |', { position: 'target-column', target: 'sales.orders' }],
      ['alter table sales.orders add column z |', { position: 'type' }],
      ['alter table sales.orders rename to |', { position: 'name' }],
      ['alter table sales.orders set sorted by (id, |', { position: 'target-column' }],
      ['drop table if exists sales.|', { position: 'relation', qualifier: ['sales'] }],
      ['drop schema |', { position: 'schema' }],
      ['use lake.|', { position: 'schema', qualifier: ['lake'] }],
      ['set threads = |', { position: 'value' }],
      ['set |', { position: 'setting' }],
      ['call lake.|', { position: 'call', qualifier: ['lake'] }],
      ["call ducklake_cleanup_old_files('lake', |", { position: 'value', statement: 'CALL' }],
      ['call lake.merge_adjacent_files(|', { position: 'value', statement: 'CALL' }],
      ['comment on column sales.orders.|', { position: 'column-path', qualifier: ['sales', 'orders'] }],
      ['select * from sales.orders at (|', { position: 'snapshot-clause', scope: ['=sales.orders'] }],
      ['select * from sales.orders at (version => |', { position: 'snapshot-version' }],
      ['select * from sales.orders at (timestamp => |', { position: 'snapshot-timestamp' }],
      [
        'select * from sales.orders at (version => 3) o where |',
        { position: 'expression', scope: ['o=sales.orders'] },
      ],
    ]);
  });

  it('collects the relations and common table expressions that the statement reads', async () => {
    await expectRows([
      [
        'select o.| from sales.orders o join sales.tmp t on o.id = t.a',
        { scope: ['o=sales.orders', 't=sales.tmp'], qualifier: ['o'] },
      ],
      ['select | from sales.orders as o', { scope: ['o=sales.orders'] }],
      ['select | from plain', { scope: ['=main.plain'] }],
      ['select | from lake.sales.orders o', { scope: ['o=sales.orders'] }],
      ['select | from other.sales.orders o', { scope: ['o=?'] }],
      ['select | from "Sales"."My Orders" "O"', { scope: ['O=Sales.My Orders'] }],
      [
        'select * from t1, t2 x, sales.orders as o where |',
        { scope: ['=main.t1', 'x=main.t2', 'o=sales.orders'] },
      ],
      ['select * from (select 1 as a) s where s.|', { scope: ['s=?'], qualifier: ['s'] }],
      ['select * from t where a in (select | from sales.orders)', { scope: ['=sales.orders', '=main.t'] }],
      [
        'select * from sales.orders o where exists (select 1 from sales.tmp x where x.| = o.id)',
        { scope: ['x=sales.tmp', 'o=sales.orders'] },
      ],
      ['with x as (select 1) select | from x', { scope: ['=?'], ctes: ['x'] }],
      ['with a as (select * from |), b as (select 1) select 1', { ctes: ['a'], position: 'from' }],
      ['with a as (select 1), "B b" as (select 2) select * from |', { ctes: ['a', 'b b'] }],
      ['with PLAIN as (select 1 as q) select | from plain', { scope: ['=?'], ctes: ['plain'] }],
      ['with plain as (select 1 as q) select | from PLAIN', { scope: ['=?'], ctes: ['plain'] }],
      // a relation after the cursor belongs to the same query, not to the next statement
      ['select | from sales.orders; select 1 from sales.tmp', { scope: ['=sales.orders'] }],
      // the word being typed is neither the alias nor the table
      ['select * from sales.orders o|', { scope: ['=sales.orders'], position: 'keyword', partial: 'o' }],
      ['select * from sales.or|ders where 1 = 1', { scope: [], qualifier: ['sales'], partial: 'or' }],
    ]);
  });

  it('reads the dotted prefix and the word being typed', async () => {
    await expectRows([
      ['select sales.|', { qualifier: ['sales'], partial: '' }],
      ['select * from lake.sales.or|', { qualifier: ['lake', 'sales'], partial: 'or' }],
      ['select * from "my schema"."or|', { qualifier: ['my schema'], partial: 'or' }],
      ['select * from "we""ird".|', { qualifier: ['we"ird'] }],
      ['select "we""i|', { partial: 'we"i' }],
      ['select * from sales .|', { qualifier: ['sales'] }],
      ['select (|', { qualifier: [], partial: '' }],
      ['select größ|e from t', { qualifier: [], partial: 'größ' }],
      ['select * from "名前"."テ|', { qualifier: ['名前'], partial: 'テ' }],
      ['select "a""|', { position: 'expression', partial: 'a"' }],
      ['select | from LAKE.sales.orders o', { position: 'expression', scope: ['o=sales.orders'] }],
    ]);
  });

  it('gives insert and replace ranges for unquoted, quoted and unterminated words', async () => {
    let context = await contextOf(service, 'select * from sales.or|ders where 1 = 1');
    expect(context.insert).toEqual({ offset: 20, length: 2 });
    expect(context.replace).toEqual({ offset: 20, length: 6 });
    expect(context.quoted).toBe(false);

    context = await contextOf(service, 'select * from sales."or|ders" where 1 = 1');
    expect(context.insert).toEqual({ offset: 20, length: 8 });
    expect(context.replace).toEqual({ offset: 20, length: 8 });
    expect(context).toMatchObject({ quoted: true, partial: 'or' });

    // an unterminated quote stops at the cursor: it would reach to the end of the text
    context = await contextOf(service, 'select * from sales."or|\nwhere x = 1');
    expect(context.insert).toEqual({ offset: 20, length: 3 });
    expect(context.replace).toEqual({ offset: 20, length: 3 });
  });

  it('counts UTF-16 units after emoji and reads CRLF line ends like white space', async () => {
    let text = "select 'ü😀' as x, o.|name from sales.orders o";
    let context = await contextOf(service, text);
    expect(context.qualifier).toEqual(['o']);
    expect(context.insert.offset).toBe(text.replace('|', '').indexOf('name'));
    expect(context.scope).toHaveLength(1);

    text = 'select a,\r\n  b\r\nfrom sales.orders o\r\nwhere o.|';
    context = await contextOf(service, text);
    expect(shape(context)).toMatchObject({
      position: 'expression',
      clause: 'where',
      qualifier: ['o'],
      scope: ['o=sales.orders'],
    });
    expect(context.insert.offset).toBe(text.length - 1);
  });

  it('offers no completion inside a string, a comment or a number, and skips comments in a clause', async () => {
    const rows: [string, string][] = [
      ["select 'a|b' from t", 'inert'],
      ["select 'unterminated|", 'inert'],
      ["select 'it''s |a' from t", 'inert'],
      ['select $$ x ; y |$$', 'inert'],
      ['select * from t -- a com|ment\nwhere', 'inert'],
      ['select /* unterminated|', 'inert'],
      ['select 12|3', 'inert'],
      ["select 'ab'| from t", 'expression'],
      // A string or number in the slot of a snapshot is where the snapshot is chosen.
      ["select * from t at (timestamp => '20|')", 'snapshot-timestamp'],
      ["select * from t at (timestamp => '|", 'snapshot-timestamp'],
      ['select * from t at (version => 1|)', 'snapshot-version'],
      ["select * from t at (version => '1|')", 'inert'],
      ["select * from t at (timestamp => '20')| x", 'keyword'],
      ['select * from t -- a comment\n|where', 'keyword'],
      ['select /* a */ | 1', 'expression'],
      ['select 1 -- a\r|\nfrom t', 'expression'],
    ];
    for (const [text, position] of rows) {
      expect((await contextOf(service, text)).position, text).toBe(position);
    }

    await expectContext("select 1 -- it's\n, | from sales.orders", {
      position: 'expression',
      scope: ['=sales.orders'],
    });
    await expectContext('select * from /* a table */ sales.orders -- here\n o where |', {
      scope: ['o=sales.orders'],
    });
  });

  it('reads the columns of a CTE, a subquery and VALUES from their text, and the column aliases of x(a, b)', async () => {
    await expectRows([
      [
        'with c as (select id, amount as total, amount * 2 twice, amount * 3, inc: amount + 1 from t) select | from c',
        { scope: ['=?'], columns: [['=id', 'total=amount', 'twice=', '?', 'inc=']] },
      ],
      [
        'select | from (select distinct on (id) o.*, * exclude (id) rename (a as b), 1, from t o) s',
        { scope: ['s=?'], columns: [['o.*-', '*-id', '?']] },
      ],
      ["select | from (select columns(*), unnest(l), * like 'a%' from t) s", { columns: [['…', '…', '…']] }],
      ['select | from (select x from t union select y as z from u) s', { columns: [['=x']] }],
      ['select | from (from t select x) s, (from t) u, (table t) v', { columns: [['=x'], ['*-'], ['*-']] }],
      [
        'select | from (values (1, 2), (3, 4)) v(a, b)',
        { scope: ['v=?'], columns: [['col0=', 'col1=']], renamed: [['a', 'b']] },
      ],
      ['with c(a, b) as (select 1, 2) select | from c', { ctes: ['c'], renamed: [['a', 'b']] }],
      [
        'select | from range(3) r(i), sales.orders o(x)',
        { columns: [undefined, undefined], renamed: [['i'], ['x']] },
      ],
      ['select * from sales.orders o(|', { position: 'name' }],
      ['with c(|', { position: 'name' }],
      // The result of PIVOT has other columns.
      ['select | from (select 1 as a) pivot (sum(a) for a in (1)) p', { columns: [undefined] }],
      // A subquery in WHERE is no relation of the query.
      ['select | from t where a in (select b from u)', { columns: [undefined] }],
    ]);
  });

  it('handles statement edges: leading WITH, DML keywords and snapshot arguments', async () => {
    await expectRows([
      ['select /*/|', { position: 'inert' }],
      ['select |; select * from sales.orders o', { position: 'expression', scope: [] }],
      [
        'with a as (select | from sales.orders) select * from sales.tmp',
        { scope: ['=sales.orders'], ctes: ['a'] },
      ],
      ['select * from (table sales.orders) t where |', { position: 'expression', scope: ['t=?'] }],
      ['with a as (select 1) values (|)', { position: 'value', clause: 'values', ctes: ['a'] }],
      [
        'with a as (select 1) insert into sales.orders (|',
        { position: 'target-column', statement: 'INSERT', target: 'sales.orders' },
      ],
      [
        'with a as (select 1) delete from sales.orders where |',
        { position: 'expression', statement: 'DELETE', scope: ['=sales.orders'] },
      ],
      ['delete from sales.orders using |', { position: 'relation', statement: 'DELETE' }],
      ['summarize |', { position: 'relation', statement: 'SUMMARIZE' }],
      ['set variable |', { position: 'setting', statement: 'SET' }],
      ['insert into sales.orders values (1) on conflict |', { position: 'keyword', statement: 'INSERT' }],
      ['select * from sales.orders at (version => 1, |', { position: 'snapshot-clause' }],
    ]);

    const context = await contextOf(service, 'select "ab|c" from t');
    expect(context.insert).toEqual({ offset: 7, length: 5 });
    expect(context).toMatchObject({ quoted: true, partial: 'ab' });
  });

  it('reads PIVOT and UNPIVOT in both forms: the relation, its columns in ON, USING and GROUP BY, values in IN', async () => {
    const orders = ['=sales.orders'];
    await expectRows([
      ['pivot |', { position: 'from', statement: 'PIVOT' }],
      ['pivot sales.orders |', { position: 'keyword', clause: 'pivot', scope: orders }],
      ['pivot sales.orders on |', { position: 'expression', scope: orders }],
      ['pivot sales.orders on customer in (|', { position: 'value' }],
      ['pivot sales.orders on customer using sum(|)', { position: 'expression', scope: orders }],
      ['pivot sales.orders using sum(amount) group by |', { position: 'expression', scope: orders }],
      ['select * from (pivot sales.orders on |)', { position: 'expression', scope: orders }],
      ['with p as (pivot sales.orders on id using sum(|)) from p', { scope: orders, ctes: ['p'] }],
      ['unpivot sales.orders on |', { position: 'expression', statement: 'UNPIVOT', scope: orders }],
      ['unpivot sales.orders on amount into |', { position: 'keyword', clause: 'unpivot-into' }],
      ['unpivot sales.orders on amount into name k value |', { position: 'name' }],
      ['select * from sales.orders pivot (sum(|) for id in (1))', { position: 'expression', scope: orders }],
      ['select * from sales.orders pivot (sum(amount) for id in (|))', { position: 'value' }],
      ['select * from sales.orders unpivot (|', { position: 'name' }],
      ['select * from sales.orders unpivot (v for k in (|))', { position: 'column', scope: orders }],
      // The result of a pivot has other columns than its table.
      ['select | from sales.orders pivot (sum(amount) for id in (1)) p', { scope: ['p=?'] }],
    ]);
  });

  it('knows a lambda parameter inside the body of its lambda only', async () => {
    await expectRows([
      [
        'select list_transform(l, lambda x: |) from sales.orders',
        { position: 'expression', locals: ['x'], scope: ['=sales.orders'] },
      ],
      ['select list_reduce(l, lambda acc, x: acc + |)', { locals: ['acc', 'x'] }],
      ['select f(l, lambda x: list_filter(x, lambda y: y > |))', { locals: ['y', 'x'] }],
      ['select columns(lambda c: c like |) from sales.orders', { locals: ['c'] }],
      // `->` is the JSON operator; DuckDB refuses it as a lambda by default.
      ['select payload -> |', { locals: [] }],
      ['select list_transform(l, lambda |', { position: 'name' }],
      ['select list_reduce(l, lambda acc, |', { position: 'name' }],
      ['select f(l, lambda x: [x, 1], |)', { locals: [] }],
      ['select list_transform(l, lambda x: x), |', { locals: [] }],
    ]);
  });

  it('offers the columns of the relations in COLUMNS(...) and in the lists of * EXCLUDE, REPLACE and RENAME', async () => {
    const orders = ['=sales.orders'];
    await expectRows([
      ['select columns(|) from sales.orders', { position: 'expression', scope: orders }],
      ['select * exclude (|) from sales.orders', { position: 'column', scope: orders }],
      ['select * exclude (id, |) from sales.orders', { position: 'column' }],
      ['select * exclude | from sales.orders', { position: 'column', scope: orders }],
      ['select o.* exclude (|) from sales.orders o', { position: 'column', scope: ['o=sales.orders'] }],
      ['select columns(* exclude (|)) from sales.orders', { position: 'column', scope: orders }],
      ['select * replace (|) from sales.orders', { position: 'expression', scope: orders }],
      ['select * exclude (id) replace (amount * 2 as |) from sales.orders', { position: 'column' }],
      ['select * rename (|) from sales.orders', { position: 'column' }],
      ['select * rename (amount as |) from sales.orders', { position: 'name' }],
      ['select replace(|) from sales.orders', { position: 'expression' }],
    ]);
  });

  it('follows a window specification through PARTITION BY, ORDER BY and the frame', async () => {
    const over = 'select sum(amount) over (order by id';
    await expectRows([
      ['select sum(amount) over (|) from sales.orders', { position: 'keyword', clause: 'over' }],
      [
        'select sum(amount) over (partition by |) from sales.orders',
        { position: 'expression', scope: ['=sales.orders'] },
      ],
      [`${over} rows |`, { position: 'keyword', clause: 'frame' }],
      [`${over} range between |`, { clause: 'frame-start' }],
      [`${over} groups between unbounded |`, { clause: 'frame-direction' }],
      [`${over} rows between 3 |`, { clause: 'frame-direction' }],
      [`${over} rows between current |`, { clause: 'frame-current' }],
      [`${over} rows between 1 preceding |`, { clause: 'frame-and' }],
      [`${over} rows between 1 preceding and |`, { clause: 'frame-end' }],
      [`${over} rows between 1 preceding and current row |`, { clause: 'frame-exclude' }],
      [`${over} rows unbounded preceding |`, { clause: 'frame-exclude' }],
      [`${over} rows unbounded preceding exclude |`, { clause: 'exclude' }],
      ['select sum(amount) over w from sales.orders window w as (|)', { clause: 'over' }],
      [
        'select sum(amount) over w from sales.orders window w as (order by |)',
        { position: 'expression', scope: ['=sales.orders'] },
      ],
    ]);
  });

  it('reads FROM-first queries, SUMMARIZE, DESCRIBE and EXPLAIN of a query, and the options of COPY ... TO', async () => {
    const orders = ['=sales.orders'];
    await expectRows([
      ['from sales.orders |', { position: 'keyword', statement: 'FROM', scope: orders }],
      ['from sales.orders select |', { position: 'expression', scope: orders }],
      ['from sales.orders o where o.|', { qualifier: ['o'], scope: ['o=sales.orders'] }],
      [
        'summarize select | from sales.orders',
        { position: 'expression', statement: 'SUMMARIZE', scope: orders },
      ],
      ['describe from |', { position: 'from', statement: 'DESCRIBE' }],
      ['explain analyze |', { position: 'statement' }],
      ['copy sales.orders |', { position: 'keyword', clause: 'copy', target: 'sales.orders' }],
      ['copy sales.orders to |', { position: 'name' }],
      [
        "copy sales.orders to 'x.parquet' (|",
        { position: 'copy-option', copy: { format: 'parquet', given: [] } },
      ],
      ["copy sales.orders to 'x' (format json, |", { copy: { format: 'json', given: ['format'] } }],
      ["copy sales.orders to 'x.csv' (header, |, format 'parquet')", { copy: { format: 'parquet' } }],
      ["copy sales.orders to 'x.csv.gz' (|", { copy: { format: 'csv' } }],
      ["copy sales.orders to 'x' (format |", { position: 'copy-format' }],
      ["copy sales.orders to 'x' (header |", { position: 'name' }],
      ["copy sales.orders to 'x' (partition_by (|", { position: 'target-column', target: 'sales.orders' }],
      ["copy (select | from sales.orders) to 'x'", { position: 'expression', scope: orders }],
    ]);
  });

  it('finds the call that the cursor is in and its active parameter', async () => {
    const rows: [string, Record<string, unknown> | undefined][] = [
      ["select substring('abc', |", { name: 'substring', qualifier: [], activeParameter: 1 }],
      ['select lower(substring(x, 1, |', { name: 'substring', activeParameter: 2 }],
      ['select lower(substring(x, 1), |', { name: 'lower', activeParameter: 1 }],
      ['select f(a, (b, |', { name: 'f', activeParameter: 1 }],
      ['select f([1, 2], |', { name: 'f', activeParameter: 1 }],
      ["select f({'a': 1, 'b': |", { name: 'f', activeParameter: 0 }],
      ["select f('a, b|", { name: 'f', activeParameter: 0 }],
      ['select f(a /* , */, |', { name: 'f', activeParameter: 1 }],
      ['select * from lake.sales.f(1, |', { name: 'f', qualifier: ['lake', 'sales'], activeParameter: 1 }],
      ["select read_csv('x', header := |", { name: 'read_csv', activeParameter: 1, argumentName: 'header' }],
      [
        "call ducklake_cleanup_old_files('lake', dry_run => true, older_than => now(), |",
        { named: ['dry_run', 'older_than'], argumentStart: true },
      ],
      ["call f('lake', dry|", { named: [], argumentStart: true }],
      ["select * from read_csv('x', header = true, |", { named: ['header'], argumentStart: true }],
      ["call f('lake', dry_run => |", { argumentName: 'dry_run', argumentStart: false }],
      ['call f(g(x => 1), |', { name: 'f', named: [], argumentStart: true }],
      ['select "My Fn"(1, |', { name: 'My Fn', activeParameter: 1 }],
      ['select 1; select f(a, |', { name: 'f', activeParameter: 1 }],
      ["select 'ü😀', f(a, |", { name: 'f', activeParameter: 1 }],
      ['select f(1); select |', undefined],
      ['select f(1)|', undefined],
      ['select (1, |', undefined],
      ['select a in (1, |', undefined],
    ];
    for (const [text, expected] of rows) {
      const cursor = marked(text);
      const call = callAt(await service.tokenize(cursor.text), cursor.offset);
      if (expected === undefined) expect(call, text).toBeUndefined();
      else expect(call, text).toMatchObject(expected);
    }
  });
});
