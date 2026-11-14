# Schema Compare

**Schema Compare...** (`aantje.schemaCompare`) compares two tables or two schemas of the connected catalogs: in one schema, across schemas and across connections. It shows what differs and writes a script that makes one side like the other. One table at two snapshots is the job of **Compare Table at Two Snapshots...** ([Time travel](time-travel.md#compare-table-at-two-snapshots)).

## Starting

The command is in the Command Palette (**aantje: Schema Compare...**) and in the **...** menu of the view title of **DuckLake Catalogs**, right above **Info**. It is not in the context menus of the tree. Three pickers follow:

1. **Two tables** or **Two schemas**.
2. The source, the left side: the tables of every connected connection as `<connection> · <schema>.<table>`, or the schemas as `<connection> · <schema>`. The connection in use comes first.
3. The target, the right side: the same list without the source.

- Without a connected connection the command says `Connect to a catalog first to compare tables or schemas.`
- With fewer than two tables or schemas in the connected catalogs, it says so instead of opening a picker.
- Cancelling a picker does nothing.
- Each side is read at the snapshot that its tree shows. The pickers, the titles and the report name it (`@56`).
- Both sides come from the catalog through the read-only drivers: no DuckDB engine, no trust question, no data files. A progress notification with **Cancel** runs while it reads.

## Two tables

Columns match by name, the way DuckDB compares names: A to Z match in either case, other letters only themselves. The fields of a `struct`, `list` and `map` match by their path, such as `customer.since` or `tags.element`.

| Compared  | What                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| a column  | type and position; for a top-level column also `NOT NULL`, the default and the comment                              |
| the table | the comment, the partitioning (keys and transforms) and the sort order (expressions, direction, order of the NULLs) |

`NOT NULL`, the default and the comment of a field are not compared: DuckDB has none of them on a field, and DuckLake marks the fields that it adds or changes as not nullable in its catalog.

A sort expression that is a column name, bare or in double quotes, matches like a column name: `Created` and `"created"` are the same. Any other sort expression is compared as the text that DuckLake stores, so `lower(Created)` and `lower(created)` differ.

The counts go by side: the columns only in the source, the columns only in the target, and the columns whose type, `NOT NULL`, default, comment or position differs. A nested column counts with each of its fields. A renamed column cannot be told apart from one column only in the source and another only in the target; the message says so when both occur.

The command shows:

- **A diff editor** over the DDL of both sides: the `CREATE TABLE`, then the partitioning, the sort order and the comments as statements. The documents are read-only, like those of Compare Table at Two Snapshots, and the title names both sides: `lake · staging.orders @56 ↔ lake · gold.orders @12`. The statements name the table without its schema, so two equal tables show two equal documents. The diff editor opens also when nothing differs; the message then says so and has no buttons.
- **An information message** with the counts and the buttons **Script as Update** and **Swap Sides**. **Swap Sides** compares the same two tables with the sides exchanged, without reading them again. Without a difference the message has no buttons.

```text
The tables differ: 1 column only in the target, 1 only in the source, 1 type differs; the partitioning differs. A renamed column shows as one only in the source and one only in the target.
```

## Two schemas

The command opens a Markdown report in the Markdown preview, read-only (**Open Source** in the preview shows its text). It has the parts of the report of **Compare Snapshots**:

- A table of the tables, views and macros only in the source, only in the target, in both and different, and in both and equal (counted, not listed).
- The objects that one side lacks, by kind and name.
- For each table in both that differs: its columns only in the source or only in the target, its other column changes and the differences of the table. A value that differs reads from the source to the target.
- For each view or macro in both that differs: both texts, exactly as the catalog stores them, each cut after 4000 characters. A macro shows all its overloads with their parameters.

Tables and views match by name, macros by kind and name. A view or macro differs when the text that the catalog stores differs, also when both texts do the same. At most 200 tables that both schemas have are compared, in name order; the report, the message and the script say how many more there are. Every list is cut at 100 entries and 50 changes per table, with a line that counts the rest.

Then the same message as for two tables, with **Script as Update** and **Swap Sides**.

## Script as Update

**Script as Update** opens a new, unsaved SQL document bound to the target connection with the statements that make the target like the source. Nothing runs: read the script, change it and run it (**F5**) in a read/write session ([SQL editor](sql-editor.md)).

### For a table

1. `ADD COLUMN` for the columns and fields that only the source has; a field by its path, such as `"customer"."since"` or `"tags"."element"."code"`.
2. `DROP COLUMN` for the fields that only the target has.
3. `ALTER COLUMN ... TYPE` to the type of the source, when DuckLake allows that change (see below). A field changes through the type of its top-level column.
4. `SET NOT NULL` or `DROP NOT NULL`, `SET DEFAULT` or `DROP DEFAULT`.
5. `SET PARTITIONED BY` or `RESET PARTITIONED BY`, `SET SORTED BY` or `RESET SORTED BY`.
6. `DROP COLUMN` for the top-level columns that only the target has. They come after the partitioning and the sort order, because DuckLake refuses to drop a column that the table is partitioned or sorted by.
7. `COMMENT ON TABLE` and `COMMENT ON COLUMN`.

A column that the source has at another position stays where it is: DuckLake cannot move a column and adds one at the end. The script lists those columns in a comment.

### For a schema

1. `DROP VIEW` and `DROP MACRO` for the views and macros that only the target has, a view before what it reads.
2. `DROP TABLE` for the tables that only the target has.
3. The statements of each table in both that differs, as for a table.
4. `CREATE TABLE` for the tables that only the source has: the DDL of **Script as CREATE** with the options of the table, then its partitioning, sort order and comments.
5. `CREATE OR REPLACE VIEW` and `CREATE OR REPLACE MACRO` for the views and macros that the target lacks or that differ, each after what it uses.

DuckDB checks a view when it is created, so the order of step 5 matters. It comes from the dependency graph of the [Dependencies](dependencies.md) report, which DuckDB parses but never runs; for the script every view and macro is parsed, without the limit of the report, and Cancel stops it. When the graph cannot be read, the views and macros go by name and a comment says so. DuckLake does not stop a drop that a view depends on, so the drops need no such care.

The SQL of a view or macro is copied as the catalog stores it. DuckLake stores a qualified name without the catalog, such as `dev.base`. An unqualified name resolves in the schema of the view. A name qualified with a schema resolves in the lake that the script runs on:

- In one lake, `dev.base` still points to the source schema.
- Across connections, it points to a schema of that name in the target lake. When the target lake has no such schema, the statement fails.

### Safety

- Every name is quoted and qualified with the target schema; the text of a comment is a string literal.
- A comment line of the script holds fixed text, or a name in its quoted form without line breaks and control characters. A name with a line break cannot end a comment; the statement below a comment carries the name.
- A step that can lose data has a warning comment above it: `DROP COLUMN`, `DROP TABLE`, a type change, `DROP VIEW`, `DROP MACRO`, and a view or macro that replaces the one of the target.
- A statement that copies catalog text (a type, a default, a sort expression, the SQL of a view or macro) with `;`, `--` or `/*` in it is commented out under a note, as in Script as ([DDL generation](ddl.md)).
- DuckDB's tokenizer checks the rest, without running anything: each copied text has to end outside every string, quoted name and comment, and the script has to split into exactly the statements that it shows, as the SQL editor splits it. A statement that fails the check is commented out under a note.
- A statement that needs one that stays a comment is commented out too, under a note: the default, partitioning or sort order over a column whose type change stays a comment, the comment of a column whose `ADD COLUMN` stays a comment, the partitioning, sort order and comments of a table whose `CREATE TABLE` stays a comment, a `DROP COLUMN` of a column that the table stays partitioned or sorted by, and the type change of a column whose field drop stays a comment (the new type would drop the field as well). The other statements still run as written.
- The script acts on the newest state of the target. When the tree of the target shows a chosen snapshot, a comment says so, and every drop is a comment, as in [Script as DROP](ddl.md#script-as-drop): `DROP VIEW`, `DROP MACRO`, `DROP TABLE` and `DROP COLUMN`, of a field too. The script names the objects of the target as they are at that snapshot; since then an object may have been renamed and another may have taken its name, so a live drop could hit the wrong object and lose its data. Each drop stands under its warning and the note of Script as DROP (`dropsAtSnapshot` in `src/ddl-script/statements.ts`):

  ```sql
  -- Warning: this drops a table and the data in it.
  -- The tree shows snapshot @29, but a statement acts on the newest state, where the name may belong to another object now.
  -- Check the name at the newest snapshot before you remove the "-- ".
  -- DROP TABLE "prod"."old_table";
  ```

## What DuckLake accepts

Checked with DuckDB 2.0.0 and its ducklake extension. The script writes the forms that DuckLake accepts and turns the others into a comment with the reason.

| Statement                                    | DuckLake 2.0                                                                                                                                                                     |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADD COLUMN` of a top-level column           | Yes. A default must be a literal, so the script adds the column and sets an expression default afterwards; `NOT NULL` without a default only works on a table without rows.      |
| `ADD COLUMN` of a field                      | Yes, also in a list (`"l"."element"."f"`) and in a map value (`"m"."value"."f"`).                                                                                                |
| `DROP COLUMN`                                | Yes, also of a field; not the last column, and not a column that the table is partitioned or sorted by.                                                                          |
| `ALTER COLUMN ... TYPE`                      | Only to a wider type, without `USING`. A field only through the type of its top-level column, `ALTER COLUMN "s" TYPE STRUCT(...)`, which also adds and drops fields by name.     |
| `SET NOT NULL`, `DROP NOT NULL`              | On a top-level column; `SET NOT NULL` fails while the column holds NULL values.                                                                                                  |
| `SET DEFAULT`, `DROP DEFAULT`                | On a top-level column, with any expression.                                                                                                                                      |
| `COMMENT ON TABLE`, `COMMENT ON COLUMN`      | Yes, `IS NULL` too; not on a field.                                                                                                                                              |
| `SET PARTITIONED BY`, `RESET PARTITIONED BY` | On top-level columns, with `year`, `month`, `day`, `hour`, `epoch_year`, `epoch_month`, `epoch_day`, `epoch_hour` and `bucket(N, column)`. No `identity(...)` and no `truncate`. |
| `SET SORTED BY`, `RESET SORTED BY`           | Expressions over top-level columns with `ASC` or `DESC` and `NULLS FIRST` or `NULLS LAST`.                                                                                       |
| moving a column                              | No statement exists.                                                                                                                                                             |
| `RENAME COLUMN`, `RENAME TO`                 | Yes, but the script writes none: between two tables a rename looks like a removed and an added column.                                                                           |

The type changes that the script writes, by the DuckDB names of the types:

| From                                           | To                                                                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `BOOLEAN`                                      | every integer type                                                                                             |
| `TINYINT`, `SMALLINT`, `INTEGER`, `BIGINT`     | a wider signed integer, `FLOAT`, `DOUBLE`, a `DECIMAL` with 3, 5, 10 or 19 digits before the point             |
| `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT` | a wider unsigned or signed integer, `FLOAT`, `DOUBLE`, a `DECIMAL` with 3, 5, 10 or 20 digits before the point |
| `HUGEINT`, `UHUGEINT`                          | `FLOAT`, `DOUBLE`                                                                                              |
| `FLOAT`                                        | `DOUBLE`                                                                                                       |
| `DECIMAL(p,s)`                                 | `FLOAT`, `DOUBLE`, `DECIMAL(p2,s2)` with `s2 >= s` and `p2 - s2 >= p - s`                                      |
| `DATE`                                         | `TIMESTAMP`, `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS`, `TIMESTAMPTZ`                                      |
| `TIMESTAMP_S`                                  | `TIMESTAMP`, `TIMESTAMP_MS`, `TIMESTAMP_NS`, `TIMESTAMPTZ`                                                     |
| `TIMESTAMP_MS`                                 | `TIMESTAMP`, `TIMESTAMP_NS`, `TIMESTAMPTZ`                                                                     |
| `TIMESTAMP`                                    | `TIMESTAMP_NS`, `TIMESTAMPTZ`                                                                                  |

DuckLake accepts a few more, after which reading the table can fail or lose digits, so the script keeps them as a comment: any type to `JSON` (text that is no JSON cannot be read back), `HUGEINT` or `UHUGEINT` to a `DECIMAL`, a `BIGINT` or `UBIGINT` to a `DECIMAL(38,s)` with too few digits before the point, and a `DECIMAL` to a `DECIMAL(38,s)` with a smaller scale. `test/unit/schema-compare-lake.test.ts` runs every change of the table above on the engine and reads the values back.

## Examples

Two tables: `staging.orders` on the left and `gold.orders` on the right. `note` is `VARCHAR` on the left and `INTEGER` on the right, and `amount` comes before `note` on the left only.

```sql
-- Script as Update: makes the table on the right (target) like the table on the left (source). Nothing has run: read the statements, change what you need and run them in a read/write SQL session.
-- Source: lake · "staging"."orders" @29. Target: lake · "gold"."orders" @29.

ALTER TABLE "gold"."orders" ADD COLUMN "customer"."since" DATE;
ALTER TABLE "gold"."orders" ADD COLUMN "kind" VARCHAR;
-- Warning: this drops a column and the data in it.
ALTER TABLE "gold"."orders" DROP COLUMN "customer"."score";
-- Warning: this changes the type of a column; DuckLake reads the stored values as the new type, which can lose precision.
ALTER TABLE "gold"."orders" ALTER COLUMN "id" TYPE BIGINT;
-- Warning: this changes the type of a column; DuckLake reads the stored values as the new type, which can lose precision.
ALTER TABLE "gold"."orders" ALTER COLUMN "customer" TYPE STRUCT("name" VARCHAR, "level" BIGINT, "since" DATE);
-- Warning: this changes the type of a column; DuckLake reads the stored values as the new type, which can lose precision.
ALTER TABLE "gold"."orders" ALTER COLUMN "amount" TYPE DECIMAL(12,2);
-- Not changed: DuckLake changes a column only to a wider type (INTEGER to BIGINT, DATE to TIMESTAMP and the like), and this change is not one. The statement is left as a comment.
-- ALTER TABLE "gold"."orders" ALTER COLUMN "note" TYPE VARCHAR;
-- Warning: this changes the type of a column; DuckLake reads the stored values as the new type, which can lose precision.
ALTER TABLE "gold"."orders" ALTER COLUMN "created" TYPE TIMESTAMP;
-- SET NOT NULL fails while the column holds NULL values.
ALTER TABLE "gold"."orders" ALTER COLUMN "id" SET NOT NULL;
ALTER TABLE "gold"."orders" ALTER COLUMN "amount" SET DEFAULT 0;
ALTER TABLE "gold"."orders" SET PARTITIONED BY ("kind");
-- The sort expressions come from the catalog: read them before running.
ALTER TABLE "gold"."orders" SET SORTED BY (created DESC NULLS LAST);
-- Warning: this drops a column and the data in it.
ALTER TABLE "gold"."orders" DROP COLUMN "legacy";
COMMENT ON TABLE "gold"."orders" IS 'Orders, cleaned';
COMMENT ON COLUMN "gold"."orders"."amount" IS 'Net amount';
-- DuckLake cannot move a column, so these keep another position than in the source: "amount".
```

Two schemas: `dev` on the left and `prod` on the right. `a_top` reads `z_view`, which reads the new table `a_base`, and `b_uses_macro` calls `m_new`; `prod_only_view` reads `old_table`.

```sql
-- Script as Update: makes the schema on the right (target) like the schema on the left (source). Nothing has run: read the statements, change what you need and run them in a read/write SQL session.
-- Source: lake · "dev" @29. Target: lake · "prod" @29.

-- Warning: this drops a view.
DROP VIEW "prod"."prod_only_view";
-- Warning: this drops a macro with all its overloads.
DROP MACRO "prod"."prod_macro";
-- Warning: this drops a table and the data in it.
DROP TABLE "prod"."old_table";

ALTER TABLE "prod"."shared" ADD COLUMN "x" INTEGER;

CREATE TABLE "prod"."a_base" (
  "id" INTEGER,
  "v" VARCHAR
);
ALTER TABLE "prod"."a_base" SET PARTITIONED BY ("v");
COMMENT ON TABLE "prod"."a_base" IS 'Base';

CREATE OR REPLACE VIEW "prod"."z_view" AS SELECT id FROM a_base;
CREATE OR REPLACE VIEW "prod"."a_top" AS SELECT * FROM z_view;
CREATE OR REPLACE MACRO "prod"."m_new"("x") AS (x + 1);
CREATE OR REPLACE VIEW "prod"."b_uses_macro" AS SELECT m_new(1) AS r;
-- Warning: this replaces the definition that the target has.
CREATE OR REPLACE VIEW "prod"."diff_view" AS SELECT 1 AS one;
-- Warning: this replaces the definition that the target has.
CREATE OR REPLACE MACRO "prod"."diff_macro"("x") AS (x - 1);
```

## Known limits

- A renamed column is dropped and added again, which loses its data. Rename it by hand before you run the script.
- A column stays at its position, and a type change that is not a widening stays a comment.
- A view that reads a table whose `CREATE TABLE` stays a comment fails when it is created.
- While the tree of the target shows a chosen snapshot, a table or view that takes the name of a view or table that only the target has fails when it is created: the drop of that one stays a comment.
- Tags other than the comment, the options of a table that both sides have, and the data are not compared.
- At most 200 tables that both schemas have are compared.
- A view or macro is compared as text: two texts that do the same differ.
