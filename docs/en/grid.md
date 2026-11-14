# Data grid

The data grid shows the rows of **Select Top 1000 Rows** (`aantje.previewTable`) in a VS Code webview, like the result grid of SQL Server Management Studio. The query runs in the extension host ([Data access](data-access.md)); the grid sorts, filters, copies and exports the rows that were loaded and sends nothing back to the database. The same page also shows the results of the SQL editor and the changes of a table. The notebook for the same table is in [Notebooks](notebooks.md).

## What the grid shows and can do

- A sticky header with the column name, the DuckDB type (`DECIMAL(10,2)`, `STRUCT(...)`), a sort indicator and a filter box per column.
- A running row number, zebra stripes and the colours of the active VS Code theme (light, dark, high contrast).
- `NULL` cells show dimmed, italic `NULL`; an empty string is an empty cell. A screen reader announces a real NULL as "no value (SQL NULL)".
- Numbers are right aligned. Nested values (`STRUCT`, `LIST`, `MAP`, `ARRAY`, `UNION`) are JSON text. A cell draws at most 2000 characters; a value longer than 60 characters has a tooltip with up to 1000. Copy and export use the full value.
- A status line: `1000 rows (more rows exist) · 12 ms`; with a filter `3 of 1000 rows (more rows exist) · 12 ms`.
- Only the visible rows and 100 rows around them are in the page. Two spacers stand for the rest, so the scroll bar covers all rows. A hidden row holds the longest text of each column, so widths stay put while you scroll. Sort, filter, copy and export always work on all rows.

| Action                 | How                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Sort                   | Click a header: ascending, descending, original order.                                             |
| Filter                 | Type into the box of a column. The boxes combine with AND; the table updates on a pause.           |
| Move the selection     | Click a cell, or arrow keys, `Home`, `End`.                                                        |
| Copy the selected cell | `Ctrl+C` or **Copy cell**. With text selected, `Ctrl+C` copies that text.                          |
| Copy the row / all     | **Copy row** (row of the selected cell) and **Copy all** (rows shown, with header), tab separated. |
| Export                 | **Export CSV**: the rows shown, saved through a file dialog as `schema.table.csv`.                 |

Rules (all in `src/grid/model.ts`):

- **Sorting** is stable. Numbers compare by value; `BIGINT`, `HUGEINT` and `DECIMAL` arrive as strings and compare digit by digit, so no precision is lost. `false` sorts before `true`. Text uses a numeric, case- and accent-insensitive collation (`item 2` before `item 10`). **NULL is always last**, in both directions.
- **Filtering** matches a case-insensitive substring of the displayed text, as typed (spaces count). The filter `NULL` selects the NULL cells, `!NULL` the others. A NULL cell never matches a plain substring: `nul` finds the text `nullable`, not NULLs.
- **Copy and export** use the full value; NULL becomes an empty field. Copying a single NULL cell leaves the clipboard alone and the status line says `NULL: nothing copied`. Sort and filter apply: you copy what you see.
- **CSV** follows RFC 4180 (comma, CRLF, header row, UTF-8 without a byte order mark). With one column an empty field is written as `""`, so NULL rows do not vanish.
- **Formulas are neutralised.** In text cells and column names a value starting with `=`, `+`, `@`, `-`, a tab or a carriage return gets a leading `'`, in the CSV and in **Copy row** and **Copy all** (which quote tabs, line breaks and quotes). A text that is a plain number (`-5`) stays. Numbers, booleans and nested values are never changed. **Copy cell** keeps the exact value, because it is meant for SQL or text, not for a spreadsheet.

## The changes of a table

**Show Changes...** and **Show Rows Changed** ([Time travel](time-travel.md#show-changes)) open this grid with the rows a table gained, lost or changed between two snapshots. The data is an ordinary `GridData` with two optional fields; without them the grid renders as usual.

- `rowKinds`: per row `insert`, `delete`, `update-before` or `update-after`. An update is two adjacent rows. The page uses the kinds only when `rowKindsOf` (`src/grid/protocol.ts`) accepts them (one per row, all known, updates paired, columns `snapshot_id`, `rowid`, `change_type` in front); otherwise it draws an ordinary grid.
- `summary`: one line above the rows, written by the data layer ([Data access](data-access.md#changes-between-snapshots)), for example `4 inserted, 1 updated, 1 deleted (6 changes) after @15 until @18`.

| Row kind        | Mark | Look                                                         |
| --------------- | ---- | ------------------------------------------------------------ |
| `insert`        | `+`  | Inserted-text background of the theme                        |
| `delete`        | `−`  | Removed-text background of the theme                         |
| `update-before` | `←`  | Neutral tint; changed cells in the colour of a deleted row   |
| `update-after`  | `→`  | Neutral tint; changed cells in the colour of an inserted row |

- **The mark does not depend on colour.** A narrow column behind the row number shows it, with a title and accessible name. In high contrast the rows get lines instead of fills.
- **Changed cells** of an update are bold with a dotted underline and the tooltip `Changed by the update`. A NULL that stays NULL is no change; `snapshot_id`, `rowid` and `change_type` never count.
- **No sorting and no filter.** Either would separate the row before an update from the row after it. The rows keep the order of the changes. Use **Copy all** or **Export CSV** to work on them elsewhere.
- Copy and export include `snapshot_id`, `rowid` and `change_type`, not the mark column. The status line counts the rows of the grid; the summary counts all changes of the range.

## Results mode

The SQL editor ([SQL session](sql-session.md)) shows what a run returns in the same page and bundle (`dist/grid-client.js`). The page switches to this mode on the first `results-*` message. `ResultsPanels` (`src/grid/results.vscode.ts`) implements the port `ResultsView` of `src/sql/results.ts`: `begin`, `event` (every event of the run), `end`, `reveal`; `collapse` and `isCollapsed` serve Hide and Show Results.

### The panel

- One panel per editor document. The first run opens it in a group below the editor without taking the focus ([Where the results open](sql-editor.md#where-the-results-open)); later runs reuse it. `begin` does not bring a hidden panel forward, `reveal` does.
- The panel is bound to its editor ([Results bound to their editor](sql-editor.md#results-bound-to-their-editor)): it closes with the last tab of its document, follows the editor into another group and comes forward when its query becomes active while the results of another query cover it. The decisions are in `src/grid/results-binding.ts`, free of the VS Code API.
- **Hide Results** (`collapse(key, true)`) closes the panel and keeps the run; **Show Results** or the next run makes a new panel below the editor, whose page gets the whole run on `ready`.
- The title is `<editor title> · results`.
- Closing the panel by hand does not touch the session and forgets the run. Events for a closed panel are dropped; the next run opens a new one.
- Copy and export use the same `GridDeps` as the data grid; **Export CSV** suggests `result-<n>.csv`.

### What the page shows

- **Tabs.** `Messages` comes first. Each result set gets `Result 1 (1,234 rows)`; a cut one reads `Result 1 (10,000 of more rows)` and a banner says that sort, filter and export apply to the rows read. Tab names never come from the SQL text.
- **Selected tab.** `Messages` while the run goes on or has no result set, else the first result set. A tab the user clicked stays selected; a new run starts again.
- **A result tab** shows the statement on one line (at most 200 characters, as text) above a full grid. Each grid is built when its tab is first selected and keeps sort and filter while the page lives.
- **The Messages tab** has one line per statement: a status mark (`✓` OK, `✗` error, `…` running, `–` not run), the number, the statement (80 characters), the result (`3 rows affected`, `12 rows`) and the time. A failed statement shows the whole friendly message and **Go to statement**; a script that does not parse shows the syntax error.
- **The end of the run** is shown at the bottom and in the tab bar (a live region): `Running...`, `Completed in 1.2 s` (milliseconds below a second, as in the status line of a grid and in the health report), `Cancelled after ...` or `Failed after ...`, plus `Transaction open` or `Transaction aborted: run ROLLBACK`.
- **Go to statement** posts `{ type: 'reveal', index }`. The extension answers with the position of the error, else the start and length of the statement. An index that is not a known whole number does nothing.

### Messages, live updates and memory

Extension to page: `results-begin`, `results-event`, `results-end` and `results-state` (the whole run, for a page that loads later). The page draws a message only when `isResultsMessage` accepts its exact shape. The run state is built by the same reducer (`applyMessage`, `src/grid/results-model.ts`) in the page and in the extension, so a live page and a reloaded page agree.

- `ResultsRun` (`src/grid/results.ts`) keeps the last run of each editor. Before the page says `ready` nothing is posted; the page then gets one `results-state`, then events one by one.
- A hidden panel loses its page (no retained context). When shown again it loads, says `ready` and gets the whole run again.
- **The cap is 2,000,000 cells** (`MAX_RESULT_CELLS`, rows times columns over all result sets of a run). The editor passes it to the session as `maxCells` ([SQL session](sql-session.md)): a result that fits stays whole, one that does not is cut to whole rows and marked truncated, and later result sets get what is left. A new run replaces the last one. Only the first line of the script is kept.

## The page, the policy and why there is no inline data

`webviewHtml` (`src/shell/page-html.ts`) returns a page with this policy:

```text
default-src 'none'; style-src 'nonce-<nonce>'; script-src 'nonce-<nonce>'; base-uri 'none'; form-action 'none'
```

- Only the script tags with the nonce run: one on the grid page, and on the results page `plan-client.js` before it. There is no `unsafe-inline`, no `unsafe-eval`, no event handler attribute and no `style` attribute. The one exception is the height of the two spacers, which the script sets through the CSSOM; the policy only refuses style attributes in markup.
- The panel comes from `createPanel` (`src/shell/host.vscode.ts`), shared by every webview panel of aantje. The nonce is random per panel; `localResourceRoots` is the `dist` directory only; all values that go into the page are HTML-escaped.
- **The page contains no data.** Rows arrive by `postMessage`, so a table, column or cell value from the catalog can never end up in markup. The client writes everything with `textContent`, never `innerHTML`.
- There is no `img-src`, `font-src` or `connect-src`: nothing else is loaded. See [Security](security.md#the-data-grid).

## Accessibility

- The grid is a native `<table>` and not `role="grid"`: the cells are static text, and screen reader users keep their own table navigation. `aria-rowcount` and `aria-rowindex` give the position in the whole result although only some rows are in the page.
- One cell is the tab stop (roving `tabindex`); arrow keys move inside. When the selected cell is scrolled out of the drawn rows, the table body keeps the focus until the next arrow key.
- A sorted header carries `aria-sort`. The status line is a polite live region and announces filter counts and `NULL: nothing copied`. Filter boxes are labelled `Filter <column>`.
- `Ctrl+C` leaves the browser alone while text is selected.

## Build and packaging

`esbuild.mjs` bundles `src/grid/client.ts` to `dist/grid-client.js` (browser, `iife`, `es2022`, minified in production, no source map; about 16 kB). It contains only code of this repository. Without it the panel stays empty.

## Limits

- At most 1000 rows (`PREVIEW_LIMIT`). Sort and filter work on the loaded rows: sorting a truncated result does not show the smallest or largest rows of the table. The status line says when more rows exist.
- Every drawn row has all its columns, so hundreds of columns still draw slowly. Filtering compares the full text of every cell on each change; megabytes per cell make it noticeably slow.
- Rows are assumed to have the height measured at first; a taller value (an emoji from a fallback font) shifts the rows below by those pixels. Column widths come from the longest text (at most 200 characters), so a column can grow a little while you scroll.
- Find in page and mouse selection reach only drawn rows; Copy all and Export CSV take all rows.
- Chromium lays out elements up to about 33 million pixels. That is about 1.5 million rows at 22 px, more than `aantje.sql.maxRows` allows (1,000,000); with a much larger font the last rows of such a result cannot be scrolled to.
- Nested values are text; they cannot be expanded or filtered by field.
- Some Excel versions open a UTF-8 file without byte order mark with the wrong code page; import it as UTF-8.
- **Copy cell** is exact, so pasting it into a spreadsheet can run a formula. [Security](security.md#the-data-grid) explains the risk.
- Panels are not restored after a restart of VS Code, and a hidden tab loses scroll position and selected cell.
- A change grid cannot be sorted or filtered and holds at most 1000 rows (999 when the cut would separate an update from its first row).
- Results mode keeps only the last run of an editor, only while the extension runs. Sort and filter see only the rows read (10,000 per result by default, 2,000,000 cells in total). The chosen tab is forgotten when the page reloads.
