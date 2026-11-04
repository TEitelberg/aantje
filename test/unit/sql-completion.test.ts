import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openLanguageService } from '../../src/sql/language';
import type { Completions, CompletionItem } from '../../src/sql/completion';
import { EMPTY_CATALOG } from '../../src/sql/catalog';
import type { SqlCatalog } from '../../src/sql/catalog';
import { GLOBAL_LAKE_FUNCTIONS } from '../../src/sql/ducklake';
import { marked, openHistory, openSales } from './sql-language-support';
import type { OpenCatalog } from './sql-language-support';

const MAX_SNAPSHOT_ITEMS = 200;

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

async function complete(text: string, catalog: SqlCatalog = sales.catalog): Promise<Completions> {
  const cursor = marked(text);
  const result = await service.complete(cursor.text, cursor.offset, catalog);
  if (!result) throw new Error(`No completion in ${JSON.stringify(text)}`);
  return result;
}

const labels = (result: Completions): string[] => result.items.map(({ label }) => label);
const ofKind = (result: Completions, kind: CompletionItem['kind']): CompletionItem[] =>
  result.items.filter((item) => item.kind === kind);
/** The kinds in the order of the list, each kind once: the groups of the list. */
const groups = (result: Completions): string[] =>
  result.items.map(({ kind }) => kind).filter((kind, index, kinds) => kinds[index - 1] !== kind);

const ORDER_COLUMNS = ['id', 'customer', 'attrs', 'amount', 'created'];

describe('columns of sales.orders', () => {
  it('lists the columns in table order with type and nullability, before tables, functions and keywords, in a stable sort', async () => {
    const result = await complete('select | from sales.orders o');
    expect(
      ofKind(result, 'column').map(({ label, insertText, detail }) => [label, insertText, detail]),
    ).toEqual([
      ['id', 'id', 'int32 NOT NULL'],
      ['customer', 'customer', 'struct(name varchar, tags varchar[])'],
      ['attrs', 'attrs', 'map(varchar, int32)'],
      ['amount', 'amount', 'decimal(10,2)'],
      ['created', 'created', 'timestamp'],
    ]);
    expect(labels(result).slice(0, 6)).toEqual([...ORDER_COLUMNS, 'o']);
    expect(result.items[5]).toMatchObject({ kind: 'table', detail: 'sales.orders' });
    expect(groups(result)).toEqual(['column', 'table', 'function', 'keyword']);
    const sortTexts = result.items.map(({ sortText }) => sortText);
    expect(sortTexts).toEqual([...sortTexts].sort());
    expect(new Set(sortTexts).size).toBe(result.items.length);
    const amount = result.items.find(({ label }) => label === 'amount');
    expect(amount?.documentation).toContain('Net amount in EUR');
    expect(amount?.documentation).toContain('`decimal(10,2)`');
    expect(amount?.documentation).toContain('`0`');

    const where = await complete('select * from sales.orders where |');
    expect(groups(where)).toEqual(['column', 'table', 'function', 'keyword']);
    expect(labels(where).slice(0, 5)).toEqual(ORDER_COLUMNS);
    expect(ofKind(where, 'keyword').map(({ label }) => label)).toContain('AND');
  });

  it('offers the columns after a qualifier: alias, table name, three-part name and the fields of a struct', async () => {
    expect(labels(await complete('select o.| from sales.orders o join sales.tmp t on true'))).toEqual(
      ORDER_COLUMNS,
    );
    for (const text of [
      'select orders.| from sales.orders',
      'select sales.orders.| from sales.orders',
      'select lake.sales.orders.| from sales.orders',
      'select o.| from SALES.ORDERS o',
    ]) {
      expect(labels(await complete(text)), text).toEqual(ORDER_COLUMNS);
    }
    expect(
      (await complete('select o.customer.| from sales.orders o')).items.map(({ label, detail }) => [
        label,
        detail,
      ]),
    ).toEqual([
      ['name', 'varchar'],
      ['tags', 'varchar[]'],
    ]);

    const early = await openSales(10);
    try {
      const text = 'select t.| from sales.orders o join sales.tmp t on true';
      expect(labels(await complete(text, early.catalog))).toEqual(['a']);
      // sales.tmp was dropped at snapshot 11.
      expect(labels(await complete(text))).toEqual([]);
    } finally {
      await early.close();
    }
    const older = await openSales(12);
    try {
      expect(labels(await complete('select p.| from main.plain p', older.catalog))).toEqual(['x', 'y']);
    } finally {
      await older.close();
    }
    expect(labels(await complete('select p.| from main.plain p'))).toEqual(['x', 'y', 'z']);
  });

  it('qualifies a column that two tables have, and offers nothing for a subquery, a CTE or an unknown table', async () => {
    const result = await complete('select | from sales.orders o join sales.orders p on true');
    expect(ofKind(result, 'column').map(({ label, insertText }) => [label, insertText])).toEqual([
      ...ORDER_COLUMNS.map((name) => [`o.${name}`, `o.${name}`]),
      ...ORDER_COLUMNS.map((name) => [`p.${name}`, `p.${name}`]),
    ]);
    expect(ofKind(result, 'column')[0]?.filterText).toBe('id');

    for (const text of [
      'select s.| from (select 1) s',
      'with x as (select 1) select x.| from x',
      'select u.| from sales.nowhere u',
      'select o.| from other.sales.orders o',
    ]) {
      expect(labels(await complete(text)), text).toEqual([]);
    }
  });

  it('offers the columns of the target of a statement, and none inside VALUES, LIMIT or a table function', async () => {
    for (const text of [
      'insert into sales.orders (|',
      'insert into sales.orders (id, |',
      'update sales.orders set |',
    ]) {
      expect(labels(await complete(text)), text).toEqual(ORDER_COLUMNS);
    }
    expect(labels(await complete('alter table sales.orders drop column |')).slice(0, 5)).toEqual(
      ORDER_COLUMNS,
    );
    for (const text of ['update sales.orders set amount = |', 'delete from sales.orders where |']) {
      expect(labels(await complete(text)).slice(0, 5), text).toEqual(ORDER_COLUMNS);
    }
    for (const text of [
      'insert into sales.orders values (|',
      'select * from sales.orders limit |',
      'select * from read_csv(|)',
    ]) {
      expect(ofKind(await complete(text), 'column'), text).toEqual([]);
    }
    expect(labels(await complete('comment on column sales.orders.|'))).toEqual(ORDER_COLUMNS);

    const typing = await complete('select am| from sales.orders');
    expect(typing.insert).toEqual({ offset: 7, length: 2 });
    expect(typing.replace).toEqual({ offset: 7, length: 2 });
    expect(labels(typing)).toContain('amount');
  });
});

describe('columns that the SQL text gives: CTEs, subqueries, VALUES and column aliases', () => {
  const columns = async (text: string): Promise<string[]> => labels(await complete(text));

  it('offers the names and aliases of a select list, with the type of the column a name reads', async () => {
    const cte = await complete(
      'with c as (select id, amount as total, amount * 2 as twice, amount * 3 from sales.orders) select c.| from c',
    );
    expect(cte.items.map(({ label, detail }) => [label, detail])).toEqual([
      ['id', 'int32 NOT NULL'],
      ['total', 'decimal(10,2)'],
      ['twice', undefined],
    ]);
    expect(cte.items[1]?.documentation).toContain('Net amount in EUR');
    const rows: [string, string[]][] = [
      ['select s.| from (select o.id, o.customer, 1 one from sales.orders o) s', ['id', 'customer', 'one']],
      ['select s.| from (from sales.orders select id i) s', ['i']],
      ['select s.| from (select id from sales.orders union select 2) s', ['id']],
      ['with c as (select customer from sales.orders) select c.customer.| from c', ['name', 'tags']],
      // DuckDB names a repeated column id_1: only the first keeps its name.
      ['select s.| from (select o.id, p.id from sales.orders o, sales.orders p) s', ['id']],
    ];
    for (const [text, expected] of rows) expect(await columns(text), text).toEqual(expected);
    const unqualified = await complete(
      'with c as (select id, amount as total from sales.orders) select | from c',
    );
    expect(labels(unqualified).slice(0, 2)).toEqual(['id', 'total']);
    const shared = await complete('select | from (select 1 as id) s join sales.orders o on true');
    expect(
      ofKind(shared, 'column')
        .map(({ label }) => label)
        .slice(0, 3),
    ).toEqual(['s.id', 'o.id', 'customer']);
  });

  it('expands * and t.* of a known table, also through another CTE, without the columns EXCLUDE drops', async () => {
    const rows: [string, string[]][] = [
      ['select s.| from (select * from sales.orders) s', ORDER_COLUMNS],
      [
        'select s.| from (select o.* exclude (attrs) rename (id as k) from sales.orders o) s',
        ['k', 'customer', 'amount', 'created'],
      ],
      [
        'with a as (select id, amount as total from sales.orders), b as (select *, total * 2 as twice from a) select b.| from b',
        ['id', 'total', 'twice'],
      ],
      ['select s.| from (select * from sales.orders o join sales.orders p using (id)) s', ORDER_COLUMNS],
    ];
    for (const [text, expected] of rows) expect(await columns(text), text).toEqual(expected);
    const nested = await complete(
      'with a as (select amount from sales.orders), b as (select * from a) select b.| from b',
    );
    expect(nested.items[0]?.detail).toBe('decimal(10,2)');
  });

  it('names the columns of VALUES and renames the first columns after t(a, b) of VALUES, a CTE, a subquery and a table', async () => {
    const rows: [string, string[]][] = [
      ['select v.| from (values (1, 2), (3, 4)) v', ['col0', 'col1']],
      ['select v.| from (values (1, 2)) v(a, b)', ['a', 'b']],
      ['with c(a, b) as (select id, amount from sales.orders) select c.| from c', ['a', 'b']],
      ['with c(a) as (values (1, 2)) select c.| from c', ['a', 'col1']],
      ['select s.| from (select id, amount from sales.orders) as s(a)', ['a', 'amount']],
      ['select s.| from (select 1, amount from sales.orders) s(a)', ['a', 'amount']],
      ['select o.| from sales.orders o(x, y)', ['x', 'y', 'attrs', 'amount', 'created']],
      ['select r.| from range(3) r(i)', ['i']],
      ['with recursive r(n) as (select 1 union all select n + 1 from r) select r.| from r', ['n']],
    ];
    for (const [text, expected] of rows) expect(await columns(text), text).toEqual(expected);
  });

  it('offers no column for an expression without alias, a table function or the result of PIVOT', async () => {
    const rows: [string, string[]][] = [
      ["select s.| from (select amount * 2, upper('x') from sales.orders) s", []],
      ['select r.| from range(3) r', []],
      ["select s.| from (select * from read_csv('x.csv')) s", []],
      // COLUMNS(*) gives any number of columns: what follows it has no known position.
      ['select s.| from (select columns(*), amount from sales.orders) s(a)', ['a']],
      ['select p.| from (select 1 as a) pivot (sum(a) for a in (1)) p', []],
    ];
    for (const [text, expected] of rows) expect(await columns(text), text).toEqual(expected);
  });
});

describe('tables, schemas and views', () => {
  it('offers schemas first after FROM, then the default schema, then the other tables, with comment and size documented', async () => {
    const result = await complete('select * from |');
    expect(result.items.slice(0, 6).map(({ label, kind, insertText }) => [label, kind, insertText])).toEqual([
      ['lake', 'schema', 'lake'],
      ['main', 'schema', 'main'],
      ['sales', 'schema', 'sales'],
      ['plain', 'table', 'plain'],
      ['sales.big_orders', 'view', 'sales.big_orders'],
      ['sales.orders', 'table', 'sales.orders'],
    ]);
    expect(result.items.find(({ label }) => label === 'sales.orders')?.detail).toBe('2 rows');
    expect(groups(result)).toEqual(['schema', 'table', 'view', 'table', 'function']);
    const functions = ofKind(result, 'function').map(({ label }) => label);
    expect(functions).toContain('read_csv');
    expect(functions).not.toContain('lower');

    const orders = result.items.find(({ label }) => label === 'sales.orders');
    expect(orders?.documentation).toContain('Customer orders');
    expect(orders?.documentation).toContain(': 2');
    const view = result.items.find(({ label }) => label === 'sales.big_orders');
    expect(view?.documentation).toContain('Orders above 1');
    expect(view?.documentation).toContain('SELECT * FROM sales.orders WHERE (amount > 1)');

    const withCte = await complete('with recent as (select 1 as a) select * from |');
    expect(withCte.items[0]).toMatchObject({ label: 'recent', kind: 'table' });
  });

  it('completes after a schema qualifier and offers nothing after a name that is no schema', async () => {
    expect((await complete('select * from sales.|')).items.map(({ label, kind }) => [label, kind])).toEqual([
      ['big_orders', 'view'],
      ['orders', 'table'],
    ]);
    const lake = await complete('select * from lake.|');
    expect(lake.items.map(({ label, kind }) => [label, kind])).toEqual([
      ['main', 'schema'],
      ['sales', 'schema'],
      ['current_snapshot', 'function'],
      ['last_committed_snapshot', 'function'],
      ['options', 'function'],
      ['settings', 'function'],
      ['snapshots', 'function'],
      ['table_changes', 'function'],
      ['table_deletions', 'function'],
      ['table_info', 'function'],
      ['table_insertions', 'function'],
    ]);
    for (const text of [
      'select * from SALES.|',
      'select * from LAKE.sales.|',
      'select * from lake.sales.|',
    ]) {
      expect(labels(await complete(text)), text).toEqual(['big_orders', 'orders']);
    }
    for (const text of [
      'select * from nowhere.|',
      'select * from sales.orders.|',
      'select * from sales.orders foo.|',
      'create table sales.|',
    ]) {
      expect(labels(await complete(text)), text).toEqual([]);
    }
    expect(labels(await complete('comment on column sales.|'))).toEqual(['big_orders', 'orders']);
    expect(labels(await complete('comment on column plain.|'))).toEqual(['x', 'y', 'z']);
  });

  it('offers the right kind of name after USE, INSERT INTO, DROP, CREATE TABLE and for new names', async () => {
    for (const text of ['use |', 'drop schema |', 'use lake.|', 'create table |']) {
      expect(labels(await complete(text)), text).toEqual(['main', 'sales']);
    }
    for (const text of ['insert into |', 'drop table |', 'alter table |', 'describe |']) {
      const result = await complete(text);
      expect(ofKind(result, 'function'), text).toEqual([]);
      expect(labels(result).slice(0, 3), text).toEqual(['main', 'sales', 'plain']);
    }
    for (const text of ['select a as |', 'create table x (|', 'alter table sales.orders rename to |']) {
      expect(labels(await complete(text)), text).toEqual([]);
    }
    const call = await complete('call |');
    expect(call.items[0]).toMatchObject({ label: 'lake', kind: 'schema' });
    expect(ofKind(call, 'function').map(({ label }) => label)).toEqual(
      GLOBAL_LAKE_FUNCTIONS.filter(({ procedure }) => procedure).map(({ name }) => name),
    );
    expect(labels(await complete('call lake.|'))).toEqual([
      'merge_adjacent_files',
      'set_commit_message',
      'set_option',
    ]);
  });

  it('offers keywords, types and settings once each where the grammar expects them', async () => {
    const start = await complete('|');
    expect(labels(start).slice(0, 4)).toEqual(['SELECT', 'WITH', 'FROM', 'INSERT']);
    expect(groups(start)).toEqual(['keyword', 'snippet']);
    const after = await complete('select * from sales.orders |');
    expect(labels(after).slice(0, 5)).toEqual(['WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'QUALIFY']);
    expect(labels(after)).toContain('AT');

    for (const text of [
      'select a::| from t',
      'select cast(a as |) from t',
      'create table x (a |',
      'alter table sales.orders add column z |',
    ]) {
      const result = await complete(text);
      expect(groups(result), text).toEqual(['type']);
      expect(labels(result), text).toEqual(
        expect.arrayContaining(['INTEGER', 'VARCHAR', 'DECIMAL', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE']),
      );
    }
    for (const text of ['select * from sales.orders where |', 'select * from sales.orders |', 'select |']) {
      const words = (await complete(text)).items
        .filter(({ kind }) => kind === 'keyword' || kind === 'type')
        .map(({ label }) => label);
      expect(words.length, text).toBeGreaterThan(0);
      expect(new Set(words).size, text).toBe(words.length);
    }

    const settings = await complete('set |');
    expect(ofKind(settings, 'setting').map(({ label }) => label)).toEqual(
      expect.arrayContaining(['threads', 'memory_limit']),
    );
    expect(settings.items.find(({ label }) => label === 'threads')).toMatchObject({ detail: 'BIGINT' });
  });
});

describe('the history fixture', () => {
  it('lists the columns and tables of the schemas in order, and the row counts also of inlined rows', async () => {
    const result = await complete('select | from shop.events e', history.catalog);
    expect(ofKind(result, 'column').map(({ label, detail }) => [label, detail])).toEqual([
      ['id', 'int32 NOT NULL'],
      ['kind', 'varchar'],
      ['ts', 'timestamp'],
      ['amount', 'decimal(10,2)'],
    ]);

    const tables = await complete('select * from |', history.catalog);
    expect(tables.items.slice(0, 10).map(({ label }) => label)).toEqual([
      'lake',
      'main',
      'shop',
      'evolved',
      'shop.audit',
      'shop.big_events',
      'shop.customers',
      'shop.events',
      'shop.log',
      'shop.notes',
    ]);
    const shop = await complete('select * from shop.|', history.catalog);
    expect(shop.items.find(({ label }) => label === 'customers')?.detail).toBe('5 rows');
    expect(shop.items.find(({ label }) => label === 'notes')?.detail).toBe('0 rows');
  });

  it('knows a table under its name of the snapshot, and offers the macros where they apply', async () => {
    const early = await openHistory(34);
    try {
      const result = await complete('select e.| from main.evolving e', early.catalog);
      expect(result.items.map(({ label, detail }) => [label, detail])).toEqual([
        ['id', 'int32'],
        ['title', 'varchar'],
        ['info', 'struct(a int32, b varchar, c float64)'],
        ['n', 'int64'],
        ['flag', 'boolean'],
      ]);
      expect(labels(await complete('select e.info.| from main.evolving e', early.catalog))).toEqual([
        'a',
        'b',
        'c',
      ]);
    } finally {
      await early.close();
    }
    expect(labels(await complete('select e.| from main.evolving e', history.catalog))).toEqual([]);
    expect(labels(await complete('select e.| from main.evolved e', history.catalog))).toEqual([
      'id',
      'title',
      'info',
      'n',
      'flag',
    ]);

    const tables = [
      ['audit', 'table'],
      ['big_events', 'view'],
      ['customers', 'table'],
      ['events', 'table'],
      ['log', 'table'],
      ['notes', 'table'],
      ['readings', 'table'],
    ];
    const kinds = async (text: string): Promise<string[][]> =>
      (await complete(text, history.catalog)).items.map(({ label, kind }) => [label, kind]);
    expect(await kinds('select shop.| from shop.events')).toEqual([...tables, ['gross', 'macro']]);
    expect(await kinds('select * from shop.|')).toEqual([...tables, ['recent_events', 'macro']]);
    expect(await kinds('insert into shop.|')).toEqual(tables);
  });
});

describe('AT ( ... ): time travel', () => {
  it('offers VERSION and TIMESTAMP, then the snapshots newest first, as versions and as timestamp literals', async () => {
    const clause = await complete('select * from sales.orders at (|');
    expect(clause.items.map(({ kind, insertText }) => [kind, insertText])).toEqual([
      ['snapshot', 'VERSION => '],
      ['snapshot', 'TIMESTAMP => '],
    ]);

    const versions = await complete('select * from sales.orders at (version => |');
    expect(labels(versions)).toEqual(Array.from({ length: 14 }, (_, index) => String(13 - index)));
    expect(versions.items[0]).toMatchObject({ kind: 'snapshot', insertText: '13' });
    expect(versions.items[10]?.documentation).toContain('@3');

    const times = await complete('select * from sales.orders at (timestamp => |');
    const [first] = await sales.catalog.snapshots();
    expect(times.items).toHaveLength(14);
    expect(times.items[0]).toMatchObject({ kind: 'snapshot', detail: '@13' });
    expect(times.items[0]?.label).toBe(first?.time.slice(0, 23).replace('T', ' '));
    // One millisecond after the time that the catalog shows, as a timestamp literal.
    const literal = new Date(Date.parse(first?.time ?? '') + 1)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '+00');
    expect(times.items[0]?.insertText).toBe(`'${literal}'`);
  });

  it('offers at most the newest snapshots', async () => {
    const many: SqlCatalog = {
      ...sales.catalog,
      snapshots: () =>
        Promise.resolve(
          Array.from({ length: MAX_SNAPSHOT_ITEMS + 50 }, (_, index) => ({
            id: MAX_SNAPSHOT_ITEMS + 49 - index,
            time: '2026-01-01T00:00:00.000Z',
            changes: null,
            author: null,
            commitMessage: null,
            commitExtraInfo: null,
          })),
        ),
    };
    const result = await complete('select * from sales.orders at (version => |', many);
    expect(result.items).toHaveLength(MAX_SNAPSHOT_ITEMS);
    expect(result.items[0]?.label).toBe(String(MAX_SNAPSHOT_ITEMS + 49));
  });
});

describe('DuckLake', () => {
  const inserts = (result: Completions, kind: CompletionItem['kind']): string[] =>
    ofKind(result, kind).map(({ insertText }) => insertText);

  it('inserts the global functions with the lake filled in: the reading ones after FROM, the procedures after CALL', async () => {
    const from = await complete('select * from |');
    expect(from.items.find(({ label }) => label === 'ducklake_snapshots')).toMatchObject({
      insertText: "ducklake_snapshots('lake')",
      snippet: true,
    });
    expect(inserts(from, 'function')).toContain(
      "ducklake_table_changes('lake', '${1:schema_name}', '${2:table_name}', ${3:start_snapshot}, ${4:end_snapshot})",
    );
    expect(labels(from)).not.toContain('ducklake_expire_snapshots');
    expect(labels(from)).not.toContain('ducklake_scan');
    // Named arguments may follow: the cursor stays inside the parentheses.
    expect(inserts(await complete('call |'), 'function')).toContain("ducklake_cleanup_old_files('lake'$0)");
    expect(labels(await complete('select | from sales.orders'))).not.toContain('ducklake_snapshots');

    const odd: SqlCatalog = { ...EMPTY_CATALOG, lake: "it's $1" };
    expect(inserts(await complete('select * from |', odd), 'function')).toContain(
      "ducklake_snapshots('it''s \\$1')",
    );
  });

  it('offers the named arguments that are not given yet, once the positional ones are typed', async () => {
    const named = async (text: string): Promise<string[]> => inserts(await complete(text), 'parameter');
    expect(await named("call ducklake_cleanup_old_files('lake', |")).toEqual([
      'older_than => ',
      'cleanup_all => ',
      'dry_run => ',
    ]);
    expect(await named("call ducklake_cleanup_old_files('lake', dry_run => true, cl|")).toEqual([
      'older_than => ',
      'cleanup_all => ',
    ]);
    expect(await named("select * from ducklake_list_files('lake', 'orders', |)")).toEqual([
      'schema => ',
      'snapshot_version => ',
      'snapshot_time => ',
    ]);
    for (const text of [
      'call ducklake_cleanup_old_files(|',
      "call ducklake_cleanup_old_files('lake', dry_run => |",
      "call lake.set_option('a', 1, |",
    ]) {
      expect(await named(text), text).toEqual([]);
    }
  });

  it('completes the statement shapes of DuckLake as snippets', async () => {
    const start = await complete('|');
    expect(ofKind(start, 'snippet').every(({ snippet }) => snippet)).toBe(true);
    expect(inserts(start, 'snippet')).toEqual(
      expect.arrayContaining([
        'CHECKPOINT lake',
        "COMMENT ON TABLE ${1:table} IS '${2:comment}'",
        'ALTER TABLE ${1:table} SET PARTITIONED BY (${2:column})',
        "CALL ducklake_cleanup_old_files('lake', dry_run => true)",
        "CALL ducklake_merge_adjacent_files('lake')",
      ]),
    );
    expect(inserts(await complete('select * from sales.orders o |'), 'snippet')).toEqual([
      'AT (VERSION => ${1})',
      "AT (TIMESTAMP => '${1}')",
    ]);
    const alter = await complete('alter table sales.orders |');
    expect(inserts(alter, 'snippet')).toEqual([
      'SET PARTITIONED BY (${1:column})',
      'SET SORTED BY (${1:column})',
    ]);
    expect(labels(alter)).not.toContain('SET PARTITIONED BY');
    for (const text of [
      'select * from sales.orders where |',
      'select * from (|',
      'select 1 union |',
      'with x as (select 1) |',
    ]) {
      expect(ofKind(await complete(text), 'snippet'), text).toEqual([]);
    }
  });

  it('offers the snapshot times inside the quotes of a timestamp, and the ids inside a version number', async () => {
    const [newest] = await sales.catalog.snapshots();
    const time = new Date(Date.parse(newest?.time ?? '') + 1)
      .toISOString()
      .replace('T', ' ')
      .replace('Z', '+00');
    const text = 'select * from sales.orders at (timestamp => ';

    const closed = await complete(`${text}'|')`);
    expect(closed.items).toHaveLength(14);
    expect(closed.items[0]?.insertText).toBe(time);
    expect(closed.insert).toEqual({ offset: text.length + 1, length: 0 });

    const typed = await complete(`${text}'2|0')`);
    expect(typed.insert).toEqual({ offset: text.length + 1, length: 1 });
    expect(typed.replace).toEqual({ offset: text.length + 1, length: 2 });

    // Without its closing quote the string reaches to the end of the text: the item closes it.
    for (const open of [`${text}'|`, `${text}'20|\n; select 1`]) {
      const result = await complete(open);
      expect(result.items[0]?.insertText, open).toBe(`${time}'`);
      expect(result.replace, open).toEqual(result.insert);
    }

    const version = await complete('select * from sales.orders at (version => 1|)');
    expect(version.items[0]).toMatchObject({ kind: 'snapshot', insertText: '13' });
    expect(version.insert).toEqual({ offset: 42, length: 1 });
  });

  it('reads the objects of the snapshot that the statement names, and offers the tables of other schemas inside a quote', async () => {
    const text = 'select t.| from sales.tmp t';
    expect(labels(await complete(text))).toEqual([]);
    expect(labels(await complete(`${text} at (version => 10)`))).toEqual(['a']);
    expect(labels(await complete(`${text} at (version => 10); select 1`))).toEqual(['a']);
    expect(labels(await complete(`select 1 at (version => 10); ${text}`))).toEqual([]);

    const quoted = await complete('select * from "or|');
    const orders = quoted.items.find(({ label }) => label === 'sales.orders');
    expect(orders).toMatchObject({ insertText: '"sales"."orders"', filterText: '"sales"."orders"' });
    expect(quoted.items.every(({ filterText, insertText }) => filterText === insertText)).toBe(true);
  });
});

describe('the SQL of DuckDB', () => {
  const firstLabels = async (text: string, count: number): Promise<string[]> =>
    labels(await complete(text)).slice(0, count);
  const inserts = async (text: string, kind: CompletionItem['kind']): Promise<string[]> =>
    ofKind(await complete(text), kind).map(({ insertText }) => insertText);

  it('offers only the columns of the relations in * EXCLUDE (...), * RENAME (...) and after AS in * REPLACE (...)', async () => {
    for (const text of [
      'select * exclude (|) from sales.orders',
      'select * exclude | from sales.orders',
      'select columns(* exclude (id, |)) from sales.orders',
      'select * replace (amount * 2 as |) from sales.orders',
      'select * rename (|) from sales.orders',
    ]) {
      expect(labels(await complete(text)), text).toEqual(ORDER_COLUMNS);
    }
    expect(await firstLabels('select columns(|) from sales.orders', 5)).toEqual(ORDER_COLUMNS);
  });

  it('offers a lambda parameter ahead of the columns inside the body of its lambda, and nowhere else', async () => {
    const inside = await complete('select list_transform(l, lambda item: |) from sales.orders');
    expect(labels(inside).slice(0, 6)).toEqual(['item', ...ORDER_COLUMNS]);
    expect(inside.items[0]).toMatchObject({ kind: 'column', insertText: 'item' });
    expect(
      labels(await complete('select list_transform(l, lambda item: 1), | from sales.orders')),
    ).not.toContain('item');
    expect(labels(await complete('select list_transform(l, lambda |'))).toEqual([]);
    // The parameter hides the alias of the same name.
    expect(labels(await complete('select list_transform(l, lambda o: o.|) from sales.orders o'))).toEqual([]);
  });

  it('offers the parts of a window specification and of its frame in their order', async () => {
    const over = 'select sum(amount) over (order by id';
    expect(await firstLabels('select sum(amount) over (|) from sales.orders', 3)).toEqual([
      'PARTITION BY',
      'ORDER BY',
      'ROWS',
    ]);
    expect(await firstLabels('select sum(amount) over (partition by |) from sales.orders', 5)).toEqual(
      ORDER_COLUMNS,
    );
    expect(await firstLabels(`${over} rows |`, 3)).toEqual(['BETWEEN', 'UNBOUNDED PRECEDING', 'CURRENT ROW']);
    expect(await firstLabels(`${over} rows between 2 |`, 2)).toEqual(['PRECEDING', 'FOLLOWING']);
    expect(await firstLabels(`${over} rows between 2 preceding |`, 1)).toEqual(['AND']);
    expect(await firstLabels(`${over} rows between 2 preceding and |`, 2)).toEqual([
      'UNBOUNDED FOLLOWING',
      'CURRENT ROW',
    ]);
    expect(await firstLabels(`${over} rows between 2 preceding and current row |`, 1)).toEqual([
      'EXCLUDE CURRENT ROW',
    ]);
  });

  it('reads PIVOT and UNPIVOT: their table, its columns in ON and USING, values in IN, nothing of the result', async () => {
    expect(await firstLabels('pivot sales.orders |', 3)).toEqual(['ON', 'USING', 'GROUP BY']);
    expect(await firstLabels('pivot sales.orders on |', 5)).toEqual(ORDER_COLUMNS);
    expect(await firstLabels('pivot sales.orders on customer using sum(|)', 5)).toEqual(ORDER_COLUMNS);
    expect(await firstLabels('unpivot sales.orders on amount into |', 2)).toEqual(['NAME', 'VALUE']);
    expect(labels(await complete('select * from sales.orders unpivot (v for k in (|))'))).toEqual(
      ORDER_COLUMNS,
    );
    for (const text of [
      'pivot sales.orders on customer in (|',
      'select * from sales.orders pivot (sum(amount) for id in (|))',
      'select | from sales.orders pivot (sum(amount) for id in (1))',
    ]) {
      expect(ofKind(await complete(text), 'column'), text).toEqual([]);
    }
  });

  it('continues a FROM-first query with SELECT, and offers a query besides the tables after SUMMARIZE', async () => {
    expect(await firstLabels('from sales.orders |', 2)).toEqual(['SELECT', 'WHERE']);
    expect(await firstLabels('from sales.orders select |', 5)).toEqual(ORDER_COLUMNS);
    const summarize = await complete('summarize |');
    expect(labels(summarize).slice(0, 3)).toEqual(['main', 'sales', 'plain']);
    expect(ofKind(summarize, 'keyword').map(({ label }) => label)).toEqual(['SELECT', 'FROM', 'WITH']);
    expect(await firstLabels('explain analyze |', 1)).toEqual(['SELECT']);
  });

  it('offers the options of COPY ... TO for the format of FORMAT or the file name, except those given', async () => {
    const parquet = await inserts("copy sales.orders to 'out.parquet' (|", 'parameter');
    expect(parquet).toEqual(
      expect.arrayContaining(['COMPRESSION', 'ROW_GROUP_SIZE', 'FORMAT', 'PARTITION_BY']),
    );
    expect(parquet).not.toContain('HEADER');
    const csv = await inserts("copy sales.orders to 'out.parquet' (header, |, format csv)", 'parameter');
    expect(csv).toContain('DELIM');
    expect(csv).not.toContain('HEADER');
    expect(csv).not.toContain('FORMAT');
    expect(csv).not.toContain('ROW_GROUP_SIZE');
    expect(await inserts("copy sales.orders to 'out' (format |", 'keyword')).toEqual([
      'csv',
      'parquet',
      'json',
    ]);
    expect(labels(await complete("copy sales.orders to 'out' (partition_by (|"))).toEqual(ORDER_COLUMNS);
    expect((await complete("copy sales.orders to 'out' (compression |")).items).toEqual([]);
  });

  it('offers the named options of read_csv and read_parquet once the path is typed, except those given', async () => {
    const csv = await inserts("select * from read_csv('orders.csv', header = true, |)", 'parameter');
    expect(csv).toEqual(expect.arrayContaining(['delim => ', 'columns => ', 'auto_detect => ']));
    expect(csv).not.toContain('header => ');
    expect(await inserts("select * from read_parquet('orders.parquet', |)", 'parameter')).toEqual(
      expect.arrayContaining(['hive_partitioning => ', 'union_by_name => ']),
    );
    expect(await inserts('select * from read_csv(|', 'parameter')).toEqual([]);
  });
});

describe('when completion is not possible or not complete', () => {
  it('answers nothing inside a string, a comment or a number', async () => {
    for (const text of ["select 'a|b'", 'select 1 -- a|', 'select /* a| */ 1', 'select 12|3']) {
      const cursor = marked(text);
      expect(await service.complete(cursor.text, cursor.offset, sales.catalog), text).toBeUndefined();
    }
  });

  it('still offers keywords and functions when the catalog is not available or fails to read', async () => {
    expect(groups(await complete('select | from sales.orders', EMPTY_CATALOG))).toEqual([
      'function',
      'keyword',
    ]);
    const failing: SqlCatalog = {
      ...sales.catalog,
      entries: () => Promise.reject(new Error('the catalog is gone')),
      schemas: () => Promise.reject(new Error('the catalog is gone')),
      columns: () => Promise.reject(new Error('the catalog is gone')),
      macros: () => Promise.reject(new Error('the catalog is gone')),
      snapshots: () => Promise.reject(new Error('the catalog is gone')),
    };
    expect(groups(await complete('select | from sales.orders', failing))).toEqual(['function', 'keyword']);
    expect(labels(await complete('select * from sales.|', failing))).toEqual([]);
  });

  it('offers the functions that DuckDB lists, with signature and description, but not the table functions in an expression', async () => {
    const result = await complete('select | from sales.orders');
    const substring = result.items.find(({ label }) => label === 'substring');
    expect(substring).toMatchObject({ kind: 'function', insertText: 'substring' });
    expect(substring?.detail).toBe('substring(string VARCHAR, start BIGINT) -> VARCHAR');
    expect(substring?.documentation).toContain("Example: `substring('Hello', 2)`");
    expect(result.items.find(({ label }) => label === 'read_csv')).toBeUndefined();
    expect(result.items.find(({ label }) => label === 'snapshots')).toBeUndefined();
  });
});
