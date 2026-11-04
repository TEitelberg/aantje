/**
 * Facts about the fixture catalogs written by test/fixtures/generate.py. The statement sequence is fixed,
 * so these values are identical for the sqlite, duckdb and postgres variant.
 */
export const SPEC_VERSION = '1.1';

/** Snapshot ids, named after the statement that created them. */
export const SNAPSHOT = {
  createMainSchema: 0,
  createSalesSchema: 1,
  createOrders: 2,
  createTmp: 3,
  insertOrders: 4, // 3 rows in one data file
  insertTmp: 5,
  deleteOrder2: 6, // writes a delete file with 1 deleted row
  createBigOrdersView: 7,
  commentOnOrders: 8,
  commentOnAmount: 9,
  commentOnView: 10,
  dropTmp: 11,
  createPlain: 12,
  addPlainColumn: 13,
} as const;

export const LATEST_SNAPSHOT = 13;

/** Catalog ids (schemas, tables and views share one id space). */
export const ID = {
  mainSchema: 0,
  salesSchema: 1,
  orders: 2,
  tmp: 3,
  bigOrdersView: 4,
  plain: 5,
} as const;

export const BIG_ORDERS_VIEW_SQL = 'SELECT * FROM sales.orders WHERE (amount > 1)';

/**
 * Live statistics of sales.orders / sales.tmp as the reader must report them. File sizes are not listed
 * because they differ between the generated variants; derive them from ducklake_data_file and
 * ducklake_delete_file instead.
 */
export const STATS = {
  ordersAfterInsert: { rows: 3, files: 1 },
  ordersAfterDelete: { rows: 2, files: 1 }, // the delete file removes order 2
  tmpAfterInsert: { rows: 1, files: 1 },
  beforeFirstInsert: { rows: 0, files: 0 },
} as const;
