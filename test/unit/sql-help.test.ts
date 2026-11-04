import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLanguageService } from '../../src/sql/language';
import type { Hover } from '../../src/sql/help';
import { marked, openHistory, openSales } from './sql-language-support';
import type { OpenCatalog } from './sql-language-support';

const service = openLanguageService();
let sales: OpenCatalog;
let history: OpenCatalog;
beforeAll(async () => {
  sales = await openSales();
  history = await openHistory();
});
afterAll(async () => {
  await service.dispose();
  await sales.close();
  await history.close();
});

/** The hover at the mark; `|` stands on the character that the mouse points at. */
async function hover(text: string, catalog = sales.catalog): Promise<Hover | undefined> {
  const cursor = marked(text);
  return service.hover(cursor.text, cursor.offset, catalog);
}

async function signature(text: string, catalog = sales.catalog) {
  const cursor = marked(text);
  return service.signature(cursor.text, cursor.offset, catalog);
}

describe('hover', () => {
  it.each([
    ['a column', 'select am|ount from sales.orders', '`sales.orders.amount`'],
    ['a column through its alias', 'select o.i|d from sales.orders o', '`sales.orders.id`'],
    ['a field of a struct', 'select o.customer.na|me from sales.orders o', '`sales.orders.customer.name`'],
    ['a table in FROM', 'select * from sales.ord|ers', '`sales.orders`'],
    ['an alias, like its table', 'select |o.amount from sales.orders o', '`sales.orders`'],
    ['a view', 'select * from sales.big|_orders', 'SELECT * FROM sales.orders WHERE (amount > 1)'],
    ['a schema', 'select * from sa|les.orders', '`sales` (schema)'],
    ['a table of the default schema', 'select * from pla|in', '`main.plain`'],
    [
      'a scalar function',
      'select substr|ing(a, 1) from sales.orders',
      'substring(string VARCHAR, start BIGINT)',
    ],
    ['an aggregate function', 'select s|um(amount) from sales.orders', 'aggregate function'],
    [
      'a function of the lake behind its name',
      'select * from lake.snap|shots()',
      'table function of the lake',
    ],
    ['the first character of a word', 'select o.|amount from sales.orders o', '`sales.orders.amount`'],
    [
      'the last character of a word after a bracket',
      'select count(amoun|t) from sales.orders',
      '`sales.orders.amount`',
    ],
    [
      'a column of a CTE by the column it reads',
      'with c as (select amount as total from sales.orders) select tot|al from c',
      '`sales.orders.amount`',
    ],
    [
      'a column of a subquery through its alias',
      'select s.tot|al from (select amount * 2 as total from sales.orders) s',
      '`total`',
    ],
    [
      'a field through a CTE',
      'with c as (select customer from sales.orders) select c.customer.na|me from c',
      '`sales.orders.customer.name`',
    ],
    ['the alias of a subquery with its columns', 'select |s.a from (select 1 as a, 2 as b) s', '`b`'],
    ['a column of VALUES after its alias list', 'select |x from (values (1)) v(x)', '`x`'],
    [
      'a quoted name after non-ASCII text',
      'select \'ü😀\' as "x", o."amo|unt" from sales.orders o',
      '`sales.orders.amount`',
    ],
  ])('picks the entry of %s', async (_, text, expected) => {
    expect((await hover(text))?.markdown, text).toContain(expected);
  });

  it('gives the range of the word it describes, in UTF-16 units', async () => {
    expect((await hover('select o.i|d from sales.orders o'))?.range).toEqual({ offset: 9, length: 2 });
    const quoted = 'select \'ü😀\' as "x", o."amount" from sales.orders o';
    expect((await hover(quoted.replace('amount', 'amo|unt')))?.range).toEqual({
      offset: quoted.indexOf('"amount"'),
      length: 8,
    });
  });

  it('lists the data of a column and a table that the tree shows: type, nullability, default, comment, rows, files', async () => {
    const column = (await hover('select am|ount from sales.orders'))?.markdown ?? '';
    expect(column).toContain('decimal(10,2)');
    expect(column).toContain('Net amount in EUR');
    expect(column).toMatch(/Default: `0`/);
    expect((await hover('select o.i|d from sales.orders o'))?.markdown).toMatch(/Nullable: no/);
    const table = (await hover('select * from sales.ord|ers'))?.markdown ?? '';
    expect(table).toContain('Customer orders');
    expect(table).toMatch(/\b2\b/);
    expect(table).toMatch(/Data files: 1/);
  });

  it('cuts the list of signatures of a function that has many overloads to six', async () => {
    const { functions } = await service.vocabulary();
    const [many] = [...functions.values()].sort((a, b) => b.overloads.length - a.overloads.length);
    expect(many?.overloads.length).toBeGreaterThan(6);
    const found = await hover(`select ${many?.name.slice(0, 2)}|${many?.name.slice(2)}(1)`);
    expect(found?.markdown).toContain(`${(many?.overloads.length ?? 0) - 6} more`);
    expect(found?.markdown.split('\n').filter((line) => line.startsWith(`${many?.name}(`))).toHaveLength(6);
  });

  it('adds the partition keys and the sort keys of the snapshot to a table', async () => {
    const events = (await hover('select * from shop.ev|ents', history.catalog))?.markdown ?? '';
    expect(events).toContain('`kind`, `ts` (`month`)');
    expect(
      (await hover('select * from shop.ev|ents at (version => 5)', history.catalog))?.markdown,
    ).toContain('`ts` (`year`)');
    const readings = (await hover('select * from shop.read|ings', history.catalog))?.markdown ?? '';
    expect(readings).toContain('`"value"` `DESC` `NULLS FIRST`');
    expect(readings).not.toContain('`kind`');
    const log = (await hover('select * from shop.l|og', history.catalog))?.markdown ?? '';
    expect(log).toContain('`shop.log`');
    expect(log).not.toMatch(/`kind`|NULLS (FIRST|LAST)/);
  });

  it('shows a transform, a direction and a null order of the catalog as code, never as Markdown', async () => {
    const image = '![](https://attacker.example/i.png)';
    const link = 'DESC\n\n[open](https://attacker.example/x)';
    const catalog = {
      ...history.catalog,
      layout: () =>
        Promise.resolve({
          partitioning: {
            id: 1,
            beginSnapshot: 1,
            endSnapshot: null,
            columns: [{ columnId: 1, path: ['ts'], transform: image }],
          },
          sortOrder: {
            id: 1,
            beginSnapshot: 1,
            endSnapshot: null,
            expressions: [{ expression: 'ts', dialect: 'duckdb', direction: link, nullOrder: image }],
          },
        }),
    };
    const found = (await hover('select * from shop.ev|ents', catalog))?.markdown ?? '';
    expect(found).toContain(`\`ts\` (\`${image}\`)`);
    expect(found).toContain('`DESC [open](https://attacker.example/x)`');
    expect(found).not.toMatch(/^!\[|\n\n\[open\]/m);
  });

  it('describes a global function of DuckLake with its overloads', async () => {
    const found = (await hover("call ducklake_merge_adj|acent_files('lake')"))?.markdown ?? '';
    expect(found).toContain('ducklake_merge_adjacent_files(catalog VARCHAR, min_file_size => BIGINT');
    expect(found).toContain('ducklake_merge_adjacent_files(catalog VARCHAR, table_name VARCHAR,');
  });

  it('describes a macro of the lake with its definition', async () => {
    const macro = await hover('select shop.gro|ss(1)', history.catalog);
    expect(macro?.markdown).toContain('`shop.gross`');
    expect(macro?.markdown).toContain('(net * rate)');
  });

  it('says nothing about keywords, operators, strings, comments, unknown and ambiguous names, or the end of a word', async () => {
    for (const text of [
      'sel|ect 1',
      'select * from sales.orders wh|ere true',
      "select 'am|ount' from sales.orders",
      'select 1 -- am|ount',
      'select * from nowh|ere',
      'select nowh|ere from sales.orders',
      'select 1 |+ 2',
      'select o.amount| from sales.orders o',
      'select i|d from sales.orders o join sales.orders p on true',
      'select amo|unt from sales.big_orders',
      'select * from snap|shots()',
      // A lambda parameter, not the column of the same name.
      'select list_transform(l, lambda amount: amo|unt) from sales.orders',
      // An expression without alias and a table function name no column.
      'select s.amo|unt from (select amount * 2 from sales.orders) s',
      'select r.ran|ge from range(3) r',
      'select i|d from (select id from sales.orders) s join sales.orders o on true',
    ]) {
      expect(await hover(text), text).toBeUndefined();
    }
  });
});

describe('signature help', () => {
  it('counts the commas of the innermost call and picks the overload that has the parameter', async () => {
    const rows: [string, { activeSignature?: number; activeParameter?: number }][] = [
      ["select substring('abc', |", { activeSignature: 0, activeParameter: 1 }],
      ["select substring('abc', 1, |", { activeSignature: 1, activeParameter: 2 }],
      ['select lower(substring(x, 1, |', { activeParameter: 2 }],
      ['select substring(lower(x), |', { activeParameter: 1 }],
      ["select substring('a,b,c', ([1, 2], 3), |", { activeParameter: 2 }],
      ["select * from read_csv('x', no_such_argument := |", { activeSignature: 0, activeParameter: 0 }],
      ["select lower('a', 'b', 'c', |", { activeSignature: 0 }],
      // The comma between the parameters of a lambda separates no arguments.
      ['select list_reduce([1, 2], lambda acc, x: acc + x, |', { activeParameter: 2 }],
    ];
    for (const [text, expected] of rows) {
      const found = await signature(text);
      expect(found, text).toBeDefined();
      expect(found, text).toMatchObject(expected);
    }
  });

  it('follows a named argument, in any case, to its parameter', async () => {
    for (const text of [
      "select * from read_csv('x', header := |",
      "select * from read_csv('x', HEADER := |",
    ]) {
      const found = await signature(text);
      expect(found?.signatures[found.activeSignature]?.parameters[found.activeParameter], text).toBe(
        'header => BOOLEAN',
      );
    }
  });

  it('shows the overloads of a function with their parameters, and a vararg function', async () => {
    const first = await signature("select substring('abc', |");
    expect(first?.signatures.map(({ label }) => label)).toEqual([
      'substring(string VARCHAR, start BIGINT) -> VARCHAR',
      'substring(string VARCHAR, start BIGINT, length BIGINT) -> VARCHAR',
    ]);
    expect(first?.signatures[0]?.parameters).toEqual(['string VARCHAR', 'start BIGINT']);
    expect((await signature("select concat('a', 'b', |"))?.signatures[0]?.label).toBe(
      'concat(value ANY, ANY...) -> ANY',
    );
  });

  it('offers the parameters of a function of the lake behind its name only, and of a macro with its defaults', async () => {
    const lake = await signature("select * from lake.table_changes('orders', |");
    expect(lake?.signatures[0]?.label).toMatch(/^table_changes\(table_name VARCHAR, start_snapshot /);
    expect(lake?.activeParameter).toBe(1);
    expect(await signature("select * from table_changes('orders', |")).toBeUndefined();
    const macro = await signature('select shop.gross(1, |', history.catalog);
    expect(macro?.signatures.map(({ label }) => label)).toEqual(['gross(net ANY, rate ANY := 1.19)']);
    expect(macro?.activeParameter).toBe(1);
    expect(
      (await signature('select * from shop.recent_events(|', history.catalog))?.signatures[0]?.label,
    ).toBe('recent_events(n ANY)');
  });

  it('marks the named parameters of a function of DuckLake and passes no positional argument to them', async () => {
    const named = await signature("call ducklake_cleanup_old_files('lake', dry_run => |");
    expect(named?.signatures[0]?.parameters[named.activeParameter]).toBe('dry_run => BOOLEAN');
    // The second positional argument fits only the overload with a table.
    const merge = await signature("call ducklake_merge_adjacent_files('lake', |");
    expect(merge?.signatures[merge.activeSignature]?.parameters[merge.activeParameter]).toBe(
      'table_name VARCHAR',
    );
    const changes = await signature("select * from ducklake_table_changes('lake', 'main', |");
    expect(changes?.activeParameter).toBe(2);
  });

  it('says nothing outside a call, for an unknown function, and after the call ended', async () => {
    for (const text of [
      'select |',
      'select nowhere(1, |',
      'select lower(a)|',
      'select (1, |',
      "select 'ü😀'|",
    ]) {
      expect(await signature(text), text).toBeUndefined();
    }
  });
});
