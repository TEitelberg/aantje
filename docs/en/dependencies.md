# Dependencies

**Dependencies** (`aantje.showDependencies`) opens a report that shows what depends on a table, view or macro and what it depends on, so you see what would break before you drop or change it. The data is the SQL text of the views and macros in the catalog. DuckDB parses it (never runs it), and the report follows the tables, views and macros the text names. What the parser cannot read is listed as such. A name the lake does not have at the snapshot is a **broken reference**, for example a view over a dropped table.

## Opening the report

- **Where.** The **Reports** submenu (see [Reports](reports.md)) of an open connection (the whole lake), a schema, a table, a view or a macro. The command is hidden from the Command Palette.
- **One panel per connection and object.** Titles: `Dependencies of shop.events · Lake` and `Dependencies · Lake`. Opening the same object again reveals the panel with fresh data.
- **The snapshot is the one the tree shows when the report opens.** The report and its actions use it: **Statistics** and **Dependencies** of another object open at the same snapshot.
- **Progress and Cancel.** Reading and parsing run under `Reading the dependencies of "Lake"...` with a Cancel button; cancel stops before the next object. A closed connection gives `Connect to a catalog first to show its dependencies.`
- **Parsed once per snapshot.** The graph is cached per connection for the last three snapshots asked for, so another object, a second panel and **Refresh** do not parse again. Panels that ask for a snapshot being read share the read; a failed or cancelled read is not kept. **Refresh** reads at the snapshot the tree shows now.
- **A hidden panel keeps its choices** (list or graph, direction, depth, lake filter, Show all, selected object) with `getState` and `setState`.
- **A removed or closed connection.** When the connection was removed, **Refresh** and every icon but **Visualize** say `The connection of this dependencies report was removed. Close the report.` When it is closed, **Refresh** and **Dependencies** say `Connect to a catalog first to show its dependencies.`, **Statistics** says `The connection is closed. Connect again to show the statistics.`, and **Show in tree** gives its hint.

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report has the form of the lake report for the objects of that schema that use or are used by another object or have a problem (`schemaData` in `src/dependencies/read.ts`), plus the objects of other schemas that they use or that use them, so that a view of the schema that reads a table of another schema shows that table. The counts of these neighbours are those of the edges listed here. `Objects without any` counts the schema's objects that are left out. The panel is `Dependencies · <connection> · schema <schema>`. The graph is the cached one of the snapshot, so opening a schema after the lake does not parse again.

## Reading the lists

The header has four key figures, then the list, the pane of the selected object and the problems.

- **Used by and Depends on.** Two buttons switch the direction of the list. **Used by** lists views and macros that read or call the object; **Depends on** lists what it reads or calls. Both follow the chain (a view of a view of the table is level 2). **Used by** lists what a drop of the object would break, up to the set depth. The key figure **Used by** counts all of it, at any depth (`n in all`).
- **Depth.** **Depth 1** to **Depth 5** (default 5). Key figures count everything behind the depth.
- **Rows.** Each object is listed once, at the level where it is first reached, indented below the object it came from. A row shows a sign and kind (`◧ view`, `▦ table`, `ƒ scalar macro`, `ƒ▦ table macro`), the name and the edge (`reads` or `calls`; `read by` or `called by` in **Depends on**). Signs and words carry the meaning, not colour. A screen reader hears the level (`Level 2: view shop.big_events, reads shop.events`).
- **Keyboard.** The list is one tab stop; arrows, Home and End move, Enter or Space selects. At most 500 rows are listed, with a note on how many were left out.
- **A cycle.** The list ends where it returns to an object already reached, with the note `The dependencies contain a cycle.`
- **The lake.** From the connection, the report lists every object that uses or is used by another, most used first (ties by name), with `used by n · depends on m`. A filter finds text in name or kind. At most 200 objects are listed; objects taking part in nothing are only counted.
- **The selected object.** A click in the list or the graph selects an object and shows its pane: the sign, name and kind, the icons of its [actions](#actions) at the end of that line, and its direct neighbours, **Used by (n)** and **Depends on (m)**, 30 names at most each. Every report shows them, the report of an object also for that object itself. Without a selection there is no pane; a filter that hides the selected object takes the selection away.
- **Which problems.** For an object, the problems of the objects that its graph connects: the object, what it uses and what uses it, each up to the set depth, whatever direction the list shows. The faint objects of **Show all** are left out. For the lake or a schema, the problems of every object of the report.
- **Broken references.** The object, the name it looks for (`shop.old_stuff`, `legacy_fee()`) and what it looked for. A function DuckDB does not have built in is `macro or unknown function`, because an extension function looks the same as a dropped macro. Cut at 100 rows.
- **Not followed.** The object, the reason and the catalog text: another SQL dialect, a text too long, a text DuckDB cannot parse or read as a SELECT, a name in another catalog, a name only the macro's schema has, a file or URL after FROM, a run-time lookup (`query_table`). A text that makes the analysis fail is listed with the message and does not stop the others. Their dependencies are unknown, so the report is incomplete for them.
- **Unread objects.** With more than 2000 views and macros the rest is not read: `Only 2,000 of 2,500 views and macros were read.`

## The graph

**List** and **Graph** at the start of the toolbar switch the view; the depth, the selected object and the snapshot stay. The direction belongs to the list: the graph view does not show it. **Visualize** in the pane of the selected object opens the graph and zooms in on that object.

- **Columns along the data flow.** What uses nothing the graph shows stands on the left, every other object right of everything it reads or calls. Arrows point from the object read or called to the object that uses it. A read is a solid line, a call of a macro a dashed one.
- **Shape and colour.** A table is a square, a view a rounded square, a scalar macro a circle and a table macro a diamond, each in its own colour; the label starts with the sign of the list. A name that no object of the lake has is a red dashed triangle with a red dashed arrow to the object that names it.
- **What it holds.** For an object, both directions: what it reads or calls, left of it, and what uses it, right of it, each up to the set depth; the object is drawn larger. **Show all** adds every other object of the lake that uses or is used by another, faint. For the lake or a schema, every object of the report.
- **Mouse.** Hovering an object brings out its neighbours. A click selects it and shows its pane below; a double click also zooms in on it. The wheel zooms and dragging moves the graph. Labels that would overlap are hidden until you zoom in.
- **The list stays the accessible view.** The graph is drawn on a canvas; a screen reader hears how many objects and dependencies it has.

The report of an object holds every object of the lake with dependencies for **Show all**, but only the problems of the object and of the objects it reaches (`objectData` in `src/dependencies/read.ts`). `connectedObjects` (`src/dependencies/picture.ts`) gives the objects that the graph of an object connects; the page and the document show the problems of those. `picture` places the boxes: the column is one more than the largest column of what an object uses (an edge back into a cycle is left out), the first column is in name order and every other one in the mean row of what its objects use. `graphOption` turns that into an ECharts graph series with fixed positions.

## Actions

The actions of the selected object are small icons at the end of its heading line, in this order:

| Icon      | Tooltip      | What happens                                                                            | Offered when                          |
| --------- | ------------ | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Graph     | Visualize    | The graph, zoomed in on the object.                                                     | the list shows                        |
| Hierarchy | Dependencies | That object's report in its own panel.                                                  | the object is not the one of the page |
| Bar chart | Statistics   | The statistics report of the table at the report's snapshot.                            | the object is a table                 |
| Tree      | Show in tree | Shows and selects the node (a macro in the folder Macros); a hint when it is not shown. | always                                |

- **Buttons.** Tab reaches each icon, Enter or Space runs it, and the focus ring of the theme shows. A screen reader hears the action with the name (`Show shop.events in the tree`).
- **Drawn inline.** The icons are SVG in the style of the VS Code codicons, in the theme's icon colour (`iconButton` in `src/dependencies/icons.ts`); there is no icon font.
- **No scripts.** **Script as CREATE**, **ALTER** and **DROP** are in the context menu of the tree, not in the report.

An icon sends an action id and the object's index. The extension does not trust the page. A request with a command id, a script action, an undeclared field or no index fails the guard (`isDependenciesAction`) and is ignored without a log. `planDependenciesAction` checks the index against the data it sent and offers statistics for tables only. A request with an index not in the data, or for the statistics of a view or macro, is ignored and logged as a warning.

## Open as Markdown

**Open as Markdown** opens an untitled document: the object, the lists for the set direction and depth (both directions, to the deepest level, when there is no view), the graph, and the broken and unresolved references of the objects that the graph connects, as on the page. For the lake it is the filtered object list and the whole lake's problems. `dependenciesMarkdown` (`src/dependencies/markdown.ts`) builds it from the data and the page's view (`direction`, `depth`, `text`, `reach`); the extension fits the depth to 1..5. The graph is a Mermaid flowchart (a `mermaid` code block that GitHub and Mermaid previews draw) of what the page's graph holds: for an object both directions to the set depth, whatever direction the lists have, Show all included; for the lake every object of the report. Catalog text in its labels becomes Mermaid entity codes. A graph of more than 150 objects or 400 dependencies is only counted. Catalog text is code. Tables stop at 200 rows (lists), 100 objects (lake) and 100 rows (problems), each with `… n more omitted (limit: m).`

## How the references are found

The analysis is in `src/dependencies/` without `vscode`.

- **DuckDB parses, nothing runs.** Every view and every macro overload goes through `json_serialize_sql` of a small in-memory DuckDB of its own, set up like the SQL language service one: nothing attached, no extension, external access off. A text that is not exactly one SELECT, or has a syntax error, becomes an entry under **Not followed**, never a silent gap.
- **What is parsed.** A view as stored (DuckLake keeps `SELECT * FROM shop.events WHERE (amount > 10)` without the lake's name). A scalar macro is parsed as `SELECT (<expression>)`, a table macro as a query. A dialect other than `duckdb` is not parsed.
- **What is found.** The JSON document is walked with a list, not recursion, so deeply nested views are read like others. Tables are found in FROM, joins (also `LATERAL`), subqueries, set operations, CTEs, `PIVOT`, and function and lambda arguments. `BASE_TABLE`, `TABLE_FUNCTION` and every `FUNCTION` or `WINDOW` node name something.
- **CTEs.** A CTE hides a table of the same name for the rest of its statement, only for an unqualified name. It sees the ones before it, and itself only when recursive: in `WITH events AS (SELECT * FROM events) SELECT * FROM events` the inner `events` is the real table. A CTE in a subquery has that subquery's scope.
- **Built-in functions.** The parser lists DuckDB's built-in functions once; `FROM duckdb_tables` is not a table and `abs` is not a missing macro. A parser that failed to start, or a list that could not be read, is not kept: the next report tries again.
- **Reads.** The views and the macros of all schemas are read with one statement each (`reader.views(null, snapshot)`, `reader.macros(null, snapshot)`), not one per schema.

### How names are resolved

Names compare case-insensitively for the letters A to Z only, like DuckDB.

- **A view looks an unqualified name up in its own schema first, then in `main`**, whatever schema the session uses (checked in a real DuckLake).
- **A macro looks it up when called, in the caller's default schema, never in its own.** The SQL editor of aantje uses `main` of the lake, so the report looks up a macro's unqualified names in `main`. A name only the macro's schema has is not an edge; it is listed under **Not followed** (`Names an object that only the schema of this macro has`), because it works for callers in that schema only. Qualify the name (`s.only_s()`) to make it firm.
- **Qualified names stand as written.** The catalog `lake` is the lake, and any other catalog counts as the lake when the lake has that object. `memory`, `system` and `temp` never are. A catalog the lake does not have is `Reads another catalog than the lake`.
- **Macros are found by name and kind.** A call in an expression is a scalar macro, after FROM a table macro; overloads are one node, and a scalar and a table macro of one name are two.
- **A name that is not there.** A missing table or view is a broken reference. A call matching no macro is ignored when DuckDB has a built-in of that name and is a broken reference when not. A call with a catalog (`lake.snapshots()`) is never judged.

## Limits

The approach reads text, so it has the limits of text.

- **Only what is written.** `query_table('events')`, `query('...')` and names a macro builds in a string are listed under **Not followed**.
- **The search path of a session.** DuckDB also looks unqualified names up in the session's default schema and in `main` of every attached catalog. A session with another default schema or another attached catalog can read a different table.
- **Tables, not columns.** Dropping or renaming a column can break a view this report does not list.
- **DuckDB text only.** Other dialects, SQL from a newer DuckDB than aantje's, and non-SELECT SQL are listed under **Not followed**.
- **Extension functions** that are not built in (spatial, for example) show up as broken references (`macro or unknown function`).
- **Time travel in a view** (`AT (VERSION => 3)`) counts as a read; the version is not looked at.
- **Not analysed.** Column defaults and sort expressions are SQL text and are not parsed. A macro parameter default is stored as the constant it evaluated to, so it depends on nothing.
- **Size.** At most 2000 views and macros are parsed, texts up to 200 000 characters, 500 list rows, 200 lake objects and 100 problems of each kind. Every cut is noted.

## Security

The page uses the policy of the other reports (`default-src 'none'`, nonce for style and script, `localResourceRoots` `dist`), and data arrives by `postMessage` after `ready`. Catalog text is put in with `textContent`. The page asks for an action by id and one index (`isDependenciesAction` accepts exactly the three ids with one number; the extension checks the number against the data it sent). The page validates what it receives (`isDependenciesMessage`). The parser runs in its own in-memory DuckDB with external access off and no extensions, never executes the text, and its answer is only read as JSON.
