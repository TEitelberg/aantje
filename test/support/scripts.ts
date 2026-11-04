import type { ColumnInfo } from '../../src/catalog/model';
import { alterOptionLines } from '../../src/maintenance-options';
import { scriptOf } from '../../src/script-templates';

type Tree = Parameters<typeof scriptOf>[1];
type Ref = Parameters<typeof scriptOf>[2];

export const createOf = (tree: Tree, ref: Ref) => scriptOf('create', tree, ref);
export const alterOf = (tree: Tree, ref: Ref) => scriptOf('alter', tree, ref);
export const selectOf = (tree: Tree, ref: Ref) => scriptOf('select', tree, ref);
// The drop scripts of a table, a view and a macro are made without waiting.
export const dropOf = (tree: Tree, ref: Ref) => scriptOf('drop', tree, ref) as string | undefined;

/** The scripts that Script as CREATE, ALTER and DROP write for the fixture catalogs, as the unit and the integration tests expect them. */

const ALTER_HEADER = `-- Every statement in this script is commented out, so running it changes nothing.
-- Remove the "-- " in front of the statements you want, replace the <placeholders> and run them in a read/write SQL session.
-- DuckLake can add, rename and drop columns and struct fields, change a column type (only widening, for example INTEGER to BIGINT), rename the table, and set the comment, the partitioning, the sort order and the options.`;

/** The blocks of the table itself: add a column, rename, comment, partitioning, sort order, options; `column` is the first column of the table. */
const tableLevel = (table: string, column: string): string =>
  `-- Add a column
-- ALTER TABLE ${table} ADD COLUMN <new_column> <type>;

-- Rename the table
-- ALTER TABLE ${table} RENAME TO <new_name>;

-- Comment on the table
-- COMMENT ON TABLE ${table} IS '<comment>';

-- Partitioning of new data
-- ALTER TABLE ${table} SET PARTITIONED BY (<column>);
-- ALTER TABLE ${table} RESET PARTITIONED BY;

-- Sort order of new data
-- ALTER TABLE ${table} SET SORTED BY (<column> ASC);
-- ALTER TABLE ${table} RESET SORTED BY;

-- Options of the table; RESET removes the override, so that the value of the schema, the lake or the default applies
${alterOptionLines(table, [{ name: column } as ColumnInfo]).join('\n')}`;

/** The comment lines of a column: rename, change the type, drop, comment. */
const plainColumn = (table: string, index: number, count: number, name: string): string =>
  `-- Column ${index} of ${count}
${columnLines(table, name)}`;

const columnLines = (table: string, name: string): string =>
  `-- ALTER TABLE ${table} RENAME COLUMN "${name}" TO <new_name>;
-- ALTER TABLE ${table} ALTER COLUMN "${name}" SET DATA TYPE <new_type>;
-- ALTER TABLE ${table} DROP COLUMN "${name}";
-- COMMENT ON COLUMN ${table}."${name}" IS '<comment>';`;

const dropTable = (table: string): string => `-- Drop the table
-- DROP TABLE ${table};`;

const ORDERS = '"sales"."orders"';

export const ORDERS_ALTER = [
  ALTER_HEADER,
  tableLevel(ORDERS, 'id'),
  plainColumn(ORDERS, 1, 5, 'id'),
  `-- Column 2 of 5
${columnLines(ORDERS, 'customer')}
-- ALTER TABLE ${ORDERS} ADD COLUMN "customer".<new_field> <type>;
-- ALTER TABLE ${ORDERS} RENAME COLUMN "customer"."name" TO <new_name>;
-- ALTER TABLE ${ORDERS} DROP COLUMN "customer"."name";
-- ALTER TABLE ${ORDERS} RENAME COLUMN "customer"."tags" TO <new_name>;
-- ALTER TABLE ${ORDERS} DROP COLUMN "customer"."tags";`,
  plainColumn(ORDERS, 3, 5, 'attrs'),
  plainColumn(ORDERS, 4, 5, 'amount'),
  plainColumn(ORDERS, 5, 5, 'created'),
  dropTable(ORDERS),
].join('\n\n');

export const PLAIN_ALTER_AT_CREATION = [
  `${ALTER_HEADER}\n-- The tree shows snapshot @12; these statements act on the newest state.`,
  tableLevel('"main"."plain"', 'x'),
  plainColumn('"main"."plain"', 1, 2, 'x'),
  plainColumn('"main"."plain"', 2, 2, 'y'),
  dropTable('"main"."plain"'),
].join('\n\n');

const BIG_ORDERS_VIEW_TAIL = `-- Rename the view
-- ALTER VIEW "sales"."big_orders" RENAME TO <new_name>;
-- Comment on the view
-- COMMENT ON VIEW "sales"."big_orders" IS '<comment>';
-- Drop the view
-- DROP VIEW "sales"."big_orders";`;

export const BIG_ORDERS_ALTER = `-- Edit the query, then run the statement in a read/write SQL session to replace the view.
CREATE OR REPLACE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);
${BIG_ORDERS_VIEW_TAIL}`;

export const BIG_ORDERS_ALTER_AT_10 = `-- Edit the query, then run the statement in a read/write SQL session to replace the view.
-- The tree shows snapshot @10; this statement acts on the newest state.
CREATE OR REPLACE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);
${BIG_ORDERS_VIEW_TAIL}`;

export const ORDERS_DROP = `-- Drops the table. Run it in a read/write SQL session.
DROP TABLE "sales"."orders";`;

export const BIG_ORDERS_DROP = `-- Drops the view. Run it in a read/write SQL session.
DROP VIEW "sales"."big_orders";`;

export const ORDERS_DROP_AT_5 = `-- Drops the table. Run it in a read/write SQL session.
-- The tree shows snapshot @5; this statement acts on the newest state.
DROP TABLE "sales"."orders";`;

const DROP_FIRST = '-- To drop it before it is created again, remove the "-- " of the next line.';

/** The CREATE script of a table or view: the drop as a comment above the statement that Copy DDL copies. */
export const createWithDrop = (drop: string, ddl: string, ...above: string[]): string =>
  [...above, DROP_FIRST, `-- ${drop.replaceAll('\n', '\n-- ')}`, ddl].join('\n');

/** The fixed lines above a statement that copies catalog text which can start another statement or hide the rest. */
export const READ_ALL_NOTE = '-- The query below comes from the catalog: read all of it before running.';
export const COMMENTED_OUT_NOTE =
  '-- It contains ";", "--" or "/*", which can start another statement or hide a part of one, so it is commented out: remove the "-- " in front of it once you have read it.';
