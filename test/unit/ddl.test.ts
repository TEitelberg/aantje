import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alterViewDdl,
  createTableDdl,
  createViewDdl,
  qualifiedName,
  quoteIdentifier,
  typeName,
} from '../../src/catalog/ddl';
import type { CatalogReader, ColumnInfo } from '../../src/catalog/model';
import { createCatalogReader } from '../../src/catalog/reader';
import { BIG_ORDERS_VIEW_SQL, ID, LATEST_SNAPSHOT } from '../support/expected';
import { catalogSources } from '../support/sources';

// The statements of test/fixtures/generate.py that created these objects in the DuckLake fixture catalogs.
const ORIGINAL_ORDERS = `CREATE TABLE sales.orders (
  id INTEGER NOT NULL,
  customer STRUCT(name VARCHAR, tags VARCHAR[]),
  attrs MAP(VARCHAR, INTEGER),
  amount DECIMAL(10,2) DEFAULT 0,
  created TIMESTAMP
)`;
const ORIGINAL_PLAIN = [
  'CREATE TABLE main.plain (x BIGINT, y VARCHAR)',
  'ALTER TABLE main.plain ADD COLUMN z DOUBLE',
];
const ORIGINAL_VIEW = 'CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE amount > 1';

// Orders for the view tests: the amount filter of the view must drop order 2.
const INSERT_ORDERS = 'INSERT INTO sales.orders (id, amount) VALUES (1, 1.50), (2, 0.50), (3, 3.00)';
const SELECT_BIG_ORDERS = 'SELECT id, amount FROM sales.big_orders ORDER BY id';
const BIG_ORDERS_ROWS = [
  { id: 1, amount: '1.50' },
  { id: 3, amount: '3.00' },
];

function column(id: number, name: string, type: string, rest: Partial<ColumnInfo> = {}): ColumnInfo {
  return { id, name, type, nullable: true, defaultValue: null, comment: null, children: [], ...rest };
}

// sales.orders at the latest snapshot, as the catalog reader returns it for the fixture.
const ORDERS_COLUMNS: ColumnInfo[] = [
  column(1, 'id', 'int32', { nullable: false }),
  column(2, 'customer', 'struct', {
    children: [
      column(3, 'name', 'varchar'),
      column(4, 'tags', 'list', { children: [column(5, 'element', 'varchar')] }),
    ],
  }),
  column(6, 'attrs', 'map', { children: [column(7, 'key', 'varchar'), column(8, 'value', 'int32')] }),
  column(9, 'amount', 'decimal(10,2)', { defaultValue: '0', comment: 'Net amount in EUR' }),
  column(10, 'created', 'timestamp'),
];
const PLAIN_COLUMNS: ColumnInfo[] = [
  column(1, 'x', 'int64'),
  column(2, 'y', 'varchar'),
  column(3, 'z', 'float64'),
];

// Builders for nested columns outside the fixture. The caller names the children the way the catalog does
// (`element`, `key`, `value`, the field names of a struct); the ids do not matter for the DDL.
const leaf = (name: string, type: string): ColumnInfo => column(0, name, type);
const list = (name: string, element: ColumnInfo): ColumnInfo =>
  column(0, name, 'list', { children: [element] });
const map = (name: string, key: ColumnInfo, value: ColumnInfo): ColumnInfo =>
  column(0, name, 'map', { children: [key, value] });
const struct = (name: string, ...fields: ColumnInfo[]): ColumnInfo =>
  column(0, name, 'struct', { children: fields });

type Rows = Record<string, unknown>[];

async function withDuckDb<T>(use: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    return await use(connection);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** Runs the statements in a fresh in-memory DuckDB and returns the rows of the query that follows them. */
function resultOf(statements: readonly string[], query: string): Promise<Rows> {
  return withDuckDb(async (connection) => {
    for (const statement of statements) {
      await connection.run(statement);
    }
    return (await connection.runAndReadAll(query)).getRowObjectsJson();
  });
}

const COLUMNS_QUERY = `SELECT table_schema, table_name, column_name, data_type, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_catalog = current_database() AND table_schema NOT IN ('information_schema', 'pg_catalog')
  ORDER BY table_schema, table_name, ordinal_position`;

/** Every table and view column the way DuckDB reports it: name, type, nullability and default. */
function columnsAfter(...statements: string[]): Promise<Rows> {
  return resultOf(statements, COLUMNS_QUERY);
}

function nullabilityAndDefaults(columns: Rows): unknown[][] {
  return columns.map((c) => [c.column_name, c.is_nullable, c.column_default]);
}

describe('quoteIdentifier and qualifiedName', () => {
  it('always double-quotes, doubles embedded quotes and joins the parts with dots', () => {
    expect(quoteIdentifier('orders')).toBe('"orders"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteIdentifier('"')).toBe('""""');
    expect(qualifiedName('sales', 'orders')).toBe('"sales"."orders"');
    expect(qualifiedName('sales', 'orders', 'amount')).toBe('"sales"."orders"."amount"');
    expect(qualifiedName('sales')).toBe('"sales"');
  });

  it('addresses a table, a column and a struct field of the fixture table in DuckDB', async () => {
    const statements = [
      'CREATE SCHEMA sales',
      createTableDdl('sales', 'orders', ORDERS_COLUMNS),
      "INSERT INTO sales.orders (id, customer) VALUES (7, {'name': 'Ada', 'tags': []})",
    ];

    const rows = await resultOf(
      statements,
      `SELECT ${qualifiedName('sales', 'orders', 'id')} AS id,
        ${qualifiedName('sales', 'orders', 'customer', 'name')} AS name
        FROM ${qualifiedName('sales', 'orders')}`,
    );

    expect(rows).toEqual([{ id: 7, name: 'Ada' }]);
  });
});

describe('createTableDdl', () => {
  it('creates the fixture tables like the original statements, and prints one column per line with a semicolon', async () => {
    const original = await columnsAfter('CREATE SCHEMA sales', ORIGINAL_ORDERS);
    const generated = await columnsAfter(
      'CREATE SCHEMA sales',
      createTableDdl('sales', 'orders', ORDERS_COLUMNS),
    );
    expect(generated).toEqual(original);
    // The comparison must not be vacuous: NOT NULL, a default and nested types really are in there.
    expect(nullabilityAndDefaults(original)).toEqual([
      ['id', 'NO', null],
      ['customer', 'YES', null],
      ['attrs', 'YES', null],
      ['amount', 'YES', '0'],
      ['created', 'YES', null],
    ]);
    expect(createTableDdl('sales', 'orders', ORDERS_COLUMNS)).toBe(`CREATE TABLE "sales"."orders" (
  "id" INTEGER NOT NULL,
  "customer" STRUCT("name" VARCHAR, "tags" VARCHAR[]),
  "attrs" MAP(VARCHAR, INTEGER),
  "amount" DECIMAL(10,2) DEFAULT 0,
  "created" TIMESTAMP
);`);

    const plain = await columnsAfter(...ORIGINAL_PLAIN);
    expect(await columnsAfter(createTableDdl('main', 'plain', PLAIN_COLUMNS))).toEqual(plain);
    expect(plain.map((c) => [c.column_name, c.data_type])).toEqual([
      ['x', 'BIGINT'],
      ['y', 'VARCHAR'],
      ['z', 'DOUBLE'],
    ]);
  });

  it('copies default expressions unchanged and writes DEFAULT before NOT NULL, the order DuckDB prints', async () => {
    const columns = [
      column(1, 'sku', 'varchar', { defaultValue: "'n/a'", nullable: false }),
      column(2, 'qty', 'int32', { defaultValue: '1', nullable: false }),
      column(3, 'added', 'timestamp', { defaultValue: 'now()' }),
      column(4, 'weight', 'float64', { defaultValue: '(1 + 2)' }),
      column(5, 'note', 'varchar'),
    ];
    const original = await columnsAfter(
      'CREATE SCHEMA shop',
      `CREATE TABLE shop.items (
        sku VARCHAR DEFAULT 'n/a' NOT NULL,
        qty INTEGER DEFAULT 1 NOT NULL,
        added TIMESTAMP DEFAULT now(),
        weight DOUBLE DEFAULT (1 + 2),
        note VARCHAR
      )`,
    );
    const generated = await columnsAfter('CREATE SCHEMA shop', createTableDdl('shop', 'items', columns));

    expect(generated).toEqual(original);
    expect(nullabilityAndDefaults(original)).toEqual([
      ['sku', 'NO', "'n/a'"],
      ['qty', 'NO', '1'],
      ['added', 'YES', 'now()'],
      ['weight', 'YES', '(1 + 2)'],
      ['note', 'YES', null],
    ]);
    expect(createTableDdl('shop', 'items', [columns[1] as ColumnInfo])).toBe(`CREATE TABLE "shop"."items" (
  "qty" INTEGER DEFAULT 1 NOT NULL
);`);
  });

  it('rebuilds lists, structs and maps nested to any depth in the right order', async () => {
    const columns = [
      list('matrix', list('element', leaf('element', 'int32'))),
      list(
        'events',
        struct('element', leaf('happened', 'timestamp'), list('tags', leaf('element', 'varchar'))),
      ),
      map('lookup', leaf('key', 'varchar'), struct('value', list('scores', leaf('element', 'float64')))),
      list(
        'deep',
        map(
          'element',
          leaf('key', 'varchar'),
          list(
            'value',
            struct(
              'element',
              list('a', leaf('element', 'int32')),
              list('b', map('element', leaf('key', 'varchar'), leaf('value', 'decimal(10,2)'))),
            ),
          ),
        ),
      ),
    ];
    const original = await columnsAfter(`CREATE TABLE nested (
      matrix INTEGER[][],
      events STRUCT(happened TIMESTAMP, tags VARCHAR[])[],
      lookup MAP(VARCHAR, STRUCT(scores DOUBLE[])),
      deep MAP(VARCHAR, STRUCT(a INTEGER[], b MAP(VARCHAR, DECIMAL(10,2))[])[])[]
    )`);
    const generated = await columnsAfter(createTableDdl('main', 'nested', columns));

    expect(generated).toEqual(original);
    expect(original.map((c) => c.data_type)).toEqual([
      'INTEGER[][]',
      'STRUCT(happened TIMESTAMP, tags VARCHAR[])[]',
      'MAP(VARCHAR, STRUCT(scores DOUBLE[]))',
      'MAP(VARCHAR, STRUCT(a INTEGER[], b MAP(VARCHAR, DECIMAL(10,2))[])[])[]',
    ]);
  });

  it('keeps NOT NULL on top-level nested columns only, and struct field names that need quoting', async () => {
    const notNull = (c: ColumnInfo): ColumnInfo => ({ ...c, nullable: false });
    const columns = [
      notNull(struct('s', leaf('a', 'int32'), leaf('b', 'varchar'))),
      notNull(list('l', leaf('element', 'int32'))),
      notNull(map('m', leaf('key', 'varchar'), leaf('value', 'int32'))),
    ];
    const original = await columnsAfter(
      'CREATE TABLE t (s STRUCT(a INTEGER, b VARCHAR) NOT NULL, l INTEGER[] NOT NULL, m MAP(VARCHAR, INTEGER) NOT NULL)',
    );
    expect(await columnsAfter(createTableDdl('main', 't', columns))).toEqual(original);
    expect(original.map((c) => c.is_nullable)).toEqual(['NO', 'NO', 'NO']);

    // A DuckDB type cannot carry NOT NULL or a default on a field.
    const field = [struct('s', column(0, 'f', 'int32', { nullable: false, defaultValue: '1' }))];
    expect(
      (await columnsAfter(createTableDdl('main', 't', field))).map((c) => [
        c.data_type,
        c.is_nullable,
        c.column_default,
      ]),
    ).toEqual([['STRUCT(f INTEGER)', 'YES', null]]);

    const odd = [
      column(1, 'Order Date', 'date', { nullable: false }),
      struct('group', leaf('first name', 'varchar'), list('a"b', leaf('element', 'int32'))),
    ];
    const oddOriginal = await columnsAfter(
      'CREATE SCHEMA "my ""odd"" schema"',
      `CREATE TABLE "my ""odd"" schema"."select" (
        "Order Date" DATE NOT NULL,
        "group" STRUCT("first name" VARCHAR, "a""b" INTEGER[])
      )`,
    );
    const oddGenerated = await columnsAfter(
      'CREATE SCHEMA "my ""odd"" schema"',
      createTableDdl('my "odd" schema', 'select', odd),
    );
    expect(oddGenerated).toEqual(oddOriginal);
    expect(oddOriginal.map((c) => c.data_type)).toContain('STRUCT("first name" VARCHAR, "a""b" INTEGER[])');
  });

  // DuckLake type name as stored in ducklake_column.column_type -> the type DuckDB reports for the created column.
  const MAPPING: [ducklakeType: string, duckdbType: string][] = [
    ['boolean', 'BOOLEAN'],
    ['null', '"NULL"'],
    ['int8', 'TINYINT'],
    ['int16', 'SMALLINT'],
    ['int32', 'INTEGER'],
    ['int64', 'BIGINT'],
    ['int128', 'HUGEINT'],
    ['uint8', 'UTINYINT'],
    ['uint16', 'USMALLINT'],
    ['uint32', 'UINTEGER'],
    ['uint64', 'UBIGINT'],
    ['uint128', 'UHUGEINT'],
    ['float32', 'FLOAT'],
    ['float64', 'DOUBLE'],
    ['decimal(10,2)', 'DECIMAL(10,2)'],
    ['decimal(38,10)', 'DECIMAL(38,10)'],
    ['time', 'TIME'],
    ['time_ns', 'TIME_NS'],
    ['timetz', 'TIME WITH TIME ZONE'],
    ['date', 'DATE'],
    ['timestamp', 'TIMESTAMP'],
    ['timestamptz', 'TIMESTAMP WITH TIME ZONE'],
    ['timestamptz_ns', 'TIMESTAMPTZ_NS'],
    ['timestamp_s', 'TIMESTAMP_S'],
    ['timestamp_ms', 'TIMESTAMP_MS'],
    ['timestamp_ns', 'TIMESTAMP_NS'],
    ['interval', 'INTERVAL'],
    ['varchar', 'VARCHAR'],
    ['blob', 'BLOB'],
    ['json', 'JSON'],
    ['uuid', 'UUID'],
    ['variant', 'VARIANT'],
    ['geometry', 'GEOMETRY'],
  ];

  it('maps every DuckLake type to the DuckDB type, and passes an unknown type through unchanged', async () => {
    const created = await withDuckDb(async (connection) => {
      const found: [string, string][] = [];
      for (const [index, [ducklakeType, duckdbType]] of MAPPING.entries()) {
        const ddl = createTableDdl('main', `t${index}`, [leaf('c', ducklakeType)]);
        // DuckDB also accepts several DuckLake names as type names, so the clipboard text must be checked too.
        expect(ddl, ducklakeType).toBe(`CREATE TABLE "main"."t${index}" (\n  "c" ${duckdbType}\n);`);
        await connection.run(ddl);
        const rows = (
          await connection.runAndReadAll(
            `SELECT data_type FROM information_schema.columns WHERE table_name = 't${index}'`,
          )
        ).getRowObjectsJson();
        found.push([ducklakeType, (rows[0]?.data_type ?? '') as string]);
      }
      return found;
    });
    expect(created).toEqual(MAPPING);

    expect(
      createTableDdl('s', 't', [
        leaf('plain', 'int256'),
        list('items', leaf('element', 'int256')),
        struct('fields', leaf('f', 'int256')),
        leaf('d', 'decimal(38, 10)'),
      ]),
    ).toBe(`CREATE TABLE "s"."t" (
  "plain" int256,
  "items" int256[],
  "fields" STRUCT("f" int256),
  "d" DECIMAL(38,10)
);`);
  });
});

describe('identifiers that need quoting', () => {
  const AWKWARD_NAMES = [
    'select',
    'Order Items',
    'with "quotes"',
    "it's",
    'a.b',
    'semi;colon',
    'two\nlines',
    'ünïcödé 日本語',
    '-- not a comment',
  ];

  it('lets every awkward name survive as schema, table, column, view and alias name', async () => {
    for (const name of AWKWARD_NAMES) {
      const view = `${name} (view)`;
      const alias = `${name} (alias)`;
      const table = qualifiedName(name, name);

      const found = await withDuckDb(async (connection) => {
        await connection.run(`CREATE SCHEMA ${quoteIdentifier(name)}`);
        await connection.run(createTableDdl(name, name, [column(1, name, 'int32')]));
        await connection.run(
          createViewDdl(name, { name: view, sql: `SELECT * FROM ${table}`, columnAliases: [alias] }),
        );
        await connection.run(`INSERT INTO ${table} VALUES (7)`);
        const names = (await connection.runAndReadAll(COLUMNS_QUERY)).getRowObjectsJson();
        // The qualified names the "Copy Qualified Name" command puts on the clipboard must resolve.
        const fromTable = await connection.runAndReadAll(
          `SELECT ${qualifiedName(name, name, name)} FROM ${table}`,
        );
        const fromView = await connection.runAndReadAll(
          `SELECT ${quoteIdentifier(alias)} FROM ${qualifiedName(name, view)}`,
        );
        return { names, fromTable: fromTable.getRows(), fromView: fromView.getRows() };
      });

      expect(
        found.names.map((c) => [c.table_schema, c.table_name, c.column_name]),
        name,
      ).toEqual([
        [name, name, name],
        [name, view, alias],
      ]);
      expect(found.fromTable, name).toEqual([[7]]);
      expect(found.fromView, name).toEqual([[7]]);
    }
  });

  it('keeps a hostile name inside one identifier, and copies default expressions and view SQL verbatim', async () => {
    const hostile = 'x"; DROP TABLE victim; --';
    const ddl = createTableDdl('main', hostile, [column(1, 'id', 'int32')]);

    const found = await withDuckDb(async (connection) => {
      await connection.run('CREATE TABLE victim (id INTEGER)');
      const statements = (await connection.extractStatements(ddl)).count;
      await connection.run(ddl);
      const tables = await connection.runAndReadAll(
        `SELECT table_name FROM information_schema.tables
         WHERE table_catalog = current_database() AND table_schema = 'main' ORDER BY table_name`,
      );
      return { statements, tables: tables.getRowObjectsJson() };
    });

    expect(found.statements).toBe(1);
    expect(found.tables).toEqual([{ table_name: 'victim' }, { table_name: hostile }]);

    // Only names are guaranteed to stay one statement.
    const table = createTableDdl('main', 't', [
      column(1, 'id', 'int32', { defaultValue: '1); DROP TABLE victim; CREATE TABLE x (y INTEGER' }),
    ]);
    const view = createViewDdl('main', {
      name: 'v',
      sql: 'SELECT 1; DROP TABLE victim; --',
      columnAliases: [],
    });
    const counts = await withDuckDb(async (connection) => [
      (await connection.extractStatements(table)).count,
      (await connection.extractStatements(view)).count,
    ]);
    expect(counts).toEqual([3, 2]);
  });
});

describe('views', () => {
  it('creates a view with the columns and rows of the original, with the aliases the catalog stored', async () => {
    const original = ['CREATE SCHEMA sales', ORIGINAL_ORDERS, INSERT_ORDERS, ORIGINAL_VIEW];
    const generated = [
      'CREATE SCHEMA sales',
      createTableDdl('sales', 'orders', ORDERS_COLUMNS),
      INSERT_ORDERS,
      createViewDdl('sales', { name: 'big_orders', sql: BIG_ORDERS_VIEW_SQL, columnAliases: [] }),
    ];

    const originalColumns = await columnsAfter(...original);
    expect(await columnsAfter(...generated)).toEqual(originalColumns);
    expect(originalColumns.filter((c) => c.table_name === 'big_orders')).toHaveLength(5);
    expect(await resultOf(original, SELECT_BIG_ORDERS)).toEqual(BIG_ORDERS_ROWS);
    expect(await resultOf(generated, SELECT_BIG_ORDERS)).toEqual(BIG_ORDERS_ROWS);

    const view = {
      name: 'totals',
      sql: 'SELECT id, amount FROM sales.orders',
      columnAliases: ['order_id', 'total'],
    };
    const setup = [
      'CREATE SCHEMA sales',
      createTableDdl('sales', 'orders', ORDERS_COLUMNS),
      INSERT_ORDERS,
      createViewDdl('sales', view),
    ];
    const query = 'SELECT order_id, total FROM sales.totals ORDER BY order_id';
    expect(await resultOf(setup, query)).toEqual([
      { order_id: 1, total: '1.50' },
      { order_id: 2, total: '0.50' },
      { order_id: 3, total: '3.00' },
    ]);
    // ALTER replaces the view in place and keeps its column names.
    const altered = [
      ...setup,
      alterViewDdl('sales', { ...view, sql: 'SELECT id, amount * 2 FROM sales.orders' }),
    ];
    expect(await resultOf(altered, query)).toEqual([
      { order_id: 1, total: '3.00' },
      { order_id: 2, total: '1.00' },
      { order_id: 3, total: '6.00' },
    ]);
  });

  it('prints the statements on one line with a semicolon', () => {
    expect(createViewDdl('sales', { name: 'big_orders', sql: BIG_ORDERS_VIEW_SQL, columnAliases: [] })).toBe(
      'CREATE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);',
    );
    expect(
      createViewDdl('sales', { name: 'totals', sql: 'SELECT 1, 2', columnAliases: ['a', 'b "c"'] }),
    ).toBe('CREATE VIEW "sales"."totals" ("a", "b ""c""") AS SELECT 1, 2;');
    expect(
      alterViewDdl('sales', {
        name: 'totals',
        sql: 'SELECT id, amount FROM sales.orders',
        columnAliases: ['order_id', 'total'],
      }),
    ).toBe(
      'CREATE OR REPLACE VIEW "sales"."totals" ("order_id", "total") AS SELECT id, amount FROM sales.orders;',
    );
  });
});

for (const source of catalogSources) {
  const skipReason = source.skipReason();
  describe.skipIf(skipReason !== undefined)(
    `DDL from what the reader returns for the ${source.name} fixture catalog${skipReason === undefined ? '' : ` (skipped: ${skipReason})`}`,
    () => {
      let reader: CatalogReader;
      beforeAll(async () => {
        reader = createCatalogReader(await source.open());
      });
      afterAll(() => reader.close());

      it('creates sales.orders, main.plain and sales.big_orders as the original statements do', async () => {
        const columns = await reader.columns(ID.orders, LATEST_SNAPSHOT);
        expect(await columnsAfter('CREATE SCHEMA sales', createTableDdl('sales', 'orders', columns))).toEqual(
          await columnsAfter('CREATE SCHEMA sales', ORIGINAL_ORDERS),
        );

        const plain = await reader.columns(ID.plain, LATEST_SNAPSHOT);
        expect(await columnsAfter(createTableDdl('main', 'plain', plain))).toEqual(
          await columnsAfter(...ORIGINAL_PLAIN),
        );

        const views = await reader.views(ID.salesSchema, LATEST_SNAPSHOT);
        const rows = await resultOf(
          [
            'CREATE SCHEMA sales',
            createTableDdl('sales', 'orders', columns),
            INSERT_ORDERS,
            ...views.map((view) => createViewDdl('sales', view)),
          ],
          SELECT_BIG_ORDERS,
        );
        expect(views.map((view) => view.name)).toEqual(['big_orders']);
        expect(rows).toEqual(BIG_ORDERS_ROWS);
      });
    },
  );
}

describe('typeName', () => {
  it('spells out a decimal with its precision and scale, and passes anything that only contains one through unchanged', () => {
    expect(typeName('decimal(10,2)')).toBe('DECIMAL(10,2)');
    expect(typeName('decimal( 10 , 2 )')).toBe('DECIMAL(10,2)');
    for (const text of [
      'xdecimal(10,2)',
      'decimal(10,2)x',
      'decimal(10,2); DROP TABLE victim',
      'decimal(10)',
    ]) {
      expect(typeName(text), text).toBe(text);
    }
  });
});
