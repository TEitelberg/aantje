# Dependencies

**Dependencies** (`aantje.showDependencies`) opens a report that shows what depends on a table, view or macro and what it depends on, so you see what would break before you drop or change it. For a table or view it also shows the [column lineage](#columns): which view columns each column feeds, and where each column of a view comes from. The data is the SQL text of the views and macros in the catalog. DuckDB parses it (never runs it), and the report follows the tables, views and macros the text names. What the parser cannot read is counted as **Not followed**. A name the lake does not have at the snapshot is a **broken reference**, for example a view over a dropped table.

## Opening the report

- **Where.** The **Reports** submenu (see [Reports](reports.md)) of an open connection (the whole lake), a schema, a table, a view or a macro. The command is hidden from the Command Palette.
- **One panel per connection and object.** Titles: `Dependencies: shop.events · Lake`, `Column Lineage: shop.events.amount · Lake` and `Dependencies · Lake`; the heading of the page is the title without the connection. Opening the same object (and column) again reveals the panel with fresh data.
- **Show Column Lineage** (`aantje.showColumnLineage`) in the context menu of a column of a table or view opens the report of its table or view about that one column, on the tab [Columns](#columns), which shows only it. A field of a struct shows the lineage of the column that holds it. The command is hidden from the Command Palette.
- **The snapshot is the one the tree shows when the report opens.** The report and its actions use it: **Statistics** and **Dependencies** of another object open at the same snapshot.
- **Progress and Cancel.** Reading and parsing run under `Reading the dependencies of "Lake"...` with a Cancel button; cancel stops before the next object. A closed connection gives `Connect to a catalog first to show its dependencies.`
- **Parsed once per snapshot.** The graph is cached per connection for the last three snapshots asked for, so another object, a second panel and **Refresh** do not parse again. Panels that ask for a snapshot being read share the read; a failed or cancelled read is not kept. **Refresh** reads at the snapshot the tree shows now.
- **A hidden panel keeps its choices** with `getState` and `setState`: the tab, the depth, the filter box and the page of the table of the lake or a schema, **Show all**, and the object selected in the graph (by its kind and id). **Refresh** keeps them too. A tab that the report no longer has falls back to the first.
- **A removed or closed connection.** When the connection was removed, **Refresh** and every icon but **Visualize** say `The connection of this dependencies report was removed. Close the report.` When it is closed, **Refresh** and **Dependencies** say `Connect to a catalog first to show its dependencies.`, **Statistics** says `The connection is closed. Connect again to show the statistics.`, and **Show in tree** gives its hint.

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report has the form of the lake report for the objects of that schema that use or are used by another object or have a problem (`schemaData` in `src/dependencies/read.ts`), plus the objects of other schemas that they use or that use them, so that a view of the schema that reads a table of another schema shows that table. The counts of these neighbours are those of the edges listed here. `Objects without any` counts the schema's objects that are left out. The panel is `Dependencies: <schema> · <connection>`. The graph is the cached one of the snapshot, so opening a schema after the lake does not parse again.

## Reading the tables

The header has four key figures; the tabs follow them.

- **Tabs.** The report of the lake or a schema has **List** and **Graph**. The report of a table or view has **Objects**, **Columns**, **Object Graph** and **Column Graph**, the report of a macro **Objects** and **Object Graph**. The tabs work as in the other reports: the arrow keys, Home and End move between them, and only the tab shown draws its graph. The controls of a tab show with it: the depth with **Objects**, **Show all** with the graphs.
- **Key figures.** For the lake or a schema: **Objects with dependencies**, **Dependencies**, **Broken references** and **Not followed**. For an object: **Used by** and **Depends on** (the direct ones, and `n in all` at any depth), **Broken references** and **Not followed** of the objects connected to it. A broken reference is a name in the SQL of a view or macro that no object of the lake has at the snapshot; a function that DuckDB does not have built in counts too, because a function of an extension looks the same as a dropped macro. A text that is not followed is one the analysis could not read: another SQL dialect, a text too long, a text DuckDB cannot parse or read as a SELECT, a name in another catalog, a name only the macro's schema has, a file or URL after FROM, a run-time lookup (`query_table`). Its dependencies are unknown, so the report is incomplete for it. The report counts both; the graph draws the broken names, and `describe_object` of the [MCP server](mcp.md) lists them.
- **The lake or a schema: List.** A table of every object that uses or is used by another or has a problem, with the filter box and the pages of the other report tables (50 rows a page): **Name** (the qualified name), **Type** (sign and kind: `▦ table`, `◧ view`, `ƒ scalar macro`, `ƒ▦ table macro`), **Used by** and **Depends on** (the numbers of the direct users and dependencies), and the icons of its [actions](#actions). Most used first, ties by name. The filter box finds text in the name or the kind. Objects that take part in nothing are only counted in a note.
- **An object: Objects.** The depth as a drop-down, **Depth 1** to **Depth 5** (default 5), applies to both tables. **Depends on** lists what the object reads or calls, **Used by** what reads or calls it, both through the chain: a view of a view of the table is level 2. **Used by** lists what a drop of the object would break, up to the depth; the key figure **Used by** counts all of it. Each table has **Name**, **Type**, **Level** and the icons of the actions; every object is listed once, at the level where it is first reached, after the object it came from. An empty table is `None.` At most 500 rows each, with a note.
- **A cycle.** A table ends where it returns to an object already reached, with the note `The dependencies contain a cycle.`
- **No pane.** A click on an object or a column opens nothing. The actions are icons in the rows; those of the object of the report are in its header.
- **Accessible.** The tables are the accessible view: plain tables with their headings; the icons are buttons that Tab reaches, each named with its object for a screen reader. Signs and words carry the meaning, not colour.
- **Unread objects.** With more than 2000 views and macros the rest is not read: `Only 2,000 of 2,500 views and macros were read.`

## The graph

**Graph** of the lake or a schema and **Object Graph** of an object draw the objects; **Column Graph** draws their columns.

- **What it holds.** For an object, every object connected to it through dependencies, in either direction and over any number of steps: what it uses and what uses it, and also what those use and what uses them, such as the other table that a view of the object reads. The depth belongs to the tables only. **Show all** adds every other object of the lake that uses or is used by another, faint. For the lake or a schema, every object of the report.
- **Columns along the data flow.** What uses nothing the graph shows stands on the left, every other object right of everything it reads or calls. Arrows point from the object read or called to the object that uses it. A read is a solid line, a call of a macro a dashed one.
- **Shape and colour.** A table is a square, a view a rounded square, a scalar macro a circle and a table macro a diamond, each in its own colour; the label starts with the sign of the tables. The object of the report is drawn larger. A name that no object of the lake has is a red dashed triangle with a red dashed arrow to the object that names it.
- **Selecting.** A click selects an object and marks it; a click on the selected object takes the selection away. In the graph of the lake or a schema, what is not connected to the selected object is faint. A double click selects the object and frames everything connected to it. The selection opens nothing.
- **Visualize** in a row opens the graph tab on that object: selected, in the lake or a schema the rest faint, and framed. A frame zooms until the objects connected to it fill the chart, three times at most (the column graph one and a half), and never out of the view of the whole graph; the faint objects stay where they are.
- **Mouse.** Hovering an object brings out its neighbours. The wheel zooms and dragging moves the graph. Labels that would overlap are hidden until you zoom in.
- **The tables stay the accessible view.** The graph is drawn on a canvas; a screen reader hears how many objects and dependencies it has and which tab shows them as text.
- **Column Graph.** In the report of a table or view each object of the graph is a box with a row per column that the lineage of the report holds, in the places of the object graph, and a line runs from a source column to the view column built from it: solid for direct, dashed for derived, dotted for a column that decides the rows. The tab [Columns](#columns) is the accessible view of it.

The report of an object holds every object of the lake with dependencies for **Show all**, but only the problems of the objects connected to it (`objectData` in `src/dependencies/read.ts`). `connectedComponent` (`src/dependencies/picture.ts`) gives the objects connected to an object: the graph of an object holds them, and in the graph of the lake or a schema they stand out around the selected object. `picture` places the boxes: the column is one more than the largest column of what an object uses (an edge back into a cycle is left out), the first column is in name order and every other one in the mean row of what its objects use. `graphOption` turns that into an ECharts graph series with fixed positions, and `frameOf` (`src/dependencies/graph-option.ts`) gives the centre and the zoom of a frame from the size of the chart.

## Columns

The tab **Columns** of a table or view shows the column lineage around the object. A column of a view is built from columns of the tables and views it reads, and those of a view from theirs, through any depth. Each source has the kind of use:

| Use       | Meaning                                                                            | Example                                                    |
| --------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `direct`  | The value is the source column.                                                    | `SELECT amount`, `SELECT t.amount AS net`, `*`             |
| `derived` | The value is computed from the source column.                                      | `amount * rate`, `sum(amount)`, `CASE WHEN ...`, `s.field` |
| `filter`  | The column decides which rows the view has, not the value: WHERE, HAVING, QUALIFY. | `WHERE status = 'paid'`, an ORDER BY that a LIMIT cuts     |
| `join`    | The column joins: ON, USING, NATURAL.                                              | `JOIN customers c ON c.id = o.customer`                    |
| `group`   | The column groups: GROUP BY, DISTINCT ON.                                          | `GROUP BY region`                                          |

Seen through a view, a decision on rows stays one (a filter of a view that a view reads filters this one too), and a value is direct only when it is direct at every level.

- **Of a view**, three tables. **Sources**: each column of the view in its order with every column it is built from, through any depth, direct and derived: **Column**, **Source column**, **Object**, **Use** and **Level** (1 is a column of what the view reads itself). A part whose source cannot be named is `unknown: <what it is>`; a column without any source, such as a constant, is a row with an empty source. **Filters, joins and groups**: the columns that filter, join or group the rows of the view, through any depth (**Column**, **Object**, **Use**, **Level**). **Used by**: the columns of the views that use a column of this view, through any depth (**Column**, **View column**, **Object**, **Use**, **Level**).
- **Of a table**, **Used by** only.
- **Of one column** (Show Column Lineage), the same tables for that column only.
- **Plain tables.** A row opens nothing; an empty table is `None.`
- **A view whose columns cannot be told** (its SQL was not read, `*` over a table function) has one short note that says why instead of the tables.
- **Size.** Each table shows 500 rows at most, with a note; Open as Markdown has 200.

The data is the part of the lineage of the lake that the columns of the object reach in both directions (`lineageAround` in `src/dependencies/columns.ts`), at most 5000 dependencies between columns, the nearest first; a note says how many were left out. `lineageView` (`src/dependencies/lineage-view.ts`) makes the tables of it for the page and the document. The report of the lake, of a schema and of a macro has no tab Columns.

## Actions

The actions of an object are small icons at the end of its row, in this order:

| Icon      | Tooltip      | What happens                                                                            | Offered when                          |
| --------- | ------------ | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Graph     | Visualize    | The graph tab, on the object and framed with what is connected to it.                   | always                                |
| Hierarchy | Dependencies | That object's report in its own panel.                                                  | the object is not the one of the page |
| Bar chart | Statistics   | The statistics report of the table at the report's snapshot.                            | the object is a table                 |
| Tree      | Show in tree | Shows and selects the node (a macro in the folder Macros); a hint when it is not shown. | always                                |

- **Where.** In every row of the table of the lake or a schema and of the tables **Depends on** and **Used by** of an object. The report of an object has **Statistics** (of a table) and **Show in tree** of its own object in the header, before **Refresh**.
- **Buttons.** Tab reaches each icon, Enter or Space runs it, and the focus ring of the theme shows. A screen reader hears the action with the name (`Show shop.events in the tree`).
- **Drawn inline.** The icons are SVG in the style of the VS Code codicons, in the theme's icon colour (`iconButton` in `src/dependencies/icons.ts`); there is no icon font.
- **No scripts.** **Script as CREATE**, **ALTER** and **DROP** are in the context menu of the tree, not in the report.

An icon sends an action id and the object's index. The extension does not trust the page. A request with a command id, a script action, an undeclared field or no index fails the guard (`isDependenciesAction`) and is ignored without a log. `planDependenciesAction` checks the index against the data it sent and offers statistics for tables only. A request with an index not in the data, or for the statistics of a view or macro, is ignored and logged as a warning.

## Open as Markdown

**Open as Markdown** opens an untitled document that follows the page. For an object: the object, its kind, the depth and the counts of the broken references and texts not followed; **Depends on** and **Used by** to the depth with **Name**, **Type** and **Level**; for a table or view the tables of the tab Columns under **Columns**, with the same titles (`lineageMarkdown`, `src/dependencies/lineage-markdown.ts`, at most 200 rows each); and the graph. For the lake or a schema: the key figures, the table of the page (**Name**, **Type**, **Used by**, **Depends on**) as its filter box narrows it, and the graph. There are no tables of problems. `dependenciesMarkdown` (`src/dependencies/markdown.ts`) builds it from the data and the page's view (`depth`, `text`, `reach`); the extension fits the depth to 1..5. The graph is a Mermaid flowchart (a `mermaid` code block that GitHub and Mermaid previews draw) of what the page's graph holds: for an object everything connected to it, Show all included; for the lake every object of the report. Catalog text in its labels becomes Mermaid entity codes. A graph of more than 150 objects or 400 dependencies is only counted. Catalog text is code. Tables stop at 200 rows (an object) and 100 objects (the lake), each with `… n more omitted (limit: m).`

## How the references are found

The analysis is in `src/dependencies/` without `vscode`.

- **DuckDB parses, nothing runs.** Every view and every macro overload goes through `json_serialize_sql` of a small in-memory DuckDB of its own, set up like the SQL language service one: nothing attached, no extension, external access off. A text that is not exactly one SELECT, or has a syntax error, counts as **Not followed**, never as a silent gap.
- **What is parsed.** A view as stored (DuckLake keeps `SELECT * FROM shop.events WHERE (amount > 10)` without the lake's name). A scalar macro is parsed as `SELECT (<expression>)`, a table macro as a query. A dialect other than `duckdb` is not parsed.
- **What is found.** The JSON document is walked with a list, not recursion, so deeply nested views are read like others. Tables are found in FROM, joins (also `LATERAL`), subqueries, set operations, CTEs, `PIVOT`, and function and lambda arguments. `BASE_TABLE`, `TABLE_FUNCTION` and every `FUNCTION` or `WINDOW` node name something.
- **CTEs.** A CTE hides a table of the same name for the rest of its statement, only for an unqualified name. It sees the ones before it, and itself only when recursive: in `WITH events AS (SELECT * FROM events) SELECT * FROM events` the inner `events` is the real table. A CTE in a subquery has that subquery's scope.
- **Built-in functions.** The parser lists DuckDB's built-in functions once; `FROM duckdb_tables` is not a table and `abs` is not a missing macro. A parser that failed to start, or a list that could not be read, is not kept: the next report tries again.
- **Reads.** The views and the macros of all schemas are read with one statement each (`reader.views(null, snapshot)`, `reader.macros(null, snapshot)`), not one per schema.

### How names are resolved

Names compare case-insensitively for the letters A to Z only, like DuckDB.

- **A view looks an unqualified name up in its own schema first, then in `main`**, whatever schema the session uses (checked in a real DuckLake).
- **A macro looks it up when called, in the caller's default schema, never in its own.** The SQL editor of aantje uses `main` of the lake, so the report looks up a macro's unqualified names in `main`. A name only the macro's schema has is not an edge; it counts as **Not followed**, because it works for callers in that schema only. Qualify the name (`s.only_s()`) to make it firm.
- **Qualified names stand as written.** The catalog `lake` is the lake, and any other catalog counts as the lake when the lake has that object. `memory`, `system` and `temp` never are. A catalog the lake does not have counts as **Not followed**.
- **Macros are found by name and kind.** A call in an expression is a scalar macro, after FROM a table macro; overloads are one node, and a scalar and a table macro of one name are two.
- **A name that is not there.** A missing table or view is a broken reference. A call matching no macro is ignored when DuckDB has a built-in of that name and is a broken reference when not. A call with a catalog (`lake.snapshots()`) is never judged.

### How the columns are found

The column lineage comes from the same parse as the references (`src/dependencies/lineage.ts`, `lake-lineage.ts`); the report reads the top-level columns of every table with one statement more (`reader.columnEntries`).

- **A view is read after the views it reads**, so that its `*` over a view has the columns of that view; the columns of a table are the catalog's at the snapshot.
- **Names resolve as DuckDB binds them.** An alias of FROM, a CTE (its column list included) and a subquery are relations with their own columns; `t.c`, `s.t.c` and a field of a struct (`c.f`, a value derived from `c`) are told apart in DuckDB's order; a name no relation has looks in the subquery around it (a correlated subquery), then among the aliases of the select list. A lambda parameter and a macro parameter are no columns.
- **`*` and `t.*`** take the columns of their relations at the snapshot, with `EXCLUDE`, `REPLACE` and `RENAME`, the columns that `USING` and `NATURAL` merge once, and the right side of a SEMI or ANTI join left out.
- **Column names** are those DuckDB gives: a plain column keeps its name, an expression without an alias gets DuckDB's text of it (`(amount * 2)`, `sum(amount)`, asked of the parser's DuckDB with `json_deserialize_sql`, which runs nothing), a name taken before gets `_1`, `_2`, ..., and the column list of a view (`CREATE VIEW v(a, b)`) names its first columns.
- **Set operations**: a column of UNION takes the values of every part; INTERSECT and EXCEPT take the values of the first, the other parts filter.
- **Unknown, never guessed.** A column of a table function (`unnest`, `range`, `read_parquet`), of a PIVOT, of a table macro, of a file or of a relation the lake does not have, a name that no relation has, `COLUMNS(...)` and a position (`#1`) are unknown sources; the columns that the arguments of a table function read are listed as derived next to it. A call of a macro that reads tables is an unknown part of the value too.
- **One view that the analysis cannot follow** (nested deeper than the stack) has no columns; the others are read.

## Limits

The approach reads text, so it has the limits of text.

- **Only what is written.** `query_table('events')`, `query('...')` and names a macro builds in a string count as **Not followed**.
- **The search path of a session.** DuckDB also looks unqualified names up in the session's default schema and in `main` of every attached catalog. A session with another default schema or another attached catalog can read a different table.
- **Columns of views, not of macros.** The lineage follows views. A table macro after FROM is a relation whose columns are unknown, and what a scalar macro reads is an unknown part of the columns that call it.
- **What the text cannot tell.** The columns of a table function, of a PIVOT, of `COLUMNS(...)`, of a file or of a relation the lake does not have are unknown sources; a view with `*` over one of them has no column list. `GROUP BY ALL` counts the plain columns of the select list as groups only.
- **DuckDB text only.** Other dialects, SQL from a newer DuckDB than aantje's, and non-SELECT SQL count as **Not followed**.
- **Extension functions** that are not built in (spatial, for example) count as broken references.
- **Time travel in a view** (`AT (VERSION => 3)`) counts as a read; the version is not looked at.
- **Not analysed.** Column defaults and sort expressions are SQL text and are not parsed. A macro parameter default is stored as the constant it evaluated to, so it depends on nothing.
- **Size.** At most 2000 views and macros are parsed, texts up to 200 000 characters, and 500 rows in each table of an object. A report holds at most 5000 dependencies between columns, the nearest first, and each table of the tab Columns 500 rows. Every cut is noted.

## Security

The page uses the policy of the other reports (`default-src 'none'`, nonce for style and script, `localResourceRoots` `dist` and `media` for the logo of the header), and data arrives by `postMessage` after `ready`. Catalog text is put in with `textContent`. The page asks for an action by id and one index (`isDependenciesAction` accepts exactly the three ids with one number; the extension checks the number against the data it sent). The page validates what it receives (`isDependenciesMessage`), the column lineage with its indexes included. The parser runs in its own in-memory DuckDB with external access off and no extensions, never executes the text, and its answer is only read as JSON.
