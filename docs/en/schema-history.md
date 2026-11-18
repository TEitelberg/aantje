# Schema History

**Schema History** (`aantje.showSchemaHistory`) opens a webview report of one table in two tabs. **Compare** sets the table at one snapshot beside the table at another: every column with its name, type, nullability, default and comment at both, and what changed between them. **Search Changes** lists every change of one column, from the newest snapshot back to the first. It answers "how did this table change between then and now" and "when was this column added, renamed, widened or dropped, and by whom", and opens the follow-ups: the `CREATE TABLE` at the two snapshots side by side, and the `ALTER` statements. Everything comes from the `ducklake_*` tables through the read-only drivers of the explorer.

## Opening the report

- **Where.** In the **Reports** submenu of the context menu of a table ([Reports](reports.md)), and by clicking the **History** leaf of a table ([Tree](tree.md#the-folders-of-a-table)). The command is hidden from the Command Palette.
- **One panel per connection and table.** The title is `Schema History: main.evolved · Lake`, with the current name of the table. Opening the same table again reveals the panel and sends fresh data.
- **Progress and Cancel.** The read runs under a notification with a Cancel button, which stops the statements the engine can stop (PostgreSQL, DuckDB). A connection that is not open gives a hint to connect first.
- **Refresh** reads the history again and keeps the choices. An end of the comparison that sat at the oldest or newest snapshot stays there, so a new snapshot is not hidden; an end the user chose stays as long as the snapshot is still there.
- **A hidden panel keeps its choices** (the tab, From and To, the filters, the column of Search Changes) with the webview `getState`/`setState`. A snapshot or column that is gone falls back to the oldest or newest snapshot, or to no column.
- The tabs follow the WAI-ARIA pattern of the other reports with tabs: only the selected tab is in the tab order, the arrow keys, Home and End move between them.
- A removed or closed connection gives a message on Refresh and on every action.

## Compare

- **From and To** stand side by side on one line. Each is a drop-down of the snapshots the comparison can use, newest first, each with the time it was made (`@30 · 2026-10-30 12:43 UTC`): every snapshot that changed the schema of the table (it was created, renamed or dropped, or a column was added, renamed, dropped, or got another type, nullability, default, comment or position), the oldest version read when older ones were not read, and the newest snapshot of the catalog (`@56 · latest`) while the table exists. An expired snapshot reads `expired`. The comparison starts from the oldest of them and ends at the newest.
- **The table** has a row for each column that the table had at From or at To, one for each column id: a renamed column stays one row, labelled `title (formerly name)`, and a struct field is a row of its own below its parent. Rows follow the table order of the newest version; a dropped column stays where it was. **From** and **To** show the column at each snapshot: its type, `NOT NULL`, `DEFAULT ...` and the comment, with its name in front where it had another one then; `–` where the column was not there. **Changes** says what changed from From to To, as **Compare Table at Two Snapshots** does, by a sign and words, without colour:

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

A To before From compares backwards. A column that moved to another parent counts as dropped and added. A legend under the table spells out the signs.

- **Column** matches any name the column ever had, ignoring case. A matching field brings its parents.
- **Kinds of change.** Each of the eight kinds can be switched off; while one is off, only the columns with a change of a kind that is on are left.
- **Compare Schema** opens the diff editor over the `CREATE TABLE` at the two snapshots and the summary, as **Compare Table at Two Snapshots**, the older snapshot on the left. It is offered when the two snapshots differ and the table exists at both.
- **Script as ALTER** in the header opens the **Script as ALTER** template for the newest state in an SQL editor of the connection; nothing runs. It is offered while the table exists.

At most 100 rows are drawn; a note says how many were left out, and the column filter reaches them.

## Search Changes

**Column** is a drop-down of every column the table ever had, once each by its id, with its current or last name (`title (formerly name)`, `extra (dropped)`). Choosing one lists every change of its schema, newest first: the snapshot, its time (UTC), the change in the words of the table above, and the author and commit message where the catalog has them. Only the snapshots that changed that column are listed; a snapshot that changed it in two ways has a line for each.

## Open as Markdown

**Open as Markdown** in the header opens an untitled document: the table, From and To with their times, the filters as text, the comparison as filtered with the legend, the changes of the column of Search Changes while that tab is shown and a column is chosen, and the snapshots between From and To that changed the schema, newest first, with time, author, message and what they did to the table. `schemaHistoryMarkdown` in `src/schema-history/markdown.ts` builds it. Catalog text is code formatted; the comparison stops at 100 rows.

## Data and limits

`CatalogReader.schemaHistory(tableId, limit, signal)` returns `{ versions, more }`. The report asks for the newest 100 versions (`VERSION_LIMIT`).

- `buildHistory` (`src/schema-history/model.ts`) compares consecutive versions with `diffColumns`, matching columns by id, and keeps the state of each column after every version that changed it. The page builds the table at From and at To from these states and compares the two with `diffColumns` again; it computes the filters.
- With `more`, the oldest version read is only the starting point: it shows no change, but the comparison can start there; a note says older versions are not read.
- A version whose snapshot expired keeps its place; its time reads `expired` and it has no author. Catalogs of specification 1.0 have no author or message.
- A column that moves to another parent (same id) is reported as dropped and added.

## Security

The page uses the policy of the other reports (`default-src 'none'`, nonce for style and script, `localResourceRoots` is `dist` and `media` for the logo of the header). Data arrives by `postMessage` after the page says `ready`.

- Catalog text (names, types, defaults, authors, messages, connection name) is put into the page with `textContent`.
- The page asks for an action by id and numbers only: `ready`, `refresh`, `markdown` with a view of the right shape, `compareSchema` with the two snapshots, or `scriptAlter`. No command id or free text can be part of it. The extension checks the numbers against the data it sent (`planSchemaHistoryAction`: both snapshots are offered and the table exists at both) and ignores and logs a mismatch.
- The page checks what it receives (`isSchemaHistoryMessage`) as the extension checks what it sends.
- The page makes no request. Actions that read table data are the tree's, with their own safeguards.

## Known limits

- The report reads the newest 100 schema versions of a table.
- Rows beyond the first 100 are not drawn until the column filter names them.
- The comparison names the state at two snapshots; what happened in between is in Search Changes and in the list of snapshots of the document.
- Column ids are unique per table only; a column under another parent is a drop and an addition.
