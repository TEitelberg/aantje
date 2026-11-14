# SQL editor

The SQL editor runs SQL against a DuckLake from an ordinary SQL document. The explorer only reads; the editor runs any SQL (SELECT, but also CREATE, INSERT, UPDATE, DELETE, ALTER, DROP) with the rights of the connection's credentials. This page covers use, the document-to-connection mapping, sessions, what a run does, the Query History, settings, the API of `src/sql/editor.ts` and limits. The session is in [SQL session](sql-session.md), completion, the marks while typing and their quick fixes in [SQL IntelliSense](sql-intellisense.md), the results panel in [Data grid](grid.md).

## Using it

1. Right-click a connected connection, schema, table or view and choose **New Query**, or run **aantje: New Query** from the Command Palette (it asks for the connection when there are several). A new untitled SQL document opens and belongs to that connection. For a table or view it holds **Script as SELECT**; otherwise it is empty. The commands of the **Script as** submenu ([DDL generation](ddl.md#the-scripts-by-node-kind)), of **Maintenance** ([Maintenance scripts](maintenance.md)) and **Open as SQL** of Query at Snapshot ([Time travel](time-travel.md#open-as-sql)) open their text the same way, in a document that belongs to the node's connection. Opening never runs anything: a DROP script runs only when you run it, and a read-only session refuses it.
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

**Formatting never changes what the SQL means.** Before aantje changes the text, DuckDB tokenizes it before and after: the tokens must be the same in the same order, apart from the case of keywords and unquoted names, and every comment must still be there. Otherwise aantje leaves the text as it was and says so; the same for SQL that the formatter cannot read, such as a statement that is still being typed. Other SQL files of the workspace are left to other extensions; when you have another SQL formatter, VS Code asks once which one to use.

## Execute, Explain, Analysis and Statistics

Above every query of an editor with a connection a CodeLens offers four actions for that one statement: **Execute | Explain | Analysis | Statistics**. The same four are in the context menu of the editor and in the `...` menu of its title, where they act on the selection when it holds one statement, else on the statement at the cursor. `aantje.sql.codeLens` switches the lens off.

- **Execute** runs the statement, the same as Run Statement at Cursor.
- **Explain** runs `EXPLAIN`: DuckDB shows the plan and executes nothing.
- **Analysis** runs `EXPLAIN ANALYZE`: DuckDB executes the statement and shows the plan with the time and rows of each operator.
- **Statistics** runs the statement with DuckDB's profiler and shows its operators in four tabs: **Statistics**, a table with one row per operator, indented as in the plan, with its branch (the table that an input of a join reads), its own time and share, its rows, the estimate and its details; **Flame Graph**, each operator as a bar as long as its own time and that of its inputs, the result on top and its inputs below, on the axis of the cumulated time (the mouse wheel zooms into narrow bars); **Treemap & Top Operators**, the operators' own time grouped by type beside the twelve costliest operators; and **Text Statistics**, all figures of the profile as text: total and CPU time, rows and row groups scanned, bytes read and written, peak memory, then the operators. All views colour an operator by its kind: scans blue, joins yellow, aggregates orange, CTEs green, filters, sorts and windows purple, the rest grey. **Copy Statistics** copies the table as tab-separated text.

Explain and Analysis ask DuckDB for the plan in JSON (`EXPLAIN (FORMAT JSON)`, `EXPLAIN (ANALYZE, FORMAT JSON)`) and draw it in a tab named **Execution Plan**, laid out like the plans of SQL Server Management Studio: the result in the top left corner, each operator in a tile, its first input in the same row to the right and each further input below, arrows pointing from the inputs to the operator that reads them and as thick as the rows that flow. A tile shows a symbol for the kind of operator, its name (`Hash Join (Inner)`), its table or main detail, and one figure per line: for Analysis the cost (its share of the time of all operators), its time and the rows as `72 of 2,249 (3%)`, actual of estimated; for Explain the estimated rows. Tiles are tinted green; Analysis fills the operators that took more than half (red) or a quarter (orange) of the slowest one's time. **The time of an operator adds up all threads that ran it**, as DuckDB measures it, so it can exceed the total time of the query: in a query of 18 ms on 8 threads, an operator can show 90 ms. The tile, its tooltip, the Statistics table and the tooltips of the charts say so (`all threads`), and the summaries of the plan and of the Statistics table say that it can exceed the total; the total time in the summary is the time of the query. Hovering a tile shows all its details in a tooltip that follows the mouse, wraps and stays inside the view. A click on a tile pins its tooltip, so that the mouse can go into it and scroll a long one; a click on that tile again or on a free spot, or the mouse over another tile, releases it. **Copy Plan (JSON)** copies the plan as DuckDB returned it, and **Copy** above Text Statistics or a plan in text copies the whole output. The plan opens at a readable size; **−**, **+**, **Fit** and **100%** zoom, as does Ctrl and the mouse wheel, and dragging moves it. An `EXPLAIN` that you type yourself keeps DuckDB's text and shows it in the editor font. Cancel, the session mode and the transaction state work as with Run Statement. All four also work on a Quack connection: the plan and the profile are those of the session's DuckDB, which reads from the server.

**Where the lens appears.** Above statements that contain a query: `SELECT`, `WITH`, `FROM`, `VALUES`, `TABLE`, and writes built on a query (`INSERT … SELECT`, `CREATE TABLE … AS SELECT`, `COPY (SELECT …) TO …`). Not above plain DDL such as `DROP`, nor in SQL files without a connection. A `CREATE VIEW` or `CREATE MACRO` only stores its query, so it gets no lens of its own; the CTEs of its query keep theirs.

**No Analysis for a statement that does more than read.** `EXPLAIN ANALYZE` executes the statement, so it is offered only when the statement is known to only read; this keeps a plan view from changing data by accident, it is no permission check. The check works on DuckDB's tokens, so a word in a string, a quoted name or a comment does not count. Every keyword that writes counts, also inside a CTE or a subquery (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `TRUNCATE`, `CREATE`, `DROP`, `ALTER`, `COPY`, `ATTACH`, `DETACH`, `CALL`, `CHECKPOINT`, `VACUUM`, `EXPORT`, `IMPORT`, `INSTALL`, `LOAD`), and so do functions that change state or run SQL from a string (`nextval`, `setval`, `query`, the DuckLake functions that write, also behind the lake's name as `lake.merge_adjacent_files()`). What the check does not understand gets no Analysis. From a menu, Analysis on such a statement says why and offers Explain.

**Statistics leaves the session as it was.** It reads `enable_profiling`, `profiling_output` and `profiling_coverage` before the run, lets the profiler write JSON into a temporary file, and puts the settings back afterwards, also after an error or a cancel; the file is deleted. Statistics runs the statement as Execute does, so it is offered for writes too. In an aborted transaction DuckDB refuses to change settings: then the profiler stays on until the next run, for example the `ROLLBACK`, after which aantje restores the settings, and says so.

**A CTE on its own.** In a statement with a `WITH` each CTE of the outermost list gets its own lens, on the line of its name: **Execute (LIMIT 100) | Explain | Analysis | Statistics**. When the CTE starts on the line of the statement, both share one row, and the CTE's part starts with its name: **CTE o: Execute (LIMIT 100)**. aantje builds the statement from the text as written: the CTEs before it and the CTE itself (all of them for `WITH RECURSIVE`), with names, column lists and `MATERIALIZED`, then `SELECT * FROM` the CTE. The editor text stays as it is. The results show the built statement and offer **Open as New Query**; Go to statement has nothing to go to.

- Execute adds `LIMIT n`, n from `aantje.sql.cteRowLimit`. Explain, Analysis and Statistics run without the limit, because a `LIMIT` lets DuckDB stop early and changes the plan. **Run CTE with Limit...** (cursor in the CTE) asks for the action and the limit: 1 for a single row, empty for all rows.
- Only CTEs that only read get a lens, judged on the built statement; this also covers the reading CTEs of an `INSERT … SELECT` or a `CREATE TABLE … AS`, since the built statement leaves the write out. A CTE after one that writes still gets a lens, as long as its own built statement does not include it.
- CTEs nested in a subquery or in another CTE get none.

## Documents and connections

The registry in `src/sql/editor.ts` maps a document's URI to a connection id. It lives in memory: a restart forgets it, and saving an untitled document opens a new document, so the connection has to be selected again. A document without a connection gets nothing from aantje: no completion, hover, marks or keys.

The editor closes a session and forgets the document when the document closes. A removed connection takes its documents with it; a connection whose profile is edited (not just renamed) closes its sessions, which open again at the next run.

## Sessions

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

If a statement fails because the lake cannot be read (a missing data file, a refused request), the error appears in the results panel. **Check Health** and **Check Table Health** find out what is wrong ([Health check](health-check.md#the-panel)).

## Query History

Every statement that the editor runs with **Run Query**, **Run Statement at Cursor** or **Execute** of the CodeLens goes into the folder **Query History** of the connection ([Tree](tree.md#query-history)). There is one entry per statement, so a script with five statements gives five entries, failed and cancelled ones included. The statements after a failure or a cancel did not run and get none. Execute on a CTE records the statement that aantje built. A script that does not parse, or a run whose session does not open, becomes one failed entry with the whole script.

Not recorded: Explain, Analysis and Statistics, notebook cells, and the reads of the explorer and the reports.

An entry holds the statement, when it started, how long it ran, the rows it returned (and whether there were more) or changed, the status (`ok`, `failed` or `cancelled`) and the error message. A click on it opens the statement in a new SQL document of the connection; nothing runs until you run it.

- **Where.** In the global state of VS Code on this machine (the key `aantje.queryHistory`), as the trust in views. It survives a restart. It is not synchronised and not in the workspace or the profile file. Newest first, at most `aantje.queryHistory.size` entries per connection (default 25, at most 1000). A smaller size drops the oldest entries; `0` records nothing, hides the folder and deletes what is stored.
- **Secrets.** Before an entry is stored, its statement and error go through `maskSecrets` with the secrets of the session (PostgreSQL password, Quack token, S3 keys, Azure token), as the messages of the session do. `CREATE [OR REPLACE] [PERSISTENT|TEMPORARY] SECRET` keeps its option names and the values of `TYPE` and `PROVIDER`; every other value becomes `'***'`. The same holds for the value of a `SET` of a setting or variable whose name contains `key`, `secret`, `token`, `password`, `credential` or `connection_string`, and for the password of a connection string in a literal (`password=...`, `scheme://user:password@`). An error message loses the values that were masked in its statement too. Every secret that aantje knows on this machine (the ones the output channel masks) is masked too, also in a run whose session did not open. The masking works on the tokens of a small lexer (`src/sql/history-mask.ts`), so the rest of the statement stays as written; what the lexer cannot follow (an unterminated string or option list) is masked to the end of the statement. See [Security](security.md#the-sql-editor).
- **Length.** A statement over 64 KiB (in UTF-8) is stored cut at a whole character, and its tooltip says so. An error message is kept up to 4000 characters.
- **Connections.** Removing a connection, also with Delete Azure DuckLake, deletes its history. Editing it keeps the history, because the id stays.

`QueryEditors.run` records only a `RunScript` with `record`; Run Query, Run Statement and the Execute lens set it. `RunRecord` (`src/sql/history.ts`) turns the events of the run into statements: a `start` opens one, its `resultSet`, `message` or `error` ends it. At the end of the run the editor hands them to `QueryHistory.record` with `session.mask`. A failing write is logged and never fails the run.

## IntelliSense wiring

`src/extension.ts` creates one language service ([SQL IntelliSense](sql-intellisense.md)) and disposes it on deactivation. Its `connectionOf` is the registry above. Its `catalogOf` is the catalog of the explorer's reader at the newest snapshot the explorer knows, which is what the session queries, also while the tree shows a pinned snapshot (`catalogCache`: one `SqlCatalog` per connection, rebuilt when the reader or snapshot changes), or none while the explorer is not connected: keywords, functions and syntax marks work without it, the warnings for unknown names need it. When the explorer reads the lake again, the open documents are checked again (`onDidChangeCatalog`). When a document gets a connection and the explorer is not connected, aantje connects it once, unless a writable session holds a DuckDB file.

## Settings

| Setting                        | Default | Meaning                                                                                    |
| ------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| ------------------------       | ------- | -------------------------------------------------------------------------------------      |
| `aantje.sql.maxRows`           | `10000` | The most rows kept of one result, 1 to 1000000 (machine scope). The rest is not read.      |
| `aantje.sql.codeLens`          | `true`  | Execute, Explain, Analysis and Statistics above each query and CTE (machine scope).        |
| `aantje.sql.cteRowLimit`       | `100`   | The `LIMIT` of Execute on a CTE, 1 to 1000000 (machine scope).                             |
| `aantje.sql.formatKeywordCase` | `upper` | Keywords in upper or lower case, or as written, when Format Document runs (machine scope). |
| `aantje.queryHistory.size`     | `25`    | Statements kept per connection in the Query History, 0 to 1000 (machine scope). 0: none.   |
| `readOnly` (profile)           | absent  | Open the connection's sessions read-only. Absent or `false`: writable. Not for Quack.      |

## Limits

- DuckLake has no `OPTIMIZE` statement and `VACUUM` has no effect on a lake; the equivalents are `CHECKPOINT lake;` and the `ducklake_*` functions, run as `CALL ...` (the **Maintenance** submenu writes them, see [Maintenance scripts](maintenance.md)). The editor attaches the lake as `lake`.
- The document-to-connection association is not stored.
- One run at a time per editor; several editors on one connection run side by side, each with its own session. Several writable sessions on one SQLite, PostgreSQL or Quack catalog behave like several writers: a conflicting commit fails with the DuckLake message and can be repeated.
- The refresh rule reads DuckDB's tokens; it does not parse SQL or look into macros, so a macro that calls a writing function does not refresh the tree; use Refresh.
- Changing a connection's password or token does not close an open session; it keeps the one it opened with.
- On a Quack catalog `CALL lake.set_option(...)` is not undone by `ROLLBACK` (DuckDB 2.0.0).
- Results are cut at `aantje.sql.maxRows` rows and 2,000,000 cells per run; sorting and filtering in the panel work on the loaded rows.
- Completion needs the explorer connected for table and column names; for a writable DuckDB file session it is not.
- The query and its results are two editor groups, not one tab: the divider between them is the one between the groups. A results tab can still be dragged elsewhere by hand; it goes back below its editor on the next move of the editor or the next run. The results of a query in a floating window open beside it, and the binding waits up to a second for the groups there before it acts.
