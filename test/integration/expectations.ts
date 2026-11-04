/** What the explorer shows for the fixture catalogs (test/fixtures), in the format of `outline` in support.ts. */

/**
 * The connection node first, then the catalog at its latest snapshot (13). The Columns folder of the view is listed
 * but not expanded: its columns come from DuckDB after a confirmation (see data-views.test.ts).
 */
export function treeAtLatest(connection: string): string[] {
  return [
    connection,
    '  main',
    '    Tables',
    '      plain',
    '        Columns',
    '          x : int64',
    '          y : varchar',
    '          z : float64',
    '    Views',
    '      No views.',
    '    Macros',
    '      No macros.',
    '  sales',
    '    Tables',
    '      orders',
    '        Columns',
    ...ORDERS_COLUMNS,
    '    Views',
    '      big_orders',
    '        Columns',
    '    Macros',
    '      No macros.',
  ];
}

/** The catalog at snapshot 5: orders still has its 3 rows, tmp exists, the view and plain do not. */
export function treeAtSnapshot5(connection: string): string[] {
  return [
    connection,
    '  main',
    '    Tables',
    '      No tables.',
    '    Views',
    '      No views.',
    '    Macros',
    '      No macros.',
    '  sales',
    '    Tables',
    '      orders',
    '        Columns',
    ...ORDERS_COLUMNS,
    '      tmp',
    '        Columns',
    '          a : int32',
    '    Views',
    '      No views.',
    '    Macros',
    '      No macros.',
  ];
}

const ORDERS_COLUMNS = [
  '          id : int32 NOT NULL',
  '          customer : struct',
  '            name : varchar',
  '            tags : list',
  '              element : varchar',
  '          attrs : map',
  '            key : varchar',
  '            value : int32',
  '          amount : decimal(10,2)',
  '          created : timestamp',
];

export const ORDERS_DDL = `CREATE TABLE "sales"."orders" (
  "id" INTEGER NOT NULL,
  "customer" STRUCT("name" VARCHAR, "tags" VARCHAR[]),
  "attrs" MAP(VARCHAR, INTEGER),
  "amount" DECIMAL(10,2) DEFAULT 0,
  "created" TIMESTAMP
);`;

export const BIG_ORDERS_DDL =
  'CREATE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);';

export const PLAIN_DDL_AT_CREATION = `CREATE TABLE "main"."plain" (
  "x" BIGINT,
  "y" VARCHAR
);`;

export const PLAIN_DDL_AT_LATEST = `CREATE TABLE "main"."plain" (
  "x" BIGINT,
  "y" VARCHAR,
  "z" DOUBLE
);`;

/** The rows of the snapshot picker (label and detail), newest snapshot first. */
export const SNAPSHOT_ROWS = [
  { label: 'Latest', detail: 'Follow the newest snapshot' },
  { label: '@13', detail: 'Altered table #5' },
  { label: '@12', detail: 'Created table main.plain' },
  { label: '@11', detail: 'Dropped table #3' },
  { label: '@10', detail: 'Altered view #4' },
  { label: '@9', detail: 'Altered table #2' },
  { label: '@8', detail: 'Altered table #2' },
  { label: '@7', detail: 'Created view sales.big_orders' },
  { label: '@6', detail: 'Deleted from table #2' },
  { label: '@5', detail: 'Inserted into table #3' },
  { label: '@4', detail: 'Inserted into table #2' },
  { label: '@3', detail: 'Created table sales.tmp' },
  { label: '@2', detail: 'Created table sales.orders' },
  { label: '@1', detail: 'Created schema sales' },
  { label: '@0', detail: 'Created schema main' },
];

/** The rows of the catalog search, sorted by schema and name. */
export const SEARCH_ROWS = [
  { label: 'main.plain', description: 'table' },
  { label: 'sales.big_orders', description: 'view' },
  { label: 'sales.orders', description: 'table' },
];

/** The columns of `sales.orders` in the grid, as DuckDB names their types. */
export const ORDERS_GRID_COLUMNS = [
  { name: 'id', type: 'INTEGER', kind: 'number' },
  { name: 'customer', type: 'STRUCT("name" VARCHAR, "tags" VARCHAR[])', kind: 'nested' },
  { name: 'attrs', type: 'MAP(VARCHAR, INTEGER)', kind: 'nested' },
  { name: 'amount', type: 'DECIMAL(10,2)', kind: 'number' },
  { name: 'created', type: 'TIMESTAMP', kind: 'text' },
];

/** The three rows of `sales.orders` at snapshots 4 and 5; order 2 is deleted in snapshot 6. Nested values are JSON text. */
export const ORDER_1 = [
  1,
  '{"name":"a","tags":["x"]}',
  '[{"key":"k","value":1}]',
  '1.50',
  '2026-01-01 00:00:00',
];
export const ORDER_2 = [2, '{"name":"b","tags":[]}', '[]', '2.50', '2026-01-02 00:00:00'];
export const ORDER_3 = [3, null, null, '3.00', '2026-01-03 00:00:00'];

/** The columns of the view `sales.big_orders` as DuckDB resolves them (`SELECT * FROM sales.orders WHERE (amount > 1)`), as lines of `outline`. */
export const BIG_ORDERS_COLUMNS = [
  'id : INTEGER NOT NULL',
  'customer : STRUCT("name" VARCHAR, "tags" VARCHAR[])',
  'attrs : MAP(VARCHAR, INTEGER)',
  'amount : DECIMAL(10,2)',
  'created : TIMESTAMP',
];
