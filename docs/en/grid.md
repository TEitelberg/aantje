# Data grid

The data grid shows the rows of **Select Top 1000 Rows** (`aantje.previewTable`) in a VS Code webview, like the result grid of SQL Server Management Studio. The query runs in the extension host ([Data access](data-access.md)); the grid sorts, filters, copies and exports the rows that were loaded and sends nothing back to the database. The same page also shows the results of the SQL editor and the changes of a table. The notebook for the same table is in [Notebooks](notebooks.md).

## What the grid shows and can do

- A sticky header with the column name, the DuckDB type (`DECIMAL(10,2)`, `STRUCT(...)`), a sort indicator and a filter box per column; below it, while they are shown, the [statistics of the columns](#the-statistics-of-the-columns).
- **Every data column is 200 pixels wide**, in every grid: the preview, the results and the changes of a table, with and without the statistics. A text that does not fit is cut with an ellipsis; while the pointer is on it, its tooltip shows it whole (up to 1000 characters). The same holds for a long column name or type in the header. The column of the row numbers is as wide as the last number.
- A running row number, zebra stripes and the colours of the active VS Code theme (light, dark, high contrast).
- `NULL` cells show dimmed, italic `NULL`; an empty string is an empty cell. A screen reader announces a real NULL as "no value (SQL NULL)".
- Numbers are right aligned. Nested values (`STRUCT`, `LIST`, `MAP`, `ARRAY`, `UNION`) are JSON text. A cell draws at most 2000 characters. Copy and export use the full value.
- A toolbar of three icon buttons, drawn alike, each named in its tooltip and for screen readers: **Column Statistics** first (where the grid has statistics; highlighted while shown), then **Copy as Markdown** (the copy icon) and **Export as File** (an arrow out of a tray), then the status line: `1000 rows (more rows exist) · 12 ms`; with a filter `3 of 1000 rows (more rows exist) · 12 ms`. On a narrow panel the toolbar wraps between its groups, so no control runs off the edge.
- A **context menu** on the cells, VS Code's own: **Copy Cell**, **Copy Row**, **Copy All**, **Copy as Markdown**, and **Copy Column Statistics as Markdown** while the statistics are shown. A right-click first selects the cell under the mouse. A right-click on the statistics offers to copy them. Elsewhere on the page (a filter box, the header, a selected text) VS Code keeps its usual menu.
- Only the visible rows and 100 rows around them are in the page. Two spacers stand for the rest, so the scroll bar covers all rows. Sort, filter, copy and export always work on all rows.

| Action                 | How                                                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Sort                   | Click a header: ascending, descending, original order.                                                                           |
| Filter                 | Type into the box of a column. The boxes combine with AND; the table updates on a pause.                                         |
| Move the selection     | Click or right-click a cell, or arrow keys, `Home`, `End`.                                                                       |
| Copy the selected cell | `Ctrl+C`, or **Copy Cell** in the context menu. With text selected, `Ctrl+C` copies that text.                                   |
| Copy the row / all     | **Copy Row** (row of the selected cell) and **Copy All** (rows shown, with the column names) in the context menu, tab separated. |
| Copy as Markdown       | The copy icon of the toolbar, or **Copy as Markdown** in the context menu: the rows shown as a Markdown table with a header row. |
| Export                 | The export icon, **Export as File**: a pick of the formats (CSV, JSON, Markdown), then a save dialog for the rows shown.         |

**Export as File** asks the extension for the format: VS Code shows a pick of CSV, JSON and Markdown, as the Command Palette shows commands, and the page then sends the rows shown in that format (sorted and filtered), which a save dialog writes. It proposes `schema.table.csv`, `.json` or `.md` (in results mode `result-<n>`) and writes the rows that were loaded. For all rows, use **Export...** on the table or view in the explorer ([Data access](data-access.md#export)) or **Run to File...** in the SQL editor ([SQL editor](sql-editor.md#run-to-file)); both write CSV, JSON and Markdown by the same rules, and Parquet.

**How the context menu reaches the grid.** The menu is VS Code's (`webview/context` in `package.json`), so its commands (`aantje.copyCell`, `aantje.copyRow`, `aantje.copyAll`, `aantje.copyAsMarkdown`, `aantje.copyColumnStatistics`) run in the extension, which does not know the selected cell, the sort or the filters. The page names its panel in the `data-vscode-context` of its root (an id that the extension gives it with its settings), the result set on the table and the section on the cells (`preventDefaultContextMenuItems` hides the Cut, Copy and Paste of VS Code there); VS Code hands that context to the command. The extension finds the panel by the id (`GridPages` in `src/grid/grid.vscode.ts`) and asks its page to copy; the page then sends the text, as it does for `Ctrl+C`. A command of a panel that has closed meanwhile does nothing. The commands are hidden from the Command Palette.

Rules (all in `src/grid/model.ts`):

- **Sorting** is stable. Numbers compare by value; `BIGINT`, `HUGEINT` and `DECIMAL` arrive as strings and compare digit by digit, so no precision is lost. `false` sorts before `true`. Text uses a numeric, case- and accent-insensitive collation (`item 2` before `item 10`). **NULL is always last**, in both directions.
- **Filtering** matches a case-insensitive substring of the displayed text, as typed (spaces count). The filter `NULL` selects the NULL cells, `!NULL` the others. A NULL cell never matches a plain substring: `nul` finds the text `nullable`, not NULLs.
- **Copy and export** use the full value; NULL becomes an empty field. Copying a single NULL cell leaves the clipboard alone and the status line says `NULL: nothing copied`. Sort and filter apply: you copy what you see.
- **CSV** follows RFC 4180 (comma, CRLF, header row, UTF-8 without a byte order mark) and holds every value and column name as it is. With one column an empty field is written as `""`, so NULL rows do not vanish.
- **JSON** is an array of objects, one object per line, keys in the order of the columns (two columns of one name give two keys, as DuckDB writes them). BIGINT, HUGEINT and DECIMAL keep all their digits as JSON numbers; a NaN or an infinity becomes a string; nested values are nested JSON; NULL is `null`. The page writes it from the loaded rows (`toJson` in `src/grid/model.ts`).
- **Markdown** is a pipe table with a header row (`toMarkdown`, the rules in `src/export/markdown.ts`). Every value and column name is text: a backslash goes before `\`, `|`, `` ` ``, `*`, `_`, `~`, `[`, `]`, `<`, `>` and `&`, so nothing renders as Markdown or HTML and no cell ends early; a line break becomes `<br>`. NULL is an empty cell, or `NULL` with `aantje.export.markdownNull` set to `NULL`. Nested values are their JSON text. The Markdown files of Run to File and Export follow the same rules in SQL.
- **Formulas are neutralised on the clipboard only.** In text cells and column names a value starting with `=`, `+`, `@`, `-`, a tab or a carriage return gets a leading `'` in **Copy Row** and **Copy All** (which quote tabs, line breaks and quotes), whose text is pasted into spreadsheets. A text that is a plain number (`-5`) stays. Numbers, booleans and nested values are never changed. **Copy Cell** keeps the exact value, because it is meant for SQL or text, not for a spreadsheet. Files keep every value: CSV, JSON and Markdown ([Security](security.md#the-data-grid)).

## The statistics of the columns

**Column Statistics**, the first icon button in the toolbar of the data preview and of each result set of the results panel (in the orange of aantje while the statistics are shown), adds a row to the header of the grid, below the name, type and filter of each column, like the summary header of VS Code's Data Wrangler. Each column gets, top to bottom:

- a **histogram** of a number, a date, a moment or a time of day, its bars in the navy of aantje (a lighter step of it on a dark theme, the theme's chart blue in high contrast) with their bound and count as a tooltip; a column without one keeps its height empty, so that the lines of all columns line up;
- a **line per figure**, the label first and the value after it, every label in one column and every value at the same indent, the same in every column; a value that does not fit is cut, with the whole value as its tooltip:

| Kind of column                                       | Lines                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Every column                                         | **Type** (the DuckDB type), **Nulls**: the exact count and the share, such as `1 (20%)`                                               |
| Numbers                                              | **Min**, **Max**, **Avg**                                                                                                             |
| Dates, moments (`DATE`, `TIMESTAMP...`) and times    | **Min**, **Max**, **Avg**; the average of a date or a time is a moment or a time again, as DuckDB's `avg` gives it                    |
| Text and every other scalar (UUID, ENUM, BLOB, JSON) | **Distinct** (the count of distinct values), **First** and **Last** (the first and the last value in alphabetical order, as Power BI) |
| Booleans                                             | **True**, **False**: how many values are true and false                                                                               |
| Structs, maps, lists, arrays, intervals              | Type and Nulls only                                                                                                                   |

A share that rounds to 0 % or 100 % without being it reads `<0.1%` or `>99.9%`. A line whose value is NULL (the minimum of a column without values) is left out. **Copy Column Statistics as Markdown** in the context menu copies them as a Markdown table: what they cover, then a row per column and a column per line that occurs, every name and value escaped.

A slim line between the toolbar and the grid says where the statistics stand while they are shown: DuckDB computes them (with **Cancel**), they failed (with the message and **Compute again**), or, short, what the figures cover (`Computed by DuckDB over the 5,000 rows that were loaded only.`). A result that was cut has its notice in the same line, also while the statistics are hidden (`Only the first 10,000 rows were read; sorting, filtering, the copies and Export as File apply to these rows only.`); once the statistics are computed, the two are one message: over the loaded rows the statistics join the tools that apply to these rows only, over the whole result the message adds what the statistics cover. The toggle is off at first and remembered in the global state of VS Code (`aantje.grid.columnStatistics`) for the grids that open later.

**DuckDB computes everything, the page nothing**, and nothing that the header does not show. Nothing is computed while the statistics are hidden; the grid asks the extension when they are shown, or when a grid opens while they are. The queries (`src/grid/summary-queries.ts`) are one aggregate over all rows (`count(*)`, `count(*) - count(c)` for the NULLs, `min`, `max` and `avg` of a number or a time, `min` and `max` of the text of every other value, `count_if(c)` and `count_if(NOT c)` of a boolean), then one scan for the histograms (`histogram()` with `equi_width_bins` between the minimum and the maximum, about 12 bars; a time of day binned by `epoch_us`) and the distinct texts (`count(DISTINCT ...)`). DuckDB 2.0 averages dates and times itself: `avg` of a `DATE` gives a `TIMESTAMP`, of a `TIME` a `TIME`, of a `TIMESTAMP WITH TIME ZONE` one of those. A date or moment with an infinite end (`'infinity'`) has neither an average nor a histogram. The columns go by their place, so a column name never becomes SQL. A result of more than 50,000,000 rows takes its histograms from a sample (`USING SAMPLE ... PERCENT (bernoulli)`, about 5,000,000 rows), and Distinct is then DuckDB's estimate over all rows (`approx_count_distinct`, HyperLogLog), shown as `~1,234`; the counts, the NULLs, the ranges and the averages always cover all rows. The line above the grid says what the figures cover:

| Where                        | What runs                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data preview                 | The whole table or view at the snapshot that the tree shows, in the read-only engine of the preview with its checks and its notification with Cancel (`summarizeRelation` in `src/data/summary.ts`). At the newest snapshot the line names the snapshot it read.                                |
| Results, a query that reads  | The statement again, in the session of the editor (its transaction, temporary tables and settings), hidden from the results and the Query History (`QueryEditors.quiet`); its text comes from the extension's own state of the run, never from the page.                                        |
| Results, any other statement | A statement that does more than read (an `INSERT ... RETURNING`, a `CALL`), or one of a run that was cancelled, does not run again: DuckDB summarizes the loaded rows in a private in-memory DuckDB of the extension (`src/grid/summary-engine.ts`), cast back to their types where DuckDB can. |

While DuckDB computes, the line has **Cancel**; a run of the editor cancels it, and while a run is active it waits for **Compute again**. Statistics that fail say why. The session runs one statement at a time, so a second computation or Aggregate in DuckDB cancels the first.

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
- **No sorting, no filter and no statistics.** Sorting or filtering would separate the row before an update from the row after it. The rows keep the order of the changes. Use **Copy All** or **Export as File** to work on them elsewhere.
- Copy and export include `snapshot_id`, `rowid` and `change_type`, not the mark column. The status line counts the rows of the grid; the summary counts all changes of the range.
- **Data Compare** ([Data Compare](compare.md#what-data-compare-shows)) sends the same kinds with `rowMode: 'compare'` and the leading columns `#`, `difference` and `side`. The page keeps the marks, the pairs and the changed cells and words them for two tables, seen from Script as Update: `+` only in the source (the script inserts it), `−` only in the target (it deletes it), `←` and `→` the target's and the source's version of a row that differs; a changed cell has the tooltip `Differs between the target and the source`, and the mark column is titled `Difference` (`changeWording` in `src/grid/model.ts`).

## Results mode

The SQL editor ([SQL session](sql-session.md)) shows what a run returns in the same page and bundle (`dist/grid-client.js`). The page switches to this mode on the first `results-*` message. `ResultsPanels` (`src/grid/results.vscode.ts`) implements the port `ResultsView` of `src/sql/results.ts`: `begin`, `event` (every event of the run), `end`, `reveal`; `collapse` and `isCollapsed` serve Hide and Show Results.

### The panel

- One panel per editor document. The first run opens it in a group below the editor without taking the focus ([Where the results open](sql-editor.md#where-the-results-open)); later runs reuse it. `begin` does not bring a hidden panel forward, `reveal` does.
- The panel is bound to its editor ([Results bound to their editor](sql-editor.md#results-bound-to-their-editor)): it closes with the last tab of its document, follows the editor into another group and comes forward when its query becomes active while the results of another query cover it. The decisions are in `src/grid/results-binding.ts`, free of the VS Code API.
- **Hide Results** (`collapse(key, true)`) closes the panel and keeps the run; **Show Results** or the next run makes a new panel below the editor, whose page gets the whole run on `ready`.
- The title is `<editor title> · results`.
- Closing the panel by hand does not touch the session and forgets the run. Events for a closed panel are dropped; the next run opens a new one.
- Copy and export use the same `GridDeps` as the data grid; Export as File suggests `result-<n>.csv`, `.json` or `.md`.

### What the page shows

- **Tabs.** `Messages` comes first. A result set gets `Result`, and right after it the tab of its [chart](#the-chart-of-a-result), `Chart`, as `Tips (n)` follows a plan; only a run with several result sets numbers them (`Result 1`, `Chart 1`, `Result 2`, ...), and a tab that read `Result` becomes `Result 1` when the second one arrives. The row count is in the status line of the grid, not in the tab; a cut result says in the line above its grid that sort, filter, the copies and Export as File apply to the rows read (one message with the statistics, see [above](#the-statistics-of-the-columns)); a plan, a profile, the tips and a result without rows have no chart. A profile of Statistics adds its three views. Statistics and Analysis add `Tips (n)` right after the Statistics table or the plan, when there are tips. Tab names never come from the SQL text.
- **Selected tab.** `Messages` while the run goes on or has no result set, else the first result set, or its chart when the chart was the tab chosen last (between the rows and the chart of a result set; the extension keeps it for the editor). A tab the user clicked stays selected; a new run starts again.
- **A result tab** shows a full grid, with the [statistics of its columns](#the-statistics-of-the-columns); the statement is not repeated above it (the Messages tab and the editor show it), nor above any other view. Each grid is built when its tab is first selected and keeps sort and filter while the page lives; a chart is made when its tab is first shown.
- **The Messages tab** has one line per statement: a status mark (`✓` OK, `✗` error, `…` running, `–` not run), the number, the statement (80 characters), the result (`3 rows affected`, `12 rows`) and the time. A failed statement shows the whole friendly message and **Go to statement**; a script that does not parse shows the syntax error.
- **The end of the run** is shown at the bottom and in the tab bar (a live region): `Running...`, `Completed in 1.2 s` (milliseconds below a second, as in the status line of a grid and in the health report), `Cancelled after ...` or `Failed after ...`, plus `Transaction open` or `Transaction aborted: run ROLLBACK`.
- **Go to statement** posts `{ type: 'reveal', index }`. The extension answers with the position of the error, else the start and length of the statement. An index that is not a known whole number does nothing.
- **Open script** of a tip posts `{ type: 'openTipScript', set, tip }`: the result set and the tip by their place, never the script. The extension takes the script from its own state of the run and opens it in a new editor on the connection of the query; a place without a script does nothing.

### The chart of a result

Every result set with rows has a tab **Chart** right after its tab **Result** (numbered when the run has several), in the tab bar of the page (the arrow keys move between the tabs). The chart is drawn by `dist/plan-client.js` with Apache ECharts 6 through the shell's `drawChart` (`src/shell/charts.ts`), as the plans are; no other dependency.

- **Choices** above the chart: **Type**, **X** (one column, or the row number), **Y** (one or more columns with numbers, a list of check boxes), **Series** (a text, date or time column that splits the rows into series of their own colour; for a heatmap the rows), **Size** (bubbles only) and **Aggregate** (`none`, `sum`, `count`, `avg`, `min`, `max`: how the rows that share an X become one point). Controls a type does not use are disabled.
- **Types**: bar (vertical, horizontal, stacked), line, area (stacked), scatter, bubble, pie, donut, bar and line (the second Y as a line on a second axis), heatmap (X and Series as the two categories, the value of Y), histogram (of the first Y, with 1, 2 or 5 times a power of ten as the width of a bin), box plot (minimum, quartiles and maximum of Y for each X; the quartiles interpolate as DuckDB's `quantile_cont` does), and calendar heatmap (a date or timestamp X, one value per day, at most three years).
- **Defaults**, so that a chart appears without a click (`defaultChoice` in `src/grid/result-chart.ts`): X is the first date or timestamp column, else the first text column, else the row number; Y the first number that is not X; a line over time or the row number, bars over categories; without any number the chart counts the rows of each X. When X repeats, the rows are summed.
- **Exact values.** BIGINT, HUGEINT and DECIMAL arrive as text. The chart draws their numbers, and the tooltip shows the text: the value itself, or the sum, minimum or maximum computed exactly on the digits (`src/grid/chart-values.ts`). An average is a double, as DuckDB's `avg` is. Tooltips are HTML that ECharts writes; every value and name in them is escaped (`tip` of `src/shell/chart-option.ts`).
- **Zoom** on the X axis with the mouse wheel and the slider below the chart (at the right of horizontal bars); the legend toggles series.
- **Too much to read.** Above 50 slices, 1,000 categories, 24 series, 20,000 cells of a heatmap, 50,000 points, 200 boxes or three years in a calendar the chart is not drawn: the note says why and offers a better type where there is one (bars instead of a pie, a line instead of many bars, a histogram instead of many points). A choice that lacks a column it needs says which.
- **Copy as PNG** puts the picture on the clipboard from the page (`navigator.clipboard`); **Save as PNG** sends its bytes to the extension, which offers a save dialog (`result-<n>.png`). The picture has the background of the theme and twice the size on screen. A page refuses nothing but base64 for a PNG.
- **Remembered.** The page posts the choice and whether the chart was the tab chosen last (`{ type: 'chart' }`); the extension keeps it for the editor, and a new page and a new run start from it: the run opens the tab of the chart of its first result set when that was chosen last, and a column that is still there by name stays, the rest comes from the defaults (`adoptChoice`).

**Aggregate in DuckDB.** The chart draws the rows that the panel has loaded (`aantje.sql.maxRows`). When the result has more, the note says so; for a statement that only reads (judged by its tokens as for Analysis, the `readsOnly` of its start event) and a chart that combines the rows of each X, it offers **Aggregate in DuckDB**. The page posts `{ type: 'aggregate', set, choice }`; the extension takes the statement from its own state of the run, never from the page, and runs `SELECT x[, series], agg(y) ... FROM (<statement>) GROUP BY ALL ORDER BY ...` in the session of the editor (`src/grid/chart-aggregate.ts`, every name a quoted identifier, `count(*)` named `count`, a calendar per day), hidden from the results and the Query History (`QueryEditors.quiet`). At most 10,000 groups come back. The note shows Cancel while it runs; a run of the editor cancels it. The page draws the rows of DuckDB with the same choice; another choice goes back to the loaded rows.

**Colours.** The result charts draw in the colours of aantje, the scheme of the reports (`src/shell/house-colors.ts`, [The colours of aantje](branding.md#the-colours-of-aantje)): navy `#0c243f` (the duck), orange `#ff8301` (the beak) and slate `#384f70` (the slabs), then teal, gold, purple, brick, sky, green, cerulean, rose and tan, twelve series in all, each with a contrast of at least 3:1 against the background; a chart with more series starts again with navy. A dark theme takes lighter steps of navy and slate, a light theme a darker step of the orange. A theme with another background mixes each colour towards white or black until it has 3:1 (`withContrast`). A heatmap runs over five steps from a faint tint of the first colour to the first colour; the slider of the zoom is drawn in the first colour. In the high contrast themes the theme's colours win: its series, orange and red colours, with the patterns of `chartTheme`.

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

- Only the script tags with the nonce run: one on the grid page, and on the results page `plan-client.js` before it (the plans and the charts). There is no `unsafe-inline`, no `unsafe-eval`, no event handler attribute and no `style` attribute. The one exception is the height of the two spacers, which the script sets through the CSSOM; the policy only refuses style attributes in markup.
- The panel comes from `createPanel` (`src/shell/host.vscode.ts`), shared by every webview panel of aantje. The nonce is random per panel; `localResourceRoots` is the `dist` directory only; all values that go into the page are HTML-escaped.
- **The page contains no data.** Rows arrive by `postMessage`, so a table, column or cell value from the catalog can never end up in markup. The client writes everything with `textContent`, never `innerHTML`.
- There is no `img-src`, `font-src` or `connect-src`: nothing else is loaded. See [Security](security.md#the-data-grid).

## Accessibility

- The grid is a native `<table>` and not `role="grid"`: the cells are static text, and screen reader users keep their own table navigation. `aria-rowcount` and `aria-rowindex` give the position in the whole result although only some rows are in the page; while the statistics are shown, they are the second row of the header (data cells, so that they do not become the names of the columns), and the rows count them.
- One cell is the tab stop (roving `tabindex`); arrow keys move inside. When the selected cell is scrolled out of the drawn rows, the table body keeps the focus until the next arrow key. A focused cell scrolls clear of the sticky header, also of its row of statistics.
- A sorted header carries `aria-sort`. The status line and the line of the statistics are polite live regions; the status line announces filter counts and `NULL: nothing copied`. Filter boxes are labelled `Filter <column>`. The toggle of the statistics says whether it is pressed (`aria-pressed`); the copy icon is labelled `Copy as Markdown`; a histogram is an image named by its bars.
- `Ctrl+C` leaves the browser alone while text is selected.

## Build and packaging

`esbuild.mjs` bundles `src/grid/client.ts` to `dist/grid-client.js` (browser, `iife`, `es2022`, minified in production, no source map; about 50 kB). It contains only code of this repository. Without it the panel stays empty.

## Limits

- At most 1000 rows (`PREVIEW_LIMIT`). Sort and filter work on the loaded rows: sorting a truncated result does not show the smallest or largest rows of the table. The status line says when more rows exist.
- Every drawn row has all its columns, so hundreds of columns still draw slowly. Filtering compares the full text of every cell on each change; megabytes per cell make it noticeably slow.
- Rows are assumed to have the height measured at first; a taller value (an emoji from a fallback font) shifts the rows below by those pixels.
- A data column is 200 pixels wide whatever it holds: a short number leaves space, a long text is cut (its tooltip shows up to 1000 characters). The width cannot be changed.
- Find in page and mouse selection reach only drawn rows; Copy All and Export as File take all rows.
- Chromium lays out elements up to about 33 million pixels. That is about 1.5 million rows at 22 px, more than `aantje.sql.maxRows` allows (1,000,000); with a much larger font the last rows of such a result cannot be scrolled to.
- Nested values are text; they cannot be expanded or filtered by field.
- Some Excel versions open a UTF-8 file without byte order mark with the wrong code page; import it as UTF-8.
- **Copy Cell** is exact, and so is every CSV file, so pasting the cell or opening the file in a spreadsheet can run a formula. [Security](security.md#the-data-grid) explains the risk.
- Panels are not restored after a restart of VS Code, and a hidden tab loses scroll position and selected cell.
- A change grid cannot be sorted or filtered and holds at most 1000 rows (999 when the cut would separate an update from its first row).
- Results mode keeps only the last run of an editor, only while the extension runs. Sort and filter see only the rows read (10,000 per result by default, 2,000,000 cells in total). The chosen tab is forgotten when the page reloads.
