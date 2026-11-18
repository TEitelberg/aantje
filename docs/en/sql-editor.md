# SQL editor

The SQL editor runs SQL against a DuckLake from an ordinary SQL document. The explorer only reads; the editor runs any SQL (SELECT, but also CREATE, INSERT, UPDATE, DELETE, ALTER, DROP) with the rights of the connection's credentials. This page covers use, the document-to-connection mapping, sessions, what a run does, the Query History, settings, the API of `src/sql/editor.ts` and limits. The session is in [SQL session](sql-session.md), completion, the marks while typing and their quick fixes in [SQL IntelliSense](sql-intellisense.md), the results panel in [Data grid](grid.md).

## Using it

1. Right-click a connected connection or any node below it (a schema, table, view, folder, column, snapshot, file and so on) and choose **New Query**, or run **aantje: New Query** from the Command Palette (it asks for the connection when there are several). A new untitled SQL document opens and belongs to that connection. For a table or view it holds **Script as SELECT**; otherwise it is empty. The commands of the **Script as** submenu ([DDL generation](ddl.md#the-scripts-by-node-kind)), of **Maintenance** ([Maintenance scripts](maintenance.md)) and **Open as SQL** of Query at Snapshot ([Time travel](time-travel.md#open-as-sql)) open their text the same way, in a document that belongs to the node's connection. Opening never runs anything: a DROP script runs only when you run it, and a read-only session refuses it.
2. For a SQL document you already have, run **aantje: Select Connection for Query...** or click the status bar item. Running a document without a connection asks for one first, also when there is only one; New Query takes the only connection without asking. Without any connection both say to add one.
3. Run the document with `F5`, or the statement under the cursor with `Ctrl+Enter`. The results open in a panel below the editor, which stays with the editor: it follows it into another group, comes forward with it and closes with it. **Hide Results** in the editor title (or `Ctrl+Alt+R`) gives the query the whole height; **Show Results** brings the last run back.

| Command                              | Id                                         | Key                                 |
| ------------------------------------ | ------------------------------------------ | ----------------------------------- |
| New Query                            | `aantje.newQuery`                          |                                     |
| Select Connection for Query...       | `aantje.selectQueryConnection`             |                                     |
| Run Query                            | `aantje.runQuery`                          | `F5`                                |
| Run Statement at Cursor              | `aantje.runStatement`                      | `Ctrl+Enter` (`Cmd+Enter` on macOS) |
| Explain Statement                    | `aantje.explainStatement`                  |                                     |
| Explain Analyze Statement (Analysis) | `aantje.analyzeStatement`                  |                                     |
| Run with Profiler (Statistics)       | `aantje.profileStatement`                  |                                     |
| Run CTE with Limit...                | `aantje.runCteWithLimit`                   |                                     |
| Run to File...                       | `aantje.runToFile`                         |                                     |
| Set Parameters...                    | `aantje.setQueryParameters`                |                                     |
| Save Selection as Template...        | `aantje.saveSelectionAsTemplate`           |                                     |
| Cancel Query                         | `aantje.cancelQuery`                       | `Shift+F5`                          |
| Toggle Results                       | `aantje.toggleResults`                     | `Ctrl+Alt+R`                        |
| Hide Results, Show Results           | `aantje.hideResults`, `aantje.showResults` | (editor title)                      |
| Toggle Read-only Session             | `aantje.toggleReadOnly`                    |                                     |
| Query Session...                     | `aantje.queryMenu`                         |                                     |

**Run Query** runs the selection when it holds more than blanks, else the whole document. **Run Statement at Cursor** runs the selection when it holds one statement, else the statement that contains the cursor; a selection of several statements runs nothing and says so. A statement owns the text from its first word up to the first word of the next one, so a cursor behind the `;`, in blanks or in a comment picks the previous statement. Statements come from DuckDB's tokenizer, so a `;` in a string, a quoted name, a comment or a `$$` block does not split.

The keys apply only where `editorTextFocus && editorLangId == sql && aantje.queryEditor` holds. `aantje.queryEditor` is set while the active editor is a SQL document with a connection, so aantje does not take `F5` and `Ctrl+Enter` from other SQL extensions or from documents without a connection. `aantje.queryRunning` is set while the active editor runs a query: the run icon turns into the stop icon, and `Shift+F5` is bound only then. `aantje.queryHasResults` is set while the active editor has results (shown or hidden) and `aantje.queryResultsCollapsed` while they are hidden: the title shows **Hide Results** (`$(layout-panel)`) or **Show Results** (`$(layout-panel-off)`), and `Ctrl+Alt+R` and **Toggle Results** in the Command Palette exist only then. VS Code gives an extension command one icon, so the two buttons are two commands.

The status bar item (`$(aantje-duck) Fixture · read/write` or `read-only`, plus ` · transaction open` or ` · transaction aborted`) is shown while the active editor has a connection. Its menu: Select Connection, switch the mode (not on a Quack connection), Cancel Query (while it runs), Close Session.

## Format Document

**Format Document** (`Shift+Alt+F`) and **Format Selection** format the SQL of an editor with a connection: each clause on its own line, the columns, joins, CTEs and subqueries indented by the editor's tab size, a blank line between statements, comments kept. aantje uses [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) with its DuckDB dialect; `aantje.sql.formatKeywordCase` sets upper case (default), lower case or the case as written. Format Selection formats the whole lines of the selection and indents them like its first line.

**Formatting never changes what the SQL means.** Before aantje changes the text, DuckDB tokenizes it before and after: the tokens must be the same in the same order, apart from the case of keywords and unquoted names, and every comment must still be there. The placeholders of [Parameters](#parameters) (`$name`, `$name{default}`, `{{name}}`) stay as written; a result that would split or join one is refused too, although its tokens are the same. Otherwise aantje leaves the text as it was and says so; the same for SQL that the formatter cannot read, such as a statement that is still being typed. Other SQL files of the workspace are left to other extensions; when you have another SQL formatter, VS Code asks once which one to use.

## Execute, Explain, Analysis and Statistics

Above every query of an editor with a connection a CodeLens offers four actions for that one statement: **Execute | Explain | Analysis | Statistics**. The same four are in the context menu of the editor and in the `...` menu of its title, where they act on the selection when it holds one statement, else on the statement at the cursor. `aantje.sql.codeLens` switches the lens off.

- **Execute** runs the statement, the same as Run Statement at Cursor.
- **Explain** runs `EXPLAIN`: DuckDB shows the plan and executes nothing.
- **Analysis** runs `EXPLAIN ANALYZE`: DuckDB executes the statement and shows the plan with the time and rows of each operator.
- **Statistics** runs the statement with DuckDB's profiler and shows its operators in three tabs: **Statistics**, a table with one row per operator, indented as in the plan, with its branch (the table that an input of a join reads), its own time and share, its rows, the estimate and its details; **Flame Graph**, each operator as a bar as long as its own time and that of its inputs, the result on top and its inputs below, on the axis of the cumulated time (the mouse wheel zooms into narrow bars); and **Text Statistics**, all figures of the profile as text: total and CPU time, rows and row groups scanned, bytes read and written, peak memory, then the operators. All views colour an operator by its kind: scans blue, joins yellow, aggregates orange, CTEs green, filters, sorts and windows purple, the rest grey. **Copy Statistics** copies the table as tab-separated text. When the run shows something that would make the statement faster, a tab **Tips (n)** right after Statistics lists it ([Performance tips](#performance-tips)); Analysis shows the same tab right after its **Execution Plan**.

Explain and Analysis ask DuckDB for the plan in JSON (`EXPLAIN (FORMAT JSON)`, `EXPLAIN (ANALYZE, FORMAT JSON)`) and draw it in a tab named **Execution Plan**, laid out like the plans of SQL Server Management Studio: the result in the top left corner, each operator in a tile, its first input in the same row to the right and each further input below, arrows pointing from the inputs to the operator that reads them and as thick as the rows that flow. A tile shows a symbol for the kind of operator, its name (`Hash Join (Inner)`), its table or main detail, and one figure per line: for Analysis the cost (its share of the time of all operators), its time and the rows as `72 of 2,249 (3%)`, actual of estimated; for Explain the estimated rows. Tiles are tinted green; Analysis fills the operators that took more than half (red) or a quarter (orange) of the slowest one's time. **The time of an operator adds up all threads that ran it**, as DuckDB measures it, so it can exceed the total time of the query: in a query of 18 ms on 8 threads, an operator can show 90 ms. The tile, its tooltip, the Statistics table and the tooltips of the charts say so (`all threads`), and the summaries of the plan and of the Statistics table say that it can exceed the total; the total time in the summary is the time of the query. Hovering a tile shows all its details in a tooltip that follows the mouse, wraps and stays inside the view. A click on a tile pins its tooltip, so that the mouse can go into it and scroll a long one; a click on that tile again or on a free spot, or the mouse over another tile, releases it. **Copy Plan (JSON)** copies the plan as DuckDB returned it, and **Copy** above Text Statistics or a plan in text copies the whole output. The plan opens at a readable size; **−**, **+**, **Fit** and **100%** zoom, as does Ctrl and the mouse wheel, and dragging moves it. An `EXPLAIN` that you type yourself keeps DuckDB's text and shows it in the editor font. Cancel, the session mode and the transaction state work as with Run Statement. All four also work on a Quack connection: the plan and the profile are those of the session's DuckDB, which reads from the server.

**Where the lens appears.** Above statements that contain a query: `SELECT`, `WITH`, `FROM`, `VALUES`, `TABLE`, and writes built on a query (`INSERT … SELECT`, `CREATE TABLE … AS SELECT`, `COPY (SELECT …) TO …`). Not above plain DDL such as `DROP`, nor in SQL files without a connection. A `CREATE VIEW` or `CREATE MACRO` only stores its query, so it gets no lens of its own; the CTEs of its query keep theirs.

**No Analysis for a statement that does more than read.** `EXPLAIN ANALYZE` executes the statement, so it is offered only when the statement is known to only read; this keeps a plan view from changing data by accident, it is no permission check. The check works on DuckDB's tokens, so a word in a string, a quoted name or a comment does not count. Every keyword that writes counts, also inside a CTE or a subquery (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `DROP`, `ALTER`, `COPY`, `ATTACH`, `DETACH`, `CALL`, `CHECKPOINT`, `VACUUM`, `EXPORT`, `IMPORT`, `INSTALL`, `LOAD`), and so do functions that change state or run SQL from a string (`nextval`, `setval`, `query`, the DuckLake functions that write, also behind the lake's name as `lake.merge_adjacent_files()`). What the check does not understand gets no Analysis. From a menu, Analysis on such a statement says why and offers Explain.

**Statistics leaves the session as it was.** It reads `enable_profiling`, `profiling_output` and `profiling_coverage` before the run (and `memory_limit`, for the tip about spilling, which it does not change), lets the profiler write JSON into a temporary file, and puts the settings back afterwards, also after an error or a cancel; the file is deleted. Statistics runs the statement as Execute does, so it is offered for writes too. In an aborted transaction DuckDB refuses to change settings: then the profiler stays on until the next run, for example the `ROLLBACK`, after which aantje restores the settings, and says so.

**A CTE on its own.** In a statement with a `WITH` each CTE of the outermost list gets its own lens, on the line of its name: **Execute (LIMIT 100) | Explain | Analysis | Statistics**. When the CTE starts on the line of the statement, both share one row, and the CTE's part starts with its name: **CTE o: Execute (LIMIT 100)**. aantje builds the statement from the text as written: the CTEs before it and the CTE itself (all of them for `WITH RECURSIVE`), with names, column lists and `MATERIALIZED`, then `SELECT * FROM` the CTE. The editor text stays as it is. The results show the built statement and offer **Open as New Query**; Go to statement has nothing to go to.

- Execute adds `LIMIT n`, n from `aantje.sql.cteRowLimit`. Explain, Analysis and Statistics run without the limit, because a `LIMIT` lets DuckDB stop early and changes the plan. **Run CTE with Limit...** (cursor in the CTE) asks for the action and the limit: 1 for a single row, empty for all rows.
- Only CTEs that only read get a lens, judged on the built statement; this also covers the reading CTEs of an `INSERT … SELECT` or a `CREATE TABLE … AS`, since the built statement leaves the write out. A CTE after one that writes still gets a lens, as long as its own built statement does not include it.
- CTEs nested in a subquery or in another CTE get none.

### Performance tips

After Statistics and after Analysis, aantje looks at the measured run and at the catalog of the tables the statement read, and lists what would make the statement faster in the tab **Tips (n)**, right after the Statistics tab or the Execution Plan. The tab is there only when there is a tip. It is a table with one row per tip: an icon for its kind (storage and cache, memory, table layout, columns read, maintenance), what was measured, the facts behind it and what to do. Where a script applies, the icon button at the end of the row (**Open script**) opens it in a new, unsaved SQL document of the same connection. aantje never runs it and never changes your statement. Analysis reads the same figures from the plan of `EXPLAIN (ANALYZE, FORMAT JSON)` that Statistics reads from the profiler, and reads `memory_limit` before it; it changes no setting.

- **Sort order.** A scan took at least a fifth of the time, returned at most half of the rows of its table, and filtered on a column (or got a dynamic filter on it from a join) that the table is not sorted by, while the ranges of that column overlap across the files of the table (from the catalog) or, for a table of one file, across the row groups of that file (from its Parquet footer). DuckLake could then skip nothing. The script runs `ALTER TABLE ... SET SORTED BY` and writes the rows again in that order in one transaction, a `DELETE` and an `INSERT` from the snapshot that the transaction starts from, because DuckLake applies a sort order only to what it writes from then on. The old files stay until Expire Snapshots and Clean Up Old Files remove them. For a table of 10 GiB or more the tip names partitioning as an alternative.
- **Cold or warm.** Scans of files on a remote storage took at least a fifth of the time. DuckDB keeps what it reads from remote files in memory for the rest of the session, so a second run reads less from the storage, or nothing. The tip says which kind of run this was (`io.total_bytes_read` of the profile), so that you compare runs of the same kind before you tune.
- **Spilled to disk.** The statement wrote to the temporary directory (`system.peak_temp_dir_size`); the tip shows its peak memory and the memory limit of the session. Raise the limit with `SET memory_limit = '...'` in this editor if the machine has the memory free, or give sorts, joins and aggregates less data.
- **Maintenance.** A table that a scan read for at least a tenth of the time needs what the [Maintenance Advisor](advisor.md) would recommend for it: rewrite the files with many deleted rows, merge small files, flush inlined rows. The script is the Advisor's.
- **Many columns.** A scan that took at least a fifth of the time read four columns or more that hold at least 16 MiB together in the table (as DuckLake recorded their sizes); the tip lists the largest. Not when a `LIMIT` without `ORDER BY` stops the scan early, as Select Top 1000 Rows does.

The tips read the catalog through the explorer, not through the session of the editor, so they never touch your transaction; without a connected explorer only the tips from the profile itself (cold or warm, spilled) appear. A Parquet footer is read in a separate read-only session, and only for a file below the data path. The tips wait at most 5 seconds: after a failure or a timeout the profile shows without them, and the log says why. They are measured at the newest snapshot, which is what the editor reads.

## Run to File

**Run to File...** in the context menu of the editor (and in the `...` menu of its title) writes the whole result of one statement to a CSV, Parquet, JSON or Markdown file, without the row limit of the grid. It takes the selection when it holds one statement, else the statement at the cursor, as Explain does.

1. Only a statement that only reads runs, judged as for Analysis (`readsOnly` of `src/sql/statement-kind.ts`). For any other statement it says why and runs nothing. This keeps a menu entry from running a write by accident; it is no permission check, since the editor runs any SQL you type.
2. A save dialog with the filters CSV, Parquet, JSON (`.json`, `.ndjson`, `.jsonl`) and Markdown (`.md`) proposes `result.csv` in the first workspace folder (else in the home folder). The extension of the chosen file decides the format; another extension is refused. aantje writes local files only.
3. For `.json` a pick of the layout follows: **One object per line (newline-delimited JSON)**, selected first because it suits large results, or **One JSON array**; `.ndjson` and `.jsonl` are one object per line without asking. CSV, Parquet and Markdown ask nothing more.
4. For Markdown the session binds the statement (`DESCRIBE`) and counts its rows (`SELECT count(*) FROM (...)`) first, hidden from the results and the Query History, under a notification with Cancel. Above 10,000 rows (`MARKDOWN_ASK_ROWS`) a modal dialog asks before the file is written, since nobody reads a table that long; declining runs nothing more.
5. The statement runs in the session of the editor, with its transaction, temporary tables and settings, as `COPY (<statement>) TO '<file>' (...)`: with the progress notification, Cancel and the results panel of a run. There is no grid; the Messages tab has one line with the rows written, the file and the time. The Query History records the COPY statement as a run, so opening the entry writes the same file again. The explorer is not refreshed, because writing a file changes no catalog.

The file:

- **CSV** is UTF-8 without a byte order mark, with a header row and commas (`FORMAT csv, HEADER true, DELIMITER ','`). DuckDB quotes a field with a comma, a quote or a line break. NULL is an empty field, an empty text `""`. Every value and column name is written exactly as DuckDB writes it; a text that starts like a spreadsheet formula (`=`, `+`, `-`, `@`) stays as it is ([Security](security.md#the-data-grid)).
- **Parquet** keeps the DuckDB types and is compressed with zstd (`FORMAT parquet, COMPRESSION zstd`).
- **JSON** is DuckDB's (`FORMAT json`, with `ARRAY true` for one array): one object per row, nested values nested, BIGINT and DECIMAL as DuckDB writes them, NULL as `null`.
- **Markdown** is a pipe table with a header row. DuckDB has no Markdown writer, so a `SELECT` around the statement builds the line of each row and the CSV writer puts the lines out as they are (`FORMAT csv, HEADER false, QUOTE '', ESCAPE ''`, the header as `PREFIX`). Values and column names follow the rules of the Markdown export of the grid ([Data grid](grid.md#what-the-grid-shows-and-can-do)): `|`, backslashes and what would render as Markdown or HTML are escaped, a line break becomes `<br>`, structs, maps, lists and arrays are their JSON text, and NULL is an empty cell or `NULL` (`aantje.export.markdownNull`).
- The path is a quoted literal (`quoteLiteral`) and every column name a quoted identifier. aantje writes only the file chosen in the dialog.
- **Cancel or a failure leaves no partial file.** DuckDB 2.0 deletes a file it was writing when the statement is interrupted or fails, and writes over an existing file through a temporary file, so the old file stays when the run does not end. aantje also deletes the file after a cancel or a failure, but only when there was no file before.
- **Quack.** The `COPY` runs in the DuckDB of the session, on this machine, which reads from the Quack server; the file is written locally, as on every other kind of catalog.
- A file that cannot be written (access denied, open in another program) fails with a message that names the file.

## Parameters

A script can leave values and names open and get them at each run, so that it is not edited for every date range, id or table, and a missing quote cannot break it. There are two kinds of placeholders, asked for in one dialog:

- **`$name` is a value.** aantje binds it to the prepared statement, so the value never becomes SQL text: no quoting, no injection. It stands where a value goes (`WHERE day >= $since`), never for a name.
- **`{{name}}` is text** for what cannot be bound: a schema, table or column name, a path. aantje replaces it before the script runs, by the type of the parameter: an `identifier` becomes a quoted identifier (`"gold"`), a `text` a quoted literal (`'north'`), a `number` the checked number (a negative one in parentheses), a `date` a `DATE '2026-11-16'`. A qualified name takes one placeholder per part: `{{schema}}.{{table}}`.
- **`$name{default}` is a value with its default** where it is used: `LIMIT $limit{1000}`, `WHERE region = $region{north}`. The `{` follows the name without a blank, and the default runs to the matching `}` on the same line, without a `;`; a brace or `;` inside quotes does not count. A text in single quotes is that text without its quotes (`$code{'0}42'}`). `{}` gives no default. A `{` without its `}` on that line is left as it is, and DuckDB reports it. `{{name}}` takes no inline default; the header gives it one.

Placeholders are found by DuckDB's tokens: a `$` or `{{` in a string, a `$$` block, a quoted name or a comment is none. `$1` and `?` are not named and stay DuckDB's own.

**A `$name` where a name goes gets a warning.** A name cannot be bound, so the check while typing ([SQL IntelliSense](sql-intellisense.md)) marks a `$name`, with or without its default, that comes right after `FROM`, `JOIN` of any kind, `INTO`, `UPDATE`, `TABLE` (`CREATE TABLE`, `DROP TABLE`, `TRUNCATE TABLE`), `VIEW`, `TRUNCATE`, `USE`, `DESCRIBE`, `SUMMARIZE` or `IF [NOT] EXISTS`, or right before or after the `.` of a qualified name (`gold.$table`, `$schema.orders`). The warning says what to write instead: `{{name}}` where the name goes, declared as `-- param: name | identifier`, and one placeholder per part of a qualified name. So `SELECT * FROM $table{"gold"."fact_order"} LIMIT $limit{15000}` becomes:

```sql
-- param: schema | identifier | gold
-- param: table | identifier | fact_order
SELECT * FROM {{schema}}.{{table}} LIMIT $limit{15000};
```

DuckDB mostly reports such a statement as a syntax error at the `$`. The warning takes the place of a syntax error inside its placeholder, so that it is what the editor shows there; a syntax error anywhere else stays. Other places of a name, such as `FROM a, $b`, get no warning and keep DuckDB's syntax error. A `$name` as the argument of a function (`FROM read_parquet($path)`), as a value (`WHERE day >= $since`, `LIMIT $limit`, `IS DISTINCT FROM $v`, `extract(year FROM $day)`, `substring($s FROM $n)`), as the file of `COPY t FROM $file` or with a function called on its value (`$code.upper()`) gets no warning. The tokens decide, so a word in a string or a comment never counts.

**DuckDB never sees an inline default.** Wherever aantje hands the SQL of the editor to DuckDB, it reads `$limit{1000}` as `$limit` followed by blanks of the same length: the runs of Run Query, Run Statement, the lenses, Run CTE with Limit, Explain, Analysis, Statistics and Run to File (also the `DESCRIBE` that binds its columns), the questions before a change, which read the planned statement, and the check while typing. So no syntax error comes from the braces, and offsets and error positions stay those of the document. Results, the Query History and **Open as New Query** keep the statement as written, braces included.

**The queries that aantje opens ask for their row limit.** New Query on a table or view, Script as SELECT, Open as SQL of Query at Snapshot, the History and changes scripts of a table and the call of a table macro end in `LIMIT $limit{1000}` ([DDL generation](ddl.md#the-script-as-submenu)). Their run asks for the limit and proposes 1000, or the value given last in the document; Escape cancels the run. On a Quack connection the limit is a variable, as above. The reads that aantje runs itself (Select Top 1000 Rows in the grid, Data Compare) and the notebooks keep their fixed limit.

**Declarations.** The comment lines at the start of the document (the header) may declare the parameters, one per line:

```sql
-- param: since | date | 2026-01-01 | First day of the period
-- param: tbl | identifier | fact_sales
-- param: region
SELECT * FROM gold.{{tbl}} WHERE day >= $since AND region = $region;
```

The fields are `name | type | default | description`; all but the name are optional. The type is `text` (the default), `number`, `date` (`YYYY-MM-DD`) or `identifier`. A parameter that the header does not declare takes its type from its inline default: a number is a `number`, a `YYYY-MM-DD` day a `date`, anything else and a text in quotes a `text`, so `LIMIT $limit{1000}` binds an integer. Without an inline default it is a `text` without a default. A line that aantje cannot read (a name that is no plain identifier, an unknown type, a default that does not fit its type, a name declared twice) is skipped, and the run says which.

**Which default counts.** The header wins: its type always counts, and so does its default. A parameter without a default in the header takes the first inline default of its name in the document, also when a statement runs alone and the default is written at another use. The check while typing marks every other inline default that differs ([SQL IntelliSense](sql-intellisense.md)). An inline default that does not fit the declared type is shown in the dialog with the type's message.

**The dialog.** When the statements to run contain placeholders, **Run Query**, **Run Statement at Cursor**, **Execute**, **Explain**, **Analysis**, **Statistics**, **Run CTE with Limit...** and **Run to File...** first ask for their values: one input box per parameter in a row of steps, with the name, the type, the description and the last value of this document (else the default). The value is checked against its type while you type. Enter goes to the next parameter and runs after the last, **Back** returns to the one before, Escape cancels the run before anything runs. A parameter named like a secret (`key`, `secret`, `token`, `password`, `credential`, `connection_string`) is typed hidden. Only the parameters of the statements that run are asked for. **Set Parameters...** in the context menu and the `...` menu of the editor asks for all parameters of the document without a run. An `identifier` used as `$name` is refused before the dialog, because a name cannot be bound.

The last values are kept per document while the window is open, and forgotten when the document closes. A default that was changed in the text since a value was given wins over that value: write `$limit{500}` where `$limit{1000}` stood, and the next run proposes 500; with the same default the last value stays. Results, error positions and the Query History show the statements as written, with their placeholders; an error inside a replaced `{{name}}` marks the whole placeholder.

**Quack.** The quack extension of DuckDB 2.0 loses bound parameters ([Quack catalogs](driver-quack.md#parameters)). On a Quack connection aantje therefore sets each value as a variable of the session (`SET VARIABLE "since" = DATE '2026-01-01'`) right before the statement and runs it with `getvariable('since')` in place of `$since`, replaced by the tokens, never inside a string or a comment. The variables stay in the session; a variable of yours with the same name is overwritten. DuckDB compares variable names without case, so `$Since` and `$since` are one variable there. An inline default is gone before that: `LIMIT $limit{1000}` runs as `LIMIT getvariable('limit')`, which DuckDB 2.0 takes as well as a bound number.

The module `src/sql/parameters.ts` (declarations, placeholders, replacement, checks, the memory of the last values) and the dialog `src/sql/parameters.vscode.ts` have no dependency on the run code, so that other places that fill SQL in can use the same declarations and the same dialog:

```ts
parseParameterHeader(text): { declarations: ParameterDeclaration[]; problems: string[] };
findPlaceholders(text, tokens: readonly SqlToken[]): Placeholder[];
scriptParameters(declarations, placeholders, defaults = placeholders): ScriptParameter[];
initialValues(parameters, remembered): Record<string, string>;
valueProblem(type, value): string | undefined;
usageProblem(parameter): string | undefined;
runParameters(parameters, answers): { parameters: RunParameters } | { problem: string };
sqlText(type, value): string;
replacePlaceholders(text, placeholders, replacement): Substitution;
withoutDefault(placeholder): string | undefined;
unusedDefaults(declarations, placeholders): Diagnostic[];
boundNames(tokens: readonly SqlToken[], placeholders): Diagnostic[];
class ParameterMemory { get(scope); remember(scope, values); forget(scope) }
askParameterValues(parameters, initial, title): Promise<Record<string, string> | undefined>;
```

To fill a text: `findPlaceholders` on its text and DuckDB's tokens of it, `scriptParameters` with the declarations of its header (and the placeholders of the whole document as `defaults`), the dialog, `runParameters` to check the answers, then `replacePlaceholders` with the SQL text of each `{{name}}` (`RunParameters.text`); a `$name` is left to the run, which binds `RunParameters.values`. A `Placeholder` of `$name{default}` covers the braces and carries the default; before such a text goes to DuckDB, `replacePlaceholders` with `withoutDefault` turns it into `$name` and blanks. A text that opens in an editor keeps it, so that its run asks with that default. **Use** of a template does exactly this ([Templates](templates.md#use)), and **Save Selection as Template...** keeps a selection with the `-- param:` lines of the document that it uses.

## Documents and connections

The registry in `src/sql/editor.ts` maps a document's URI to a connection id. It lives in memory: a restart forgets it, and saving an untitled document opens a new document, so the connection has to be selected again. A document without a connection gets nothing from aantje: no completion, hover, marks or keys.

The editor closes a session and forgets the document when the document closes. A removed connection takes its documents with it; a connection whose profile is edited (not just renamed) closes its sessions, which open again at the next run.

## Sessions

A document that **Script as Update** of Data Compare opens across two connections has a second connection: its session attaches the source read-only as `"source_lake"`, with secrets of their own names and the storage secret limited to the data path of the source, and masks the secrets of both ([Data Compare](compare.md#script-as-update-of-data-compare)). Editing or removing the source closes the session.

Every editor has its own session ([SQL session](sql-session.md)), so a transaction in one editor does not touch another. The session opens lazily at the first run, with the same data access as the data preview (PostgreSQL password or Quack token and S3 credentials from the secret storage, `aantje.s3.*`, `aantje.duckdb.extensionDirectory`), in the mode of the profile. The first run may download DuckDB extensions; a progress notification shows it.

Closing a session with an open transaction rolls it back and says `Rolled back the open transaction of <editor>`. That happens when the document closes, the mode switches, the connection changes or you close the session from the menu.

### Read-only sessions

`readOnly` in the profile makes the sessions of that connection read-only: the lake is attached `READ_ONLY` and DuckLake refuses every statement that writes, with a message that names the switch. **Toggle Read-only Session** changes the mode of one editor only: it closes the session and the next run opens the other mode. An edit of the profile resets the choice. What the mode guarantees is in [What read-only means](sql-session.md#what-read-only-means). A Quack connection has no read-only mode ([Quack catalogs](#quack-catalogs)).

### DuckDB file catalogs

A writable session locks a DuckDB catalog file exclusively, so the explorer could not read it. Before it opens a writable session on a DuckDB file, the editor disconnects the explorer from that connection. Once the session is open it says `Disconnected the explorer from <name> while the editor has it open for writing`. If the session does not open (an error or Cancel), the editor connects the explorer again. When the session closes, the editor connects the explorer again, but only if it was the one that disconnected it, and not when the connection was removed or the extension shuts down. The tree is not refreshed after runs on such a session. A read-only session shares the file with the explorer, which is why the wizard suggests it for DuckDB files.

### Quack catalogs

A Quack server has no file lock, so a writable session leaves the explorer connected: the tree, completion with table and column names and the refresh after a committed change work while the session is open, and other clients may write at the same time. The sessions of a Quack connection have no read-only mode. The read-only switch exists to avoid the lock of a DuckDB file and is no write protection, and Quack cannot be attached `READ_ONLY` anyway (DuckDB 2.0.0 does not enforce it, newer quack builds refuse it). The status bar menu does not offer the switch, and **Toggle Read-only Session** explains that the server decides what its token may do. Permissions are the server's job: the token and its `quack_authorization_function`. After a restart of the server the session fails with a message that says to close it and run again.

## Running SQL

A run does the following:

1. Without a connection it asks for one (a quick pick) or stops when cancelled.
2. A second run in the same editor while one is active only shows `A query is already running in this editor.`
3. It tells the results view that a run begins (`begin`, then `reveal`).
4. It shows the progress notification `Running SQL on <name>...` with Cancel, opens the session if needed and forwards every event of `session.run` to the results view in order. `maxRows` is `aantje.sql.maxRows`, read at every run; the session also gets the cell room the results view keeps (below).
5. It tells the results view that the run ended (cancelled or failed, duration, transaction state). A session that cannot open becomes one `error` event, not an exception. A results view that throws never leaves the editor in the running state: a failing `begin` or `reveal` becomes the error of the run, and the next run works.

Cancel (the button, **Cancel Query**, `Shift+F5`) interrupts the running statement and skips the rest; the session stays usable. Closing the document or removing its connection cancels a running query too. A mode switch or new connection is refused while a query runs (`A query is running in this editor. Cancel it first.`).

### UPDATE and DELETE without WHERE

Before a statement of a run starts, aantje looks at its tokens (`unfilteredWrite` of `src/sql/statement-kind.ts`). An `UPDATE` or `DELETE FROM`, also after a `WITH`, that has no `WHERE` outside parentheses, or one that is always true (`WHERE true`, `WHERE 1 = 1`), stops the run before it. aantje counts the rows of its table with `SELECT count(*) FROM <table as written>` in the same session, so the count sees the open transaction, and asks in a modal dialog: `DELETE without WHERE removes all 297,221 rows of gold.fact_sales.` The dialog says how many statements of the run ran before it, and names the way back: DuckLake keeps the old snapshot, so **Restore Table to Snapshot...** ([Time travel](time-travel.md#restore-table-to-snapshot)) brings the rows back until the snapshot is expired.

- **Run Anyway** runs it, **Run Anyway for This Session** runs it and every further one until the session closes, **Cancel** (or Escape) ends the run there as cancelled; what ran before stays.
- A count that takes longer than 3 seconds is given up, and the dialog says `all rows` without the number. Outside a transaction the count is interrupted; inside one an interrupt would abort the transaction, so it runs on, and the statement waits for it.
- `aantje.sql.confirmUnfilteredWrites` (default `true`) turns the question off. A read-only session never asks, and the MCP tools never write.
- This is a guard against mistakes, no permission check: what a user may change is decided by the catalog database and the storage. `TRUNCATE`, `DROP` and a `MERGE` without condition are not asked about.

### Where the results open

The first run of a document opens its results in an editor group below the editor, without taking the focus. VS Code has no view column "below" (`ViewColumn.Beside` follows a user setting), so `src/grid/results.vscode.ts` reads the editor group layout and `src/grid/results-place.ts` decides: if a group lies directly below in a stacked layout, the panel opens there as one more tab; otherwise the editor's group is split down (`workbench.action.newGroupBelow`). Groups next to the editor are left alone. Further runs reuse the panel, and other documents of the same group put their results as tabs in the same group below. If the layout cannot be read, the panel opens beside the editor. If no panel can be made, a message says `Could not open the results panel: <reason>` and the run goes on without one. There is no setting for the position.

### Results bound to their editor

VS Code lets no extension draw into a text editor, so the query and its results are a bound pair of editors: the SQL editor keeps every language feature, and the results panel lives in the group below it. `ResultsPanels` watches the tab groups (`vscode.window.tabGroups`) and the active editor; the events of one user action are taken together (100 ms), and `src/grid/results-binding.ts` decides from a snapshot of the groups:

- **Close.** When no group shows the document any more, its results close. A document that is still open in another group keeps them.
- **Follow.** When the editor sits in another group than the one its results were placed for (it was moved, dragged, or its group was closed), the panel goes below the new group, which is made if needed. The page loads again there and gets the whole run. A document that is open in two groups keeps its results under the editor they were placed for while that one is open; otherwise the active one, else the first, owns them.
- **Come forward.** When a query becomes the active editor while the results of another query cover its results, its results come forward, without the focus. A file or another panel that the user put in front stays.
- **Lock.** The group that aantje makes below an editor is locked (`workbench.action.lockEditorGroup`), so files the user opens land elsewhere. A group below that already existed is the user's and stays unlocked. An editor that is moved into a locked results group unlocks it, because it is an editor group then.

**Hide Results** closes the panel and keeps the run; a group that is left empty closes too, so the query gets the whole height; when the results of other queries share the group below, it stays and shows theirs. **Show Results** places a new panel below the editor and shows the same run again, without running it. A run while the results are hidden shows them again. Closing the results tab by hand forgets the run, as before; the next run opens a new panel. Every run also puts results that were dragged elsewhere back below the editor.

VS Code tells the extension late about a group that it closed. Before it places or moves a panel, `ResultsPanels` waits until the groups it sees agree with the layout (up to 1 second), so that it never acts on a column that belongs to another group by now.

### Results that are too big

The results view keeps at most `MAX_RESULT_CELLS` (2,000,000 cells over all result sets of a run; `src/sql/results.ts`). The editor passes it to the session as `maxCells`, which stops reading a result set at the rows that fit and marks it `truncated`; later result sets get what is left. This holds back the extension host's memory before a result is built.

### The explorer after a run

After a run in which a statement that may change the catalog succeeded and was committed, the editor makes the explorer read the connection again, so the tree shows the new snapshot and tables. A statement is judged by DuckDB's tokens, with the same rule that decides the Analysis lens (`src/sql/statement-kind.ts`): `DESCRIBE`, `SHOW`, `PRAGMA`, `SET`, `RESET`, `USE`, `BEGIN`, `START`, `ROLLBACK`, `ABORT`, `LOAD` and `INSTALL` cannot change it; a query (`SELECT`, `WITH`, `FROM`, `VALUES`, `TABLE`) and `SUMMARIZE` count when they carry a keyword that writes or call a function that does (see [No Analysis for a statement that does more than read](#execute-explain-analysis-and-statistics)), such as `SELECT * FROM ducklake_expire_snapshots(...)`; `EXPLAIN` counts only as `EXPLAIN ANALYZE` of such a statement; every other kind counts (`COMMIT`, `CALL`, `CHECKPOINT`, `COPY` too). A word in a string or a comment does not count; an unquoted column named like a writing keyword (`load`) causes a needless but harmless refresh. The refresh also marks the open report panels of the connection as out of date (see [Reports](reports.md#the-shell)), so a Storage report does not keep showing the scheduled files that a clean-up just deleted.

Changes inside a transaction become visible with the `COMMIT`; `ROLLBACK` refreshes nothing. A change committed before the run ended (the run was cancelled, the document closed) still refreshes. So does one committed before a `BEGIN` at the end of the script: the transaction that the `BEGIN` opens does not hold it back. The tree is untouched when the connection is not connected, and for a writable session on a DuckDB file.

### Transactions

`BEGIN` opens a transaction that lasts across runs of the same editor until `COMMIT` or `ROLLBACK`. The status bar says `transaction open`, or `transaction aborted` after an error that aborted it. Each commit creates one DuckLake snapshot.

### Commit messages

DuckLake stores an author, a commit message and extra info per snapshot (`ducklake_snapshot_changes`), which the Snapshots folder, the [Snapshot report](snapshot-report.md) and the [Activity report](activity-report.md) show. `set_commit_message` sets them for the transaction that it runs in, before or after its writes; a call outside a transaction sets nothing, and the last call of a transaction counts.

A run that commits a change asks once, before its first statement, in a quick pick: **Commit message (optional)**. A change is committed by a statement that may change the catalog (the rule of [The explorer after a run](#the-explorer-after-a-run)) outside a transaction, or by the `COMMIT` (or `END`) of an open transaction in which such a statement ran, in this run or in an earlier one.

- **The field is empty, and empty is fine:** Enter on it runs without a message, exactly as without the question. Escape cancels the run before anything runs. The last five messages of the connection follow as items to pick; they are kept with the Query History of the connection ([Query History](#query-history)).
- **Outside a transaction** each such statement commits itself and makes one snapshot. aantje keeps that: with a message it runs each one as `BEGIN; CALL lake.set_commit_message(...); <statement>; COMMIT`, so that every snapshot of the run gets the message and the number of snapshots stays the same. The results show only the statement; a statement that fails rolls its transaction back, also when the `COMMIT` fails (a conflict with another writer).
- **Inside an explicit transaction** the question comes with the run that holds the `COMMIT`, and the call goes right before the `COMMIT`; a transaction that only read, and an aborted one (its `COMMIT` rolls back), ask nothing. Several runs between `BEGIN` and `COMMIT` ask nothing.
- **The author** is `aantje.commitAuthor`; empty means the user of a PostgreSQL connection (for an Entra login its UPN). On SQLite, DuckDB and Quack connections an empty setting records no author. The author is set only together with a message.
- `aantje.sql.askCommitMessage` (default `true`) turns the question off. A read-only session, a run that only reads, Explain and Run to File (whose `COPY` writes a local file) never ask.
- `CHECKPOINT` commits the snapshots of its flush and merge itself, so they get no message (DuckDB 2.0).

The scripts that aantje opens with a transaction carry the call as a comment with a suggested message, right after `BEGIN TRANSACTION`: Restore Table to Snapshot, Restore Dropped Object, Script as Update of Data Compare and the sort order script of the performance tips. Remove the `-- ` to use it; a message given in the question comes later and counts. The scripts of Maintenance and Script as Update of Schema Compare have no transaction of their own, so a commented call would set nothing; the question gives their snapshots a message when they run.

If a statement fails because the lake cannot be read (a missing data file, a refused request), the error appears in the results panel. **Check Health** and **Check Table Health** find out what is wrong ([Health check](health-check.md#the-panel)).

## Query History

Every statement that the editor runs with **Run Query**, **Run Statement at Cursor**, **Execute** of the CodeLens or **Run to File...** (as its `COPY` statement) goes into the folder **Query History** of the connection ([Tree](tree.md#query-history)). There is one entry per statement, so a script with five statements gives five entries, failed and cancelled ones included. The statements after a failure or a cancel did not run and get none. Execute on a CTE records the statement that aantje built. A script that does not parse, or a run whose session does not open, becomes one failed entry with the whole script.

Not recorded: Explain, Analysis and Statistics, notebook cells, the reads of the explorer and the reports, and what the results panel runs in the session of the editor for itself: the statistics of the columns ([The statistics of the columns](grid.md#the-statistics-of-the-columns)), Aggregate in DuckDB ([The chart of a result](grid.md#the-chart-of-a-result)) and the count before a Markdown file of Run to File. These run only a statement that only reads, hidden from the results; a run of the editor cancels them.

A statement with placeholders is recorded as written, with `$name`, its inline defaults and `{{name}}`; the values it used are kept in a field of their own and shown in the tooltip, the value of a parameter named like a secret as `***`, and so is its inline default (`$api_token{'***'}`). Opening the entry asks for the values again at the next run.

An entry holds the statement, when it started, how long it ran, the rows it returned (and whether there were more) or changed, the status (`ok`, `failed` or `cancelled`) and the error message. A double-click on it opens the statement in a new SQL document of the connection; nothing runs until you run it. A single click only selects it, and **Open as New Query** in its context menu opens it too, also with the keyboard ([Tree](tree.md#query-history)).

- **Where.** In the global state of VS Code on this machine (the key `aantje.queryHistory`), as the trust in views. It survives a restart. It is not synchronised and not in the workspace or the profile file. Newest first, at most `aantje.queryHistory.size` entries per connection (default 25, at most 1000). A smaller size drops the oldest entries; `0` records nothing, hides the folder and deletes what is stored, the favourites included.
- **Secrets.** Before an entry is stored, its statement and error go through `maskSecrets` with the secrets of the session (PostgreSQL password, Quack token, S3 keys, Azure token), as the messages of the session do. `CREATE [OR REPLACE] [PERSISTENT|TEMPORARY] SECRET` keeps its option names and the values of `TYPE` and `PROVIDER`; every other value becomes `'***'`. The same holds for the value of a `SET` of a setting or variable whose name contains `key`, `secret`, `token`, `password`, `credential` or `connection_string`, for the inline default of a parameter named so, and for the password of a connection string in a literal (`password=...`, `scheme://user:password@`). An error message loses the values that were masked in its statement too. Every secret that aantje knows on this machine (the ones the output channel masks) is masked too, also in a run whose session did not open. The masking works on the tokens of a small lexer (`src/sql/history-mask.ts`), so the rest of the statement stays as written; what the lexer cannot follow (an unterminated string or option list) is masked to the end of the statement. See [Security](security.md#the-sql-editor).
- **Length.** A statement over 64 KiB (in UTF-8) is stored cut at a whole character, and its tooltip says so. An error message is kept up to 4000 characters.
- **Commit messages.** The last five commit messages of a connection ([Commit messages](#commit-messages)) are kept with its history under the key `aantje.commitMessages`; Clear Query History and removing the connection delete them (favourites stay with Clear Query History), and with `aantje.queryHistory.size` set to `0` none are kept.
- **Connections.** Removing a connection, also with Delete Azure DuckLake, deletes its history, its favourites and its commit messages. Editing it keeps them, because the id stays.
- **Favourites.** **Set as Favorite** on an entry keeps a copy of it in the folder **Favorites** at the top of the Query History ([Tree](tree.md#query-history)). Favourites are stored in the same global state under their own key (`aantje.queryHistory.favorites`), as the masked entry they copy, at most 1000 per connection (the oldest goes); a label of your own loses every secret that aantje knows on this machine, as the output channel does. They stay when the history rotates and when **Clear Query History** deletes the entries; size `0` deletes them with the history. **Rename...** keeps the names of the favourites of a connection unique: it refuses a name that another favourite already shows (its name, or its statement while it has none), ignoring case and the spaces around it; an empty name shows the statement again.

`QueryEditors.run` records only a `RunScript` with `record`; Run Query, Run Statement, the Execute lens and Run to File set it. `RunRecord` (`src/sql/history.ts`) turns the events of the run into statements: a `start` opens one, its `resultSet`, `message` or `error` ends it. At the end of the run the editor hands them to `QueryHistory.record` with `session.mask`. A failing write is logged and never fails the run.

## IntelliSense wiring

`src/extension.ts` creates one language service ([SQL IntelliSense](sql-intellisense.md)) and disposes it on deactivation. Its `connectionOf` is the registry above. Its `catalogOf` is the catalog of the explorer's reader at the newest snapshot the explorer knows, which is what the session queries, also while the tree shows a pinned snapshot (`catalogCache`: one `SqlCatalog` per connection, rebuilt when the reader or snapshot changes), or none while the explorer is not connected: keywords, functions and syntax marks work without it, the warnings for unknown names need it. When the explorer reads the lake again, the open documents are checked again (`onDidChangeCatalog`). When a document gets a connection and the explorer is not connected, aantje connects it once, unless a writable session holds a DuckDB file.

## Settings

| Setting                              | Default | Meaning                                                                                                                                 |
| ------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `aantje.sql.maxRows`                 | `10000` | The most rows kept of one result, 1 to 1000000 (machine scope). The rest is not read.                                                   |
| `aantje.sql.codeLens`                | `true`  | Execute, Explain, Analysis and Statistics above each query and CTE (machine scope).                                                     |
| `aantje.sql.cteRowLimit`             | `100`   | The `LIMIT` of Execute on a CTE, 1 to 1000000 (machine scope).                                                                          |
| `aantje.sql.formatKeywordCase`       | `upper` | Keywords in upper or lower case, or as written, when Format Document runs (machine scope).                                              |
| `aantje.sql.askCommitMessage`        | `true`  | Asks once per run that commits a change for the commit message of its snapshots ([Commit messages](#commit-messages)).                  |
| `aantje.commitAuthor`                | `""`    | The author recorded with a commit message; empty: the user of a PostgreSQL connection, else none ([Commit messages](#commit-messages)). |
| `aantje.sql.confirmUnfilteredWrites` | `true`  | Asks before an `UPDATE` or `DELETE` without `WHERE` runs ([UPDATE and DELETE without WHERE](#update-and-delete-without-where)).         |
| `aantje.queryHistory.size`           | `25`    | Statements kept per connection in the Query History, 0 to 1000 (machine scope). 0: none.                                                |
| `aantje.export.markdownNull`         | `empty` | A NULL in a Markdown table: an empty cell, or `NULL` (machine scope).                                                                   |
| `readOnly` (profile)                 | absent  | Open the connection's sessions read-only. Absent or `false`: writable. Not for Quack.                                                   |

## Limits

- DuckLake has no `OPTIMIZE` statement and `VACUUM` has no effect on a lake; the equivalents are `CHECKPOINT lake;` and the `ducklake_*` functions, run as `CALL ...` (the **Maintenance** submenu writes them, see [Maintenance scripts](maintenance.md)). The editor attaches the lake as `lake`.
- The document-to-connection association is not stored.
- One run at a time per editor; several editors on one connection run side by side, each with its own session. Several writable sessions on one SQLite, PostgreSQL or Quack catalog behave like several writers: a conflicting commit fails with the DuckLake message and can be repeated.
- The refresh rule reads DuckDB's tokens; it does not parse SQL or look into macros, so a macro that calls a writing function does not refresh the tree; use Refresh.
- Changing a connection's password or token does not close an open session; it keeps the one it opened with.
- On a Quack catalog `CALL lake.set_option(...)` is not undone by `ROLLBACK` (DuckDB 2.0.0).
- Results are cut at `aantje.sql.maxRows` rows and 2,000,000 cells per run; sorting and filtering in the panel work on the loaded rows. **Run to File...** writes all rows of a statement to a file.
- Completion needs the explorer connected for table and column names; for a writable DuckDB file session it is not.
- The query and its results are two editor groups, not one tab: the divider between them is the one between the groups. A results tab can still be dragged elsewhere by hand; it goes back below its editor on the next move of the editor or the next run. The results of a query in a floating window open beside it, and the binding waits up to a second for the groups there before it acts.
