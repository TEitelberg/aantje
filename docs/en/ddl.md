# DDL generation

`src/catalog/ddl.ts` turns catalog metadata into SQL text: **Copy DDL** for tables and views, **Copy Qualified Name** for schemas, tables, views and columns, and the **Script as** submenu, which opens scripts in an editor. **Generate Scripts...** in the same submenu scripts a schema or the whole lake at once ([Generate Scripts](#generate-scripts)). Scripts are text; the commands never execute anything. The module is pure: no I/O, no `vscode`, no DuckDB at run time. The commands reach it through `src/actions.ts`; the script templates live in `src/script-templates.ts` and `src/script-templates/`.

## The Script as submenu

The submenu **Script as** (group `2_script` of the context menu) has **SELECT**, **INSERT** (a table only), **CREATE**, **ALTER** and **DROP**, and on an open connection and a schema **Generate Scripts...**. A node shows only the entries it has a script for. Each opens a new untitled SQL document. The commands (`aantje.scriptSelect`, `scriptInsert`, `scriptCreate`, `scriptAlter`, `scriptDrop`, `generateScripts`) are hidden from the Command Palette because they need a node.

- **The document belongs to the connection of the node**, as after **New Query** (`src/sql/editor.vscode.ts`). F5 and Ctrl+Enter run it there, and completion knows its catalog. Opening is not running: no session starts until the first run, and in a read-only connection even the run is refused ([SQL editor](sql-editor.md)).
- **Script as CREATE** on a table or view opens the text of Copy DDL with the matching `DROP` as a comment above. For a table, partitioning, sort order and comments follow as commented statements, because DuckLake has no `CREATE TABLE` clause for them. The options of the table that DuckLake documents (see [Table options](#table-options)) are the exception: they are part of the statement as `WITH (...)`.
- **Script as SELECT** on a table lists every top-level column at the shown snapshot, one per line. For a view, and for a table with no columns at that snapshot, it selects `*`: the catalog has no typed columns for a view, and this command must neither start DuckDB nor ask for view trust.
- **Time travel.** With a pinned snapshot, SELECT gets `AT (VERSION => <n>)` and a comment naming the snapshot (also when the pinned one is the latest). INSERT, DROP and ALTER cannot time travel, because a statement that changes the lake acts on its newest state; they say so in a comment, and DROP writes its statements as comments then ([Script as DROP](#script-as-drop)).
- **Names.** Comments hold a snapshot number only, never a catalog name. Every name goes through `quoteIdentifier` or `qualifiedName`, so a hostile name (quotes, line breaks, `--`, `;`) stays inside its identifier. Names are not prefixed with a catalog; run the script where the lake is the default catalog (`USE lake;`) or add the prefix.
- **Closed connection.** A script that needs the reader fails with `The connection is closed. Connect again to script the <VERB>.` and opens nothing. Scripts that need no reader (DROP of a table, view or schema, column scripts other than SELECT, the ALTER of a view, schema templates) still work.

For `sales.orders` while the tree shows snapshot 5:

```sql
-- Time travel to snapshot 5
SELECT
  "id",
  "customer",
  "attrs",
  "amount",
  "created"
FROM "sales"."orders" AT (VERSION => 5)
LIMIT 1000;
```

## Table options

DuckLake stores options per table (`ALTER TABLE ... SET (...)`, `CREATE TABLE ... WITH (...)`, `set_option` with `table_name`). The table template of **Script as ALTER** has a block for them: for every option that can be set for a table, a note with its default, a `SET (option = value)` and a `RESET (option)` statement, all commented out. `RESET` removes the override of the table, so that the value of the schema, the lake or the default applies. The same list is behind **Maintenance > Set Option** ([Maintenance scripts](maintenance.md#set-option)); the options that are global only are not offered.

**Script as CREATE** reads the rows of `ducklake_metadata` (`reader.metadata()`) and writes the options that are set for the table as `WITH (...)` behind the column list. DuckLake stores a size in bytes, `parquet_version` as `V2` and the columns of `skip_stats_columns` as ids, so the clause shows `'1000000B'`, `2` and `['a', 'c']`, which the statement accepts. Options are not versioned: with an older snapshot pinned, the script still shows the options as they are now, and a column of `skip_stats_columns` that the snapshot does not have is left out. A table without options has no `WITH`. **Copy DDL** does not add the clause.

```sql
CREATE TABLE "sales"."orders" (
  "id" INTEGER
) WITH (target_file_size = '1000000B', auto_compact = false);
```

## Script as INSERT

**Script as INSERT** on a table opens one row to insert (`insertTable`, `src/script-templates/table.ts`). For `sales.orders`:

```sql
-- Inserts one row. Replace the <placeholders>; a column with a default can be left out of both lists. Run it in a read/write SQL session.
INSERT INTO "sales"."orders" ("id", "customer", "attrs", "amount", "created")
VALUES (
  <"id" INTEGER NOT NULL>,
  <"customer" STRUCT("name" VARCHAR, "tags" VARCHAR[])>,
  <"attrs" MAP(VARCHAR, INTEGER)>,
  <"amount" DECIMAL(10,2) DEFAULT 0>,
  <"created" TIMESTAMP>
);
```

- **One placeholder per column**, in the order of the table: the column as `CREATE TABLE` defines it, with its type (nested types as DuckDB writes them), its default and `NOT NULL`. The name in the placeholder is quoted like the one in the column list, so a `;` or `--` in a name stays inside its identifier. The statement does not run until every placeholder is replaced.
- **The newest snapshot.** An insert writes to the newest state, so the script has the name and the columns of the table at the newest snapshot the tree knows (Refresh moves it). With an older snapshot pinned, a comment says so (`-- The tree shows snapshot @5; this statement acts on the newest state and has the columns of snapshot @7.`). A table that was renamed since gets its new name; for one that is no longer there the script is a comment that says so.
- **Catalog text.** Defaults and unknown types are copied as they are. If one contains `;`, `--` or `/*`, the statement is written as a comment, as for Script as CREATE.

## Script as DROP

The script is `DROP TABLE <name>;` or `DROP VIEW <name>;` under a comment line (`-- Drops the table. Run it in a read/write SQL session.`):

```sql
-- Drops the table. Run it in a read/write SQL session.
DROP TABLE "sales"."orders";
```

- **No `IF EXISTS`.** The script is made for an object the tree shows. With `IF EXISTS`, a wrong schema or lake would end without an error and the user would think the object is gone.
- **The kind decides the keyword.** `DROP TABLE` on a view is an error in DuckDB, so the statement cannot drop what the user did not choose.
- **It acts on the newest state.** A dropped object disappears from the newest snapshot; older snapshots still show it until they are expired and cleaned up.
- **A comment while the tree is pinned to a snapshot.** The script names the object as it is at the snapshot the tree shows, but the drop acts on the newest state. Since that snapshot the object may have been renamed and another may have taken its name, so a live drop could hit the wrong object and lose its data. With a pinned snapshot, every statement of a Script as DROP is therefore a comment, under a note that names the snapshot and asks to check the name at the newest snapshot before removing the `-- ` (`dropsAt` in `src/script-templates/common.ts`). This holds for every node, the `RESET` of the Partitioning and Sort Order folders included. For the table above, with the tree at snapshot 5:

  ```sql
  -- Drops the table. Run it in a read/write SQL session.
  -- The tree shows snapshot @5, but a statement acts on the newest state, where the name may belong to another object now.
  -- Check the name at the newest snapshot before you remove the "-- ".
  -- DROP TABLE "sales"."orders";
  ```

- **Check dependents first.** DuckLake does not stop a drop that views or macros depend on; they fail at their next use. The [Dependencies](dependencies.md) report lists them under **Used by**, up to five levels. Its key figure **Used by** counts all of them, at any depth.
- Macros, columns and schemas have the same live statement and comments (a schema adds a `CASCADE` form as a comment).
- **Not the schema `main`.** On `main`, the default schema of the lake, Script as DROP is shown but disabled, and the list of the connection leaves it out. DuckDB refuses to drop `main` in its own databases; DuckLake drops it and leaves a lake without a default schema. Whoever drops it with their own SQL can, and aantje keeps working on such a lake.

## Script as ALTER

**A view** gets `CREATE OR REPLACE VIEW <name> [(<aliases>)] AS <sql>;` with the stored SQL, under a comment asking to edit the query, then commented rename, comment and drop statements. A view stored in another SQL dialect gets two warning lines (`viewScript`), because running the script would replace it with a DuckDB view.

```sql
-- Edit the query, then run the statement in a read/write SQL session to replace the view.
CREATE OR REPLACE VIEW "sales"."big_orders" AS SELECT * FROM sales.orders WHERE (amount > 1);
-- Rename the view
-- ALTER VIEW "sales"."big_orders" RENAME TO <new_name>;
-- Comment on the view
-- COMMENT ON VIEW "sales"."big_orders" IS '<comment>';
-- Drop the view
-- DROP VIEW "sales"."big_orders";
```

**A table** gets a template in which every statement is a comment, so running it changes nothing (`alterTableTemplate`, `src/script-templates/table.ts`). The user removes the `-- ` in front of the statements they want, replaces the `<placeholders>` and runs them. The template has blocks for the table (add a column, rename, comment, partitioning, sort order, options), one per column (rename, change type, drop, comment) and per struct field below it (rename, drop, add field), and a final `DROP TABLE`. Block headers have numbers only (`Column 2 of 5`), because a name in a comment would be catalog text.

```sql
-- Column 2 of 5
-- ALTER TABLE "sales"."orders" RENAME COLUMN "customer" TO <new_name>;
-- ALTER TABLE "sales"."orders" ALTER COLUMN "customer" SET DATA TYPE <new_type>;
-- ALTER TABLE "sales"."orders" DROP COLUMN "customer";
-- COMMENT ON COLUMN "sales"."orders"."customer" IS '<comment>';
-- ALTER TABLE "sales"."orders" ADD COLUMN "customer".<new_field> <type>;
-- ALTER TABLE "sales"."orders" RENAME COLUMN "customer"."name" TO <new_name>;
-- ALTER TABLE "sales"."orders" DROP COLUMN "customer"."name";
```

The template offers only what DuckLake 2.0 accepts, checked against a real lake:

- Works: add, rename and drop a column; rename a table or view; rename and drop struct fields and add fields at any depth; widen a column type (`INTEGER` to `BIGINT`, `FLOAT` to `DOUBLE`; other changes fail with `only widening type promotions are allowed`); `SET`/`RESET PARTITIONED BY` and `SORTED BY` for top-level columns; `COMMENT ON` for tables, views and top-level columns (`IS NULL` clears).
- Refused or not offered: changing the type of a nested field, `ALTER TABLE ... SET SCHEMA`, `ALTER SCHEMA` (a schema has no ALTER script), comments on schemas, macros and struct fields, partitioning on a nested column. `SET DEFAULT` and `NOT NULL` changes run but are left out of the template.
- A struct inside a list or a map is addressed through `"element"`, `"key"` or `"value"`. The element, key and value themselves have no name to rename or drop.

**Hostile names.** A quoted name may contain a line break, which would end a comment and let the rest run as SQL. Every line of a commented statement therefore gets its own `-- `, including the lines a line break inside a name creates. Removing the `-- ` from every line gives the statement back unchanged.

## Scripts for macros

A macro is the only function kind DuckLake stores. It is SQL: a scalar macro is an expression, a table macro a query, and each can have several overloads with their own parameters. A macro node has all four verbs.

- **CREATE and ALTER** write `CREATE OR REPLACE MACRO <schema>.<name>(<parameters>) AS <body>;` (`macroDdl`). CREATE has the drop as a comment above, ALTER a comment asking to edit it and the drop below. With a pinned snapshot they show the older definition and note that the statement acts on the newest state.
- **SELECT** is a call: `SELECT <macro>(<arg1>, <arg2>);` or, for a table macro, `SELECT * FROM <macro>(<arg1>) LIMIT 1000;`. It uses the first overload, with a `<argN>` placeholder for each parameter without a default (parameter names are catalog text and never appear) and the other overloads as comments. A macro cannot be read at an older snapshot.
- **Parameters** are quoted names with the declared type as DuckDB names it, and a default as `:= <expression>`. The reader hands the default over as a SQL expression that returns the stored value with its type.
- **The body is the stored one.** DuckDB normalises it when it stores the macro (`x + 1` becomes `(x + 1)`).
- **Overloads are one statement.** `CREATE OR REPLACE` replaces the macro with all overloads, so the statement lists them all: `(x) AS ..., (x, y) AS ...`. Table macro queries are parenthesised when there are several. The statement always writes DuckDB overloads.
- **DROP** is `DROP MACRO <name>;`, and `DROP MACRO TABLE <name>;` for a table macro, because a scalar and a table macro can share a name and the plain form drops the scalar one. No `IF EXISTS`.
- **History.** `CREATE OR REPLACE` ends the old macro at the new snapshot, so the tree at an older snapshot still shows the old definition.

```sql
CREATE OR REPLACE MACRO "shop"."gross"("net", "rate" := 1.19) AS (net * rate);
CREATE OR REPLACE MACRO "s"."f"("x") AS (x + 1), ("x", "y") AS (x + y);
DROP MACRO TABLE "shop"."recent_events";
```

The **Macros** folder is shown under every schema, also when empty (hint `No macros.`). Its SELECT lists a call of each macro (calls that need arguments as comments), its DROP a commented `DROP MACRO` each, and its CREATE a template with two examples that run as they are.

## Generate Scripts

**Generate Scripts...** in the **Script as** submenu of an open connection or a schema scripts its tables, views and macros in one go, in an order that works (`src/generate-scripts/`). Script as CREATE stays as it is.

1. A picker lists the tables, views and macros of the connection, or of the schema, as `<schema>.<name>` with the kind as description. All are selected. The schemas follow from the selection.
2. A second picker offers **One SQL document** or **One file per object**, which then asks for a folder.

The command reads at the snapshot the tree shows, from the catalog with the read-only drivers: no DuckDB engine for the reads, no trust confirmation, no data files. As in [Schema Compare](compare.md), an in-memory DuckDB with nothing attached parses the views and macros for their order and tokenizes the script; it runs nothing.

### What the script holds

Structure only: no data and no `DROP`.

- **Header.** It names the snapshot. Comments hold the snapshot number, never the name of the catalog.
- **Schemas.** `CREATE SCHEMA IF NOT EXISTS` for every schema of the selection.
- **Tables**, by schema and name: the DDL of Script as CREATE, with defaults, `NOT NULL` and the table options (`WITH (...)`). Partitioning, sort order and the comments of the table and its columns follow as live statements (`ALTER TABLE ... SET PARTITIONED BY`, `SET SORTED BY`, `COMMENT ON`), not as comments, because this script is meant to rebuild. They are the statements that Script as Update writes for a new table.
- **Views and macros**, each after everything it reads or calls, by the graph of the [Dependencies](dependencies.md) report: `CREATE VIEW` with the SQL the catalog stores and its `COMMENT ON VIEW`, and `CREATE MACRO` with every overload. DuckDB binds a view and a macro when it creates them, so a view must follow the view it reads, and a macro must come before the view or macro that calls it. A view or macro stored in another SQL dialect stays in that dialect, as in Copy DDL, under a comment.
- **What the graph cannot order** comes last under a comment: views and macros that use each other in a cycle, whose SQL has a part the analysis does not follow (another dialect, a syntax error, a dynamic name), and those that use one of them. Without the graph, all views and macros come there.
- **Selection.** A selected view or macro that uses an object that is not selected gets a comment above it that names the object (`commentName`, on one line).
- **Names** are quoted and have no catalog prefix, as in Script as. Run the script where the lake that gets the objects is the default catalog.
- **Catalog text** (view SQL, macro bodies, parameter types and defaults, column defaults and types, sort expressions) goes through the check of Script as Update (`checkedScript`). DuckDB's tokenizer checks that each copied text ends outside every string, quoted name and comment, and that the script splits into exactly the statements it shows. A statement that fails becomes a comment under a note, and so does what needs it: the layout and comments of a table whose `CREATE TABLE` stays a comment, the comment of such a view. Comments are written as string literals.
- **Tags.** DuckLake 2.0 has no SQL statement for tags other than the comment: there is no `SET TAG` clause and no tag function, and `ALTER TABLE ... SET (...)` and `ducklake_set_option` refuse unknown names. `COMMENT ON` works for tables, columns and views, not for schemas and macros. So the script writes the comments only.

For a schema `shop` with a table, a macro and two views:

```sql
-- Generate Scripts: the structure of the selected tables, views and macros at snapshot 11, without data. Nothing has run: read the statements, then run them in a read/write SQL session.
-- The names have no catalog prefix: run the script where the lake that gets the objects is the default catalog (USE lake;).

CREATE SCHEMA IF NOT EXISTS "shop";

CREATE TABLE "shop"."orders" (
  "id" BIGINT NOT NULL,
  "amount" DECIMAL(12,2) DEFAULT 0,
  "kind" VARCHAR,
  "created" TIMESTAMP
) WITH (auto_compact = false);
ALTER TABLE "shop"."orders" SET PARTITIONED BY ("kind");
-- The sort expressions come from the catalog: read them before running.
ALTER TABLE "shop"."orders" SET SORTED BY (created DESC NULLS LAST);
COMMENT ON TABLE "shop"."orders" IS 'Customer orders';
COMMENT ON COLUMN "shop"."orders"."amount" IS 'Net amount in EUR';

CREATE MACRO "shop"."net"("x") AS (x * 0.81);

CREATE VIEW "shop"."net_orders" AS SELECT id, net(amount) AS net FROM orders;
COMMENT ON VIEW "shop"."net_orders" IS 'Net amounts';

CREATE VIEW "shop"."big_net" AS SELECT * FROM net_orders WHERE (net > 100);
```

### One SQL document

A new untitled SQL document bound to the connection, as Script as. Nothing runs.

### One file per object

The files go below the chosen folder:

```text
create-all.sql               every statement in the working order, with the header
<schema>/tables/<name>.sql
<schema>/views/<name>.sql
<schema>/macros/<name>.sql
```

- An object file holds the notes and statements of its object only, without the header. So a file changes only when its object changes, and a Git diff shows what changed. `create-all.sql` runs the folder as a whole.
- UTF-8 without BOM, `\n` line ends, and a line end at the end of each file. Catalog text is copied unchanged.
- **File names come from catalog names**, which are data of whoever writes the catalog (`src/generate-scripts/files.ts`). The characters that a file name cannot hold (`/ \ : * ? " < > |`), control and format characters and line separators become `_`. So do dots at the start (no hidden file, no `.` or `..`) and dots and spaces at the end, which Windows drops. A reserved Windows name (`CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9`, `LPT1` to `LPT9`, also with an extension) gets a `_` behind it, and a name longer than 120 bytes is cut.
- **No collisions.** Two objects that end up with the same name in one folder get a suffix, `orders.sql` and `orders~2.sql`, by name. Names that differ only in case count as the same, because Windows and macOS ignore case. A schema folder never takes the name `create-all.sql`.
- **Inside the folder.** Every path is checked to stay below the chosen folder. Nothing is written through a symbolic link: when a path below the folder is one, or is a file where a folder belongs (or the other way round), the run stops before it writes anything.
- **Existing files.** When files exist, one question for the whole run asks whether to overwrite them. Files that no selected object matches stay. The closing message lists the `.sql` files below the schema folders of the run that no object matches, so that a dropped object can be removed by hand.

## The scripts by node kind

The matrix is data: `SCRIPTS` in `src/script-templates.ts` maps the `contextValue` of a tree node to the generators of its verbs, and `scriptOf(verb, tree, ref)` returns `undefined` when a kind has no script. The conditions of the menu entries in `package.json` follow the same context values.

| Node                                                        | SELECT                                                                  | CREATE                                                 | ALTER                                 | DROP                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------- | -------------------------------------------------------------- |
| Connection (open)                                           | Schemas, tables, views, macros, snapshots                               | Templates: schema, table, view, two macros             | none                                  | Commented `DROP SCHEMA` per schema but `main`                  |
| Schema                                                      | A query per table, then per view                                        | Templates: table, view, two macros                     | none                                  | `DROP SCHEMA` live, `CASCADE` as a comment; disabled on `main` |
| Tables, Views, Macros folder                                | A query or call per object                                              | Template for one new object                            | none                                  | Commented drop per object                                      |
| Table                                                       | Every column                                                            | DDL, drop above, layout and comments as comments       | Template                              | `DROP TABLE` live                                              |
| View                                                        | `*`                                                                     | DDL, drop above                                        | `CREATE OR REPLACE VIEW`, rename, ... | `DROP VIEW` live                                               |
| Macro                                                       | A call per overload                                                     | `CREATE OR REPLACE MACRO`, drop above                  | Same statement, drop as a comment     | `DROP MACRO` live                                              |
| Columns folder of a table                                   | Every column                                                            | Template: `ADD COLUMN`                                 | Add a column, block per column        | Commented `DROP COLUMN` per column                             |
| Column or struct field                                      | The column, or the field through its structs                            | `ADD COLUMN`, drop above                               | Rename, type, drop, comment, fields   | `DROP COLUMN` live                                             |
| Element of a list, key or value of a map                    | The column that holds it                                                | none                                                   | Fields of a struct inside it          | none                                                           |
| Partitioning, Sort Order folder                             | Every column of the table                                               | `SET PARTITIONED BY` / `SORTED BY` as now, reset above | Template                              | `RESET ...` live                                               |
| Tags folder                                                 | Every column of the table                                               | none                                                   | `COMMENT ON` for table and columns    | `COMMENT ON ... IS NULL`, commented                            |
| Statistics, History leaf, Snapshots, snapshot, table change | `ducklake_table_info`, `ducklake_table_changes` or `ducklake_snapshots` | none                                                   | none                                  | none                                                           |
| Columns folder or column of a view                          | `*`, or the column                                                      | none                                                   | none                                  | none                                                           |

Rules behind the matrix:

- **Elements and containers.** On an element the script is the statement for it. On a container (connection, schema, folder) it is a template for a new child, a list of ready queries, or a list of drops.
- **Safety.** The DROP of one object is live while the tree follows the newest snapshot; with a pinned snapshot it is a comment ([Script as DROP](#script-as-drop)). A script that could drop several objects is made of comments only, so running it changes nothing.
- **Every script that creates or alters contains its DROP:** as a comment above the statement in CREATE, as the last block in ALTER. A template for a new object ends with the commented drop of the placeholder object.
- **Templates run as they are** in a read/write session, with defaults such as `CREATE TABLE "s"."new_table" ("id" BIGINT, "name" VARCHAR);`. A `<placeholder>` appears only where the user must supply something.
- **Default schema of connection templates** is `main` if it exists, else the first schema by name, else `new_schema`, which the first block of the same script creates.
- **Lists are cut at twenty** objects and end with `-- N more are not listed.`
- **One script on the connection**, not six entries: CREATE is one document with a block each for a schema, table, view and the two macros.
- **Generate Scripts...** on a connection or a schema is not part of the matrix: it scripts the objects that exist, not a template ([Generate Scripts](#generate-scripts)).
- **Catalog text in a statement.** Names go through `quoteIdentifier`. A few fragments are copied as they are: macro bodies, parameter defaults and types, defaults and unknown types of a column, and view queries. If such a fragment contains `;`, `--` or `/*`, the statement is written as a comment, so it cannot start a second statement.
- **Script as CREATE for a column** is `ALTER TABLE ... ADD COLUMN ...` with the default and `NOT NULL` of a top-level column (a struct field gets its type only). DuckLake adds a column with a literal default only; for an expression such as `now()` the script adds the column and sets the default in a second statement.
- **List elements and map keys and values** have the context value `column.member`: they have no name to create or drop, so only SELECT and ALTER are offered.
- **INSERT** is offered on a table only, so the matrix has no column for it ([Script as INSERT](#script-as-insert)).
- **Not offered:** what DuckLake cannot do (see above), and UPDATE or DELETE templates.
- **A pinned snapshot** adds `AT (VERSION => n)` to queries over tables and views, `snapshot_version => n` to the file list, and the newest-state note to every script that changes the lake or reads something DuckLake keeps only for the newest state. Script as DROP gets a note of its own instead and writes every statement as a comment.

## Generated format

`sales.orders` of the fixture catalog (struct with a nested list, map, decimal with default, `NOT NULL` column) and a view with a column list:

```sql
CREATE TABLE "sales"."orders" (
  "id" INTEGER NOT NULL,
  "customer" STRUCT("name" VARCHAR, "tags" VARCHAR[]),
  "attrs" MAP(VARCHAR, INTEGER),
  "amount" DECIMAL(10,2) DEFAULT 0,
  "created" TIMESTAMP
);
CREATE VIEW "sales"."totals" ("order_id", "total") AS SELECT id, amount FROM sales.orders;
```

- Every identifier is quoted, including struct field names and view aliases.
- One column per line, indented by two spaces: `"name" TYPE`, then `DEFAULT <expression>`, then `NOT NULL`.
- Nested types are rebuilt from `ColumnInfo.children`: a struct from its fields, a list from its element, a map from key then value, at any depth.
- Only top-level columns carry `NOT NULL` and `DEFAULT`; a DuckDB type has no place for them inside a struct, list or map.
- A view is `CREATE VIEW <name> [(<aliases>)] AS <sql>;`; the alias list appears only when `columnAliases` is not empty.

## Type mapping

DuckLake stores type names in `ducklake_column.column_type`. The module spells out the DuckDB type instead of passing the name through: the DuckDB alias `INT8` is a 64-bit `BIGINT`, whereas the DuckLake `int8` is 8 bits wide.

| DuckLake type                                    | DuckDB SQL type                                            |
| ------------------------------------------------ | ---------------------------------------------------------- |
| `boolean`                                        | `BOOLEAN`                                                  |
| `null`                                           | `"NULL"` (DuckDB spells it with quotes)                    |
| `int8`, `int16`, `int32`, `int64`, `int128`      | `TINYINT`, `SMALLINT`, `INTEGER`, `BIGINT`, `HUGEINT`      |
| `uint8`, `uint16`, `uint32`, `uint64`, `uint128` | `UTINYINT`, `USMALLINT`, `UINTEGER`, `UBIGINT`, `UHUGEINT` |
| `float32`, `float64`                             | `FLOAT`, `DOUBLE`                                          |
| `decimal(P,S)`                                   | `DECIMAL(P,S)` (`decimal(10, 2)` is accepted, too)         |
| `time`, `time_ns`, `timetz`                      | `TIME`, `TIME_NS`, `TIME WITH TIME ZONE`                   |
| `date`, `interval`                               | `DATE`, `INTERVAL`                                         |
| `timestamp`, `timestamptz`, `timestamptz_ns`     | `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, `TIMESTAMPTZ_NS`  |
| `timestamp_s`, `timestamp_ms`, `timestamp_ns`    | `TIMESTAMP_S`, `TIMESTAMP_MS`, `TIMESTAMP_NS`              |
| `varchar`, `blob`, `json`, `uuid`                | `VARCHAR`, `BLOB`, `JSON`, `UUID`                          |
| `variant`, `geometry`                            | `VARIANT`, `GEOMETRY`                                      |
| `struct`, `list`, `map`                          | `STRUCT("field" TYPE, ...)`, `TYPE[]`, `MAP(KEY, VALUE)`   |

A type not in the table passes through unchanged (for example one a later DuckLake adds); DuckDB may then reject it, which is better than hiding the column. The statements target DuckDB 2.0. `variant`, `geometry`, `time_ns` and `timestamptz_ns` need a DuckDB that knows them. DuckDB 2.0 refuses `ENUM`, `UNION`, `BIT` and fixed-size `ARRAY` columns in DuckLake, so they have no entry.

## Limits

- Copy DDL describes columns only. Script as CREATE of a table adds the table options as `WITH`, and partitioning, sort order and comments as commented statements; the comments of nested fields and tags other than the comment cannot be written, because DuckLake has no SQL statement for them.
- The statement is not idempotent: no `IF NOT EXISTS`, no `OR REPLACE` except for macros, and the CREATE of a table does not create its schema (the connection template does).
- DuckDB dialect only. View SQL is copied as stored and not parsed; a view another engine stored in its own dialect (`ViewInfo.dialect`) stays in that dialect and DuckDB may reject it. Unqualified names in the view resolve against the default schema of the session that runs it.
- Nullability and defaults of nested fields are dropped, because a DuckDB type cannot express them.
- Default expressions, unknown type names and view SQL come from the catalog and are copied verbatim. A catalog written by someone else can make the clipboard text contain more than one statement, so read the DDL before you run it. Script as CREATE and the ALTER of a view open the same text in an editor.
- The ALTER template covers top-level columns and struct fields. It has no statements for defaults and nullability. A table cannot move to another schema.
- A lake without a schema `main` cannot be the default catalog (`USE lake` fails). The SQL session then uses the first schema by name (`USE lake.<schema>`); a lake without any schema cannot be opened by the session. Python cells of a notebook still run `USE lake`.
