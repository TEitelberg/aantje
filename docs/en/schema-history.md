# Schema History

**Schema History** (`aantje.showSchemaHistory`) opens a webview report of one table: a matrix with one row for each column the table ever had and one column for each snapshot in which its schema changed. It answers "when was this column added, renamed, widened or dropped, and by whom", and starts the follow-up actions: compare two snapshots, show the catalog at a snapshot, query the table as it was, script the `ALTER` statements. Everything comes from the `ducklake_*` tables through the read-only drivers of the explorer.

## Opening the report

- **Where.** In the **Reports** submenu of the context menu of a table ([Reports](reports.md)), and by clicking the **History** leaf of a table ([Tree](tree.md#the-folders-of-a-table)). The command is hidden from the Command Palette.
- **One panel per connection and table.** The title is `Schema History of main.evolved · Lake`, with the current name of the table. Opening the same table again reveals the panel and sends fresh data.
- **Progress and Cancel.** The read runs under a notification with a Cancel button, which stops the statements the engine can stop (PostgreSQL, DuckDB). A connection that is not open gives a hint to connect first.
- **Refresh** reads the history again and keeps the choices. A range end that sat at the oldest or newest snapshot stays there, so a new snapshot is not hidden.
- **A hidden panel keeps its choices** (filters, selected snapshot and column) with the webview `getState`/`setState`. A snapshot that is gone selects nothing.
- A removed or closed connection gives a message on Refresh and on every action.

## The matrix

- **Rows are columns of the table**, one for each column id across all its versions. A renamed column stays one row, labelled `title (formerly name)`. A struct field is a row of its own below its parent. Rows follow the table order of the newest version; a dropped column stays where it was.
- **Columns are snapshots** in which something changed: the table was created, renamed or dropped, or a column was added, renamed, dropped, or got another type, nullability, default, comment or position. Each heading is a button `@30` with the time. A **Table** row holds what the snapshot did to the table itself (`created as main.evolving`, `renamed main.evolving → main.evolved`, `dropped (shop.old_stuff)`).
- **Now** is the type in the newest version. When the whole table was dropped, the columns say `table dropped` and the drop is one event in the **Table** row.
- **Cells** say what happened, by a sign and words, without colour:

| Kind                | Sign | Text                               |
| ------------------- | ---- | ---------------------------------- |
| Added               | `+`  | `+ added: varchar`                 |
| Dropped             | `−`  | `− dropped`                        |
| Renamed             | `↔`  | `↔ renamed: name → title`          |
| Type changed        | `Δ`  | `Δ type: int32 → int64`            |
| Nullability changed | `!`  | `! now NOT NULL`, `! now nullable` |
| Default changed     | `=`  | `= default: false → true`          |
| Comment changed     | `#`  | `# comment changed`                |
| Moved               | `↕`  | `↕ moved: position 3 → 1`          |

The first snapshot shows every column as added. A column can have several cells in one snapshot. A dropped struct reports its fields as dropped, as `diffColumns` does. Cells and headings are buttons: Tab moves between them, Enter or Space selects. A legend under the filters spells out the signs.

## Filters

- **Column** matches any name the column ever had, ignoring case. A matching field brings its parents.
- **Kinds of change.** Each of the eight kinds can be switched off. Columns without a visible cell drop out while a kind or the range leaves changes out.
- **From / To** limit the snapshots (both included).

At most 100 rows are drawn; a note says how many were left out, and the column filter reaches them.

## The detail pane and the actions

A click on a cell selects its snapshot and column; a click on a heading selects the snapshot. The pane shows time, author, commit message, what the snapshot did to the table and every change of the snapshot, with the selected column in bold. The buttons run the implementations of the commands of the same name with an explicit target.

| Button                          | What happens                                                                                            | Offered when                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Show catalog at @N              | The tree shows the catalog at snapshot N                                                                | always                                                              |
| Query...                        | Top 1000 Rows, Create Notebook or Open as SQL for the table at N, under the name it had then            | the table exists after N                                            |
| Compare Schema with previous @P | Diff editor over the `CREATE TABLE` of two snapshots and the summary, as **Compare Schema**             | the table exists after N and a version precedes it                  |
| Compare Schema with latest @L   | The same against the newest snapshot                                                                    | the table exists after N and at the newest snapshot, which is later |
| Script as ALTER                 | The **Script as ALTER** template for the newest state, in an SQL editor of the connection; nothing runs | the table exists at the newest snapshot                             |

`previous` is the snapshot of the version before the selected one, not necessarily N-1. See [Time travel](time-travel.md) for the commands.

## Open as Markdown

**Open as Markdown** in the header opens an untitled document of the matrix as filtered: the table, the filters as text, the matrix with its **Table** row, the legend, and the snapshots newest first with time, author, message and events. `schemaHistoryMarkdown` in `src/schema-history/markdown.ts` builds it. Catalog text is code formatted; the matrix stops at 100 rows.

## Data and limits

`CatalogReader.schemaHistory(tableId, limit, signal)` returns `{ versions, more }` ([Catalog reader](catalog-reader.md#snapshot-details-and-changes)). The report asks for the newest 100 versions (`VERSION_LIMIT`).

- `buildHistory` (`src/schema-history/model.ts`) compares consecutive versions with `diffColumns`, matching columns by id. The page computes the filters.
- With `more`, the oldest version read is only the starting point and shows no change; a note says older versions are not read.
- A version whose snapshot expired keeps its place; its heading says `expired` and it has no author. Catalogs of specification 1.0 have no author or message.
- A column that moves to another parent (same id) is reported as dropped and added.

## Security

The page uses the policy of the other reports (`default-src 'none'`, nonce for style and script, `localResourceRoots` is `dist`). Data arrives by `postMessage` after the page says `ready`.

- Catalog text (names, types, defaults, authors, messages, connection name) is put into the page with `textContent`.
- The page asks for an action by id and numbers only: `ready`, `refresh`, `markdown` with a view of the right shape, or one of the four action ids with the snapshot and choice it needs. No command id or free text can be part of it. The extension checks the numbers against the data it sent (`planSchemaHistoryAction`) and ignores and logs a mismatch.
- The page checks what it receives (`isSchemaHistoryMessage`) as the extension checks what it sends.
- The page makes no request. Actions that read table data are the tree's, with their own safeguards.

## Modules

| File                                      | Job                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `reader/history.ts`, `queries/history.ts` | `schemaHistory` and its statements                                                        |
| `src/schema-history/model.ts`             | `buildHistory`, cell texts and signs, filters and the 100 rows, the detail pane. Pure.    |
| `src/schema-history/actions.ts`           | Action ids, compare targets, `planSchemaHistoryAction`. Pure.                             |
| `src/schema-history/protocol.ts`          | Messages and their guards. Pure.                                                          |
| `src/schema-history/state.ts`             | The choices kept for a hidden panel or refresh. Pure.                                     |
| `src/schema-history/markdown.ts`          | `schemaHistoryMarkdown`. Pure.                                                            |
| `src/schema-history/kind.ts`, `style.ts`  | The report kind for the shell: view type, stylesheet, guards, `toMarkdown`                |
| `src/schema-history/page.ts`, `render.ts` | Browser side: state and events; DOM builders. Registered in `src/shell/client.ts`.        |
| `src/schema-history/read.ts`              | `readSchemaHistory`: history and newest snapshot in one call                              |
| `src/schema-history/execute.ts`           | `performSchemaHistoryAction`: the actions of the snapshot report, plus the ALTER template |
| `src/schema-history/commands.vscode.ts`   | The command, progress, panel and the action port (`src/shell/report-port.vscode.ts`)      |

## Tests

Unit tests cover the model (cell by cell on the history fixture), actions, protocol guards, the Markdown document and the browser bundle against a DOM stand-in. A contract test runs `schemaHistory` on SQLite, DuckDB and PostgreSQL; an integration test runs the panel and its actions in VS Code.

```text
npx vitest run test/unit/schema-history-model.test.ts test/unit/schema-history-client.test.ts test/contract/schema-history.contract.test.ts
```

## Known limits

- The report reads the newest 100 schema versions of a table.
- Rows beyond the first 100 are not drawn until the column filter names them.
- Column ids are unique per table only; a column under another parent is a drop and an addition.
