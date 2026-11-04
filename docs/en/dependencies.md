# Dependencies

**Dependencies** (`aantje.showDependencies`) opens a report that shows what depends on a table, view or macro and what it depends on, so you see what would break before you run **Script as DROP** or **Script as ALTER**. The data is the SQL text of the views and macros in the catalog. DuckDB parses it (never runs it), and the report follows the tables, views and macros the text names. What the parser cannot read is listed as such. A name the lake does not have at the snapshot is a **broken reference**, for example a view over a dropped table.

## Opening the report

- **Where.** The **Reports** submenu (see [Reports](reports.md)) of an open connection (the whole lake), a schema, a table, a view or a macro. The command is hidden from the Command Palette.
- **One panel per connection and object.** Titles: `Dependencies of shop.events · Lake` and `Dependencies · Lake`. Opening the same object again reveals the panel with fresh data.
- **The snapshot is the one the tree shows when the report opens.** The report and its actions use it: **Script as CREATE** and **ALTER** write the columns the table had then, and **Dependencies** of another object opens at the same snapshot. **Script as DROP** and **ALTER** act on the newest state; when the report's snapshot is older, the script says so in a comment.
- **Progress and Cancel.** Reading and parsing run under `Reading the dependencies of "Lake"...` with a Cancel button; cancel stops before the next object. A closed connection gives `Connect to a catalog first to show its dependencies.`
- **Parsed once per snapshot.** The graph is cached per connection for the last three snapshots asked for, so another object, a second panel and **Refresh** do not parse again. Panels that ask for a snapshot being read share the read; a failed or cancelled read is not kept. **Refresh** reads at the snapshot the tree shows now.
- **A hidden panel keeps its choices** (direction, depth, lake filter, selected object) with `getState` and `setState`.
- **A removed or closed connection.** `The connection of this dependencies report was removed. Close the report.` or `The connection is closed. Connect again to use the dependencies.`

## For one schema

Opened on a schema node ([Reports](reports.md#reports-for-one-schema)), the report has the form of the lake report for the objects of that schema that use or are used by another object or have a problem (`schemaData` in `src/dependencies/read.ts`), plus the objects of other schemas that they use or that use them, so that a view of the schema that reads a table of another schema shows that table. The counts of these neighbours are those of the edges listed here. `Objects without any` counts the schema's objects that are left out. The panel is `Dependencies · <connection> · schema <schema>`. The graph is the cached one of the snapshot, so opening a schema after the lake does not parse again.

## Reading the lists

The header has four key figures, then the list, the drop section, the selected object and the problems.

- **Used by and Depends on.** Two buttons switch the direction. **Used by** lists views and macros that read or call the object; **Depends on** lists what it reads or calls. Both follow the chain (a view of a view of the table is level 2).
- **Depth.** **Depth 1** to **Depth 5** (default 5). Key figures count everything behind the depth.
- **Rows.** Each object is listed once, at the level where it is first reached, indented below the object it came from. A row shows a sign and kind (`◧ view`, `▦ table`, `ƒ scalar macro`, `ƒ▦ table macro`), the name and the edge (`reads` or `calls`; `read by` or `called by` in **Depends on**). Signs and words carry the meaning, not colour. A screen reader hears the level (`Level 2: view shop.big_events, reads shop.events`).
- **Keyboard.** The list is one tab stop; arrows, Home and End move, Enter or Space selects. At most 500 rows are listed, with a note on how many were left out.
- **A cycle.** The list ends where it returns to an object already reached, with the note `The dependencies contain a cycle.`
- **The lake.** From the connection, the report lists every object that uses or is used by another, most used first (ties by name), with `used by n · depends on m`. A filter finds text in name or kind. At most 200 objects are listed; objects taking part in nothing are only counted. A selected object shows its direct neighbours (30 at most).
- **Broken references.** The object, the name it looks for (`shop.old_stuff`, `legacy_fee()`) and what it looked for. A function DuckDB does not have built in is `macro or unknown function`, because an extension function looks the same as a dropped macro. Cut at 100 rows.
- **Not followed.** The object, the reason and the catalog text: another SQL dialect, a text too long, a text DuckDB cannot parse or read as a SELECT, a name in another catalog, a name only the macro's schema has, a file or URL after FROM, a run-time lookup (`query_table`). A text that makes the analysis fail is listed with the message and does not stop the others. Their dependencies are unknown, so the report is incomplete for them.
- **Unread objects.** With more than 2000 views and macros the rest is not read: `Only 2,000 of 2,500 views and macros were read.`

## What a drop would break

For an object, **If you drop shop.events** names everything that uses it, directly or through other views and macros, whatever depth is set: `Dropping shop.events breaks 9 objects: 8 views, 1 table macro.` It names the first ten and counts the rest. An unused object says `Nothing in this lake uses shop.events; dropping it breaks no view or macro.` A view that already has a broken reference is listed under **Broken references**, not counted here. **Open Script as DROP** opens the script in an SQL editor of the connection; nothing runs.

## Actions

Select an object; a pane shows what you can do with it. The buttons send an action id and the object's index.

| Button                          | What happens                                                                            | Offered when                          |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| Show in tree                    | Shows and selects the node (a macro in the folder Macros); a hint when it is not shown. | always                                |
| Statistics                      | The statistics report of the table at the report's snapshot.                            | the object is a table                 |
| Dependencies                    | That object's report in its own panel.                                                  | the object is not the one of the page |
| Script as CREATE / ALTER / DROP | The tree command's script, opened in an SQL editor of the connection. Nothing runs.     | always                                |

The extension does not trust the page. `planDependenciesAction` checks the index against the data it sent and offers statistics for tables only. Scripts are made from the object at the report's snapshot (`scriptOf` of the tree commands); when it is not there, the hint says `"shop.tmp_view" does not exist at snapshot @56, so there is no script for it.` A request with a command id, an undeclared field or an index not in the data is ignored and logged as a warning.

## Open as Markdown

**Open as Markdown** opens an untitled document: the object, the lists for the set direction and depth (both directions, to the deepest level, when there is no view), what a drop breaks, and the broken and unresolved references of the listed objects. For the lake it is the filtered object list and the whole lake's problems. `dependenciesMarkdown` (`src/dependencies/markdown.ts`) builds it from the data and the page's view (`direction`, `depth`, `text`); the extension fits the depth to 1..5. Catalog text is code. Tables stop at 200 rows (lists), 100 objects (lake), 50 names (drop) and 100 rows (problems), each with `… n more omitted (limit: m).`

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

The page uses the policy of the other reports (`default-src 'none'`, nonce for style and script, `localResourceRoots` `dist`), and data arrives by `postMessage` after `ready`. Catalog text is put in with `textContent`. The page asks for an action by id and one index (`isDependenciesAction` accepts exactly the six ids with one number; the extension checks the number against the data it sent). The page validates what it receives (`isDependenciesMessage`). The parser runs in its own in-memory DuckDB with external access off and no extensions, never executes the text, and its answer is only read as JSON.

## Modules

| File                                        | Job                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/dependencies/parser.ts`                | `openSqlParser`: the isolated DuckDB with `json_serialize_sql` and the built-in function list. |
| `src/dependencies/references.ts`            | `extract`: tables, views and functions in a parsed document, with CTE scopes. Pure.            |
| `src/dependencies/graph.ts`                 | `buildGraph`: nodes, edges, broken and unresolved references, name resolution, limits. Pure.   |
| `src/dependencies/read.ts`                  | `readGraph` (cache per snapshot and connection), `objectData`, `lakeData`.                     |
| `src/dependencies/model.ts`                 | `DependenciesData`, `traverse`, `dropImpact`, `issuesOf`, `lakeRows`, key figures. Pure.       |
| `src/dependencies/actions.ts`, `execute.ts` | `planDependenciesAction` and its execution through a port.                                     |
| `src/dependencies/protocol.ts`, `state.ts`  | Message, action and view guards; the choices a hidden page keeps.                              |
| `src/dependencies/markdown.ts`              | `dependenciesMarkdown`.                                                                        |
| `src/dependencies/kind.ts`, `style.ts`      | The `ReportKind` and stylesheet.                                                               |
| `src/dependencies/page.ts`, `render.ts`     | The browser side.                                                                              |
| `src/dependencies/commands.vscode.ts`       | `registerDependenciesCommand`: command, progress, panels, action port.                         |

## Tests

```text
npx vitest run test/unit/dependencies-
```

Unit tests run the real parser on joins, subqueries, set operations, CTEs, lambdas and hostile names; check the exact edges of the history fixture and edited copies (cycles, diamonds, dropped objects, deeply nested views); and compare name resolution with what a real DuckLake returns (SQLite, PostgreSQL with `AANTJE_POSTGRES=1`). Others cover the cache, the model, the guards, the Markdown, the actions and the page bundle against a DOM stand-in. The integration test runs in a real VS Code.
