# SQL editor

The SQL editor runs SQL against a DuckLake from an ordinary SQL document. The explorer only reads; the editor runs any SQL (SELECT, but also CREATE, INSERT, UPDATE, DELETE, ALTER, DROP) with the rights of the connection's credentials. This page covers use, the document-to-connection mapping, sessions, what a run does, settings, the API of `src/sql/editor.ts` and limits. The session is in [SQL session](sql-session.md), completion, the marks while typing and their quick fixes in [SQL IntelliSense](sql-intellisense.md), the results panel in [Data grid](grid.md).

## Using it

1. Right-click a connected connection, schema, table or view and choose **New Query**, or run **aantje: New Query** from the Command Palette (it asks for the connection when there are several). A new untitled SQL document opens and belongs to that connection. For a table or view it holds **Script as SELECT**; otherwise it is empty. The commands of the **Script as** submenu ([DDL generation](ddl.md#the-scripts-by-node-kind)), of **Maintenance** ([Maintenance scripts](maintenance.md)) and **Open as SQL** of Query at Snapshot ([Time travel](time-travel.md#open-as-sql)) open their text the same way, in a document that belongs to the node's connection. Opening never runs anything: a DROP script runs only when you run it, and a read-only session refuses it.
2. For a SQL document you already have, run **aantje: Select Connection for Query...** or click the status bar item. Running a document without a connection asks for one first, also when there is only one; New Query takes the only connection without asking. Without any connection both say to add one.
3. Run the document with `F5`, or the statement under the cursor with `Ctrl+Enter`. The results open in a panel below the editor, which stays with the editor: it follows it into another group, comes forward with it and closes with it. **Hide Results** in the editor title (or `Ctrl+Alt+R`) gives the query the whole height; **Show Results** brings the last run back.

| Command                        | Id                                         | Key                                 |
| ------------------------------ | ------------------------------------------ | ----------------------------------- |
| New Query                      | `aantje.newQuery`                          |                                     |
| Select Connection for Query... | `aantje.selectQueryConnection`             |                                     |
| Run Query                      | `aantje.runQuery`                          | `F5`                                |
| Run Statement at Cursor        | `aantje.runStatement`                      | `Ctrl+Enter` (`Cmd+Enter` on macOS) |
| Cancel Query                   | `aantje.cancelQuery`                       | `Shift+F5`                          |
| Toggle Results                 | `aantje.toggleResults`                     | `Ctrl+Alt+R`                        |
| Hide Results, Show Results     | `aantje.hideResults`, `aantje.showResults` | (editor title)                      |
| Toggle Read-only Session       | `aantje.toggleReadOnly`                    |                                     |
| Query Session...               | `aantje.queryMenu`                         |                                     |

**Run Query** runs the selection when it holds more than blanks, else the whole document. **Run Statement at Cursor** runs the statement that contains the cursor. A statement owns the text from its first word up to the first word of the next one, so a cursor behind the `;`, in blanks or in a comment picks the previous statement. Statements come from DuckDB's tokenizer, so a `;` in a string, a quoted name, a comment or a `$$` block does not split.

The keys apply only where `editorTextFocus && editorLangId == sql && aantje.queryEditor` holds. `aantje.queryEditor` is set while the active editor is a SQL document with a connection, so aantje does not take `F5` and `Ctrl+Enter` from other SQL extensions or from documents without a connection. `aantje.queryRunning` is set while the active editor runs a query: the run icon turns into the stop icon, and `Shift+F5` is bound only then. `aantje.queryHasResults` is set while the active editor has results (shown or hidden) and `aantje.queryResultsCollapsed` while they are hidden: the title shows **Hide Results** (`$(layout-panel)`) or **Show Results** (`$(layout-panel-off)`), and `Ctrl+Alt+R` and **Toggle Results** in the Command Palette exist only then. VS Code gives an extension command one icon, so the two buttons are two commands.

The status bar item (`$(database) Fixture · read/write` or `read-only`, plus ` · transaction open` or ` · transaction aborted`) is shown while the active editor has a connection. Its menu: Select Connection, switch the mode (not on a Quack connection), Cancel Query (while it runs), Close Session.

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

After a run in which a statement that may change the catalog succeeded and was committed, the editor makes the explorer read the connection again, so the tree shows the new snapshot and tables. A statement is judged by its first word (`changesCatalog`): `SELECT`, `VALUES`, `FROM`, `TABLE`, `DESCRIBE`, `SHOW`, `SUMMARIZE`, `PRAGMA`, `SET`, `RESET`, `USE`, `BEGIN`, `START`, `ROLLBACK`, `ABORT`, `LOAD` and `INSTALL` cannot change it; every other kind counts (`COMMIT`, `CALL`, `CHECKPOINT`, `COPY` too). `WITH` counts when it carries `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER` or `COPY`; `EXPLAIN` only as `EXPLAIN ANALYZE` of such a statement. A writing word inside a string causes a needless but harmless refresh. The refresh also marks the open report panels of the connection as out of date (see [Reports](reports.md#the-shell)), so a Storage report does not keep showing the scheduled files that a clean-up just deleted.

Changes inside a transaction become visible with the `COMMIT`; `ROLLBACK` refreshes nothing. A change committed before the run ended (the run was cancelled, the document closed) still refreshes. So does one committed before a `BEGIN` at the end of the script: the transaction that the `BEGIN` opens does not hold it back. The tree is untouched when the connection is not connected, and for a writable session on a DuckDB file.

### Transactions

`BEGIN` opens a transaction that lasts across runs of the same editor until `COMMIT` or `ROLLBACK`. The status bar says `transaction open`, or `transaction aborted` after an error that aborted it. Each commit creates one DuckLake snapshot.

If a statement fails because the lake cannot be read (a missing data file, a refused request), the error appears in the results panel. **Check Health** and **Check Table Health** find out what is wrong ([Health check](health-check.md#the-panel)).

## IntelliSense wiring

`src/extension.ts` creates one language service ([SQL IntelliSense](sql-intellisense.md)) and disposes it on deactivation. Its `connectionOf` is the registry above. Its `catalogOf` is the catalog of the explorer's reader at the newest snapshot the explorer knows, which is what the session queries, also while the tree shows a pinned snapshot (`catalogCache`: one `SqlCatalog` per connection, rebuilt when the reader or snapshot changes), or none while the explorer is not connected: keywords, functions and syntax marks work without it, the warnings for unknown names need it. When the explorer reads the lake again, the open documents are checked again (`onDidChangeCatalog`). When a document gets a connection and the explorer is not connected, aantje connects it once, unless a writable session holds a DuckDB file.

## Settings

| Setting              | Default | Meaning                                                                               |
| -------------------- | ------- | ------------------------------------------------------------------------------------- |
| `aantje.sql.maxRows` | `10000` | The most rows kept of one result, 1 to 1000000 (machine scope). The rest is not read. |
| `readOnly` (profile) | absent  | Open the connection's sessions read-only. Absent or `false`: writable. Not for Quack. |

## Public API

```ts
// src/sql/results.ts: the port that the results panel implements
export interface ResultsView {
  begin(target: ResultsTarget, script: { text: string; startedAt: number }): void;
  event(target: ResultsTarget, event: SqlEvent): void;
  end(target: ResultsTarget, summary: RunSummary): void;
  reveal(target: ResultsTarget): void;
}

// src/sql/editor.ts
export class QueryEditors {
  constructor(deps: QueryEditorDeps);
  onDidChange(listener): { dispose(): void };
  connectionOf(key: string): string | undefined;
  state(key: string): QueryEditorState | undefined;
  associate(editor: EditorRef, connectionId: string): Promise<void>;
  run(editor: EditorRef, script: { text: string; base: number }): Promise<RunSummary | undefined>;
  cancel(key: string): void;
  toggleMode(key: string): Promise<void>;
  closeSessionOf(key: string): Promise<void>;
  documentClosed(key: string): Promise<void>;
  profilesChanged(): Promise<void>;
  scriptRange(key: string, offset: number, length: number): { offset: number; length: number } | undefined;
  dispose(): Promise<void>;
}
// pure helpers: statementAt, scriptToRun, changesCatalog, holdsFileExclusively, queryStatusContent, queryMenuItems, catalogCache
```

- The core takes its environment through ports (`QueryEditorDeps`): the profiles, `openSession`, the `ResultsView`, an `ExplorerPort` (`status`, `disconnect`, `connect`, `refresh`), a `QueryUi` (`info`, `pickConnection`, `withProgress`) and `maxRows`. `src/sql/editor.vscode.ts` implements the UI, commands, status bar item and context keys; `src/extension.ts` wires everything.
- `base` is where the script that ran starts in the document, so `scriptRange` maps a failing statement's range back to the document for **Go to statement**.
- `run` never throws for a failing statement or a session that does not open; it reports them as events and returns `undefined` when nothing ran.

## Limits

- DuckLake has no `OPTIMIZE` statement and `VACUUM` has no effect on a lake; the equivalents are `CHECKPOINT lake;` and the `ducklake_*` functions, run as `CALL ...` (the **Maintenance** submenu writes them, see [Maintenance scripts](maintenance.md)). The editor attaches the lake as `lake`.
- The document-to-connection association is not stored.
- One run at a time per editor; several editors on one connection run side by side, each with its own session. Several writable sessions on one SQLite, PostgreSQL or Quack catalog behave like several writers: a conflicting commit fails with the DuckLake message and can be repeated.
- The refresh rule reads the first word and, for `WITH` and `EXPLAIN`, the statement text; it does not parse SQL. A macro or function that writes refreshes only as far as its first word says; use Refresh.
- Changing a connection's password or token does not close an open session; it keeps the one it opened with.
- On a Quack catalog `CALL lake.set_option(...)` is not undone by `ROLLBACK` (DuckDB 2.0.0).
- Results are cut at `aantje.sql.maxRows` rows and 2,000,000 cells per run; sorting and filtering in the panel work on the loaded rows.
- Completion needs the explorer connected for table and column names; for a writable DuckDB file session it is not.
- The query and its results are two editor groups, not one tab: the divider between them is the one between the groups. A results tab can still be dragged elsewhere by hand; it goes back below its editor on the next move of the editor or the next run. The results of a query in a floating window open beside it, and the binding waits up to a second for the groups there before it acts.

## Testing

```bash
npx vitest run test/unit/sql-editor.test.ts
npm run test:integration
```

The unit tests run the real engine on private copies of the data fixtures with a fake results view, explorer and UI (lazy open, modes, rollback, cancel, refresh rule, DuckDB file rule, statement at cursor with hostile texts). `test/integration/sql-editor.test.ts` runs the commands, keys, context keys and session menu in a real VS Code, and `test/integration/results-panel.test.ts` the placement and the binding of the results (close, follow, come forward, lock, hide and show). `test/unit/results-binding.test.ts` holds the decisions of the binding.
