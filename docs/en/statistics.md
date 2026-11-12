# Statistics report

**Statistics** (`aantje.showStatistics`) opens a report for one table: how many files and bytes it has, how large the files are, how its columns are filled, how evenly its partitions are filled and how it grew. Everything comes from the DuckLake catalog (`ducklake_*` tables) with the same read-only drivers as the explorer. It needs no DuckDB engine, no view confirmation and no access to the data files. Charts are drawn by [Apache ECharts](https://echarts.apache.org/) (Canvas renderer).

## Opening the report

- **Where.** The **Reports** submenu of a table (see [Reports](reports.md)), the context menu of its **Statistics** leaf (a click on the leaf opens it too) and a graph button on that leaf. Views, columns and other folders do not offer it, and the command is hidden from the Command Palette. The leaf has its own context value, `folder.statistics`, has no children and shows no numbers.
- **Which snapshot.** The one the tree shows. The tab title names it: `Statistics of shop.events @56 · Lake`.
- **One panel per connection, table and snapshot.** The command again reveals the panel with fresh data; another snapshot opens its own panel. The key is `statisticsKey` in `src/stats/target.ts`, so a renamed table keeps its panel.
- **Progress with Cancel.** `Reading the statistics of shop.events...` with a Cancel button. Cancelling aborts the queries the engine can stop (PostgreSQL, DuckDB) and ends with `The query was cancelled.`; no panel opens. A running SQLite statement cannot be stopped, but the next one is not started.
- **Closed connection.** `The connection is closed. Connect again to show the statistics.`
- **Open as Markdown.** Opens an untitled document with the six figures, file size ranges, columns, partitions and growth, one section per tab (`statisticsMarkdown` in `src/stats/markdown.ts`). Catalog names and values are code. The growth table lists the 100 newest snapshots and counts the rest (`… n more omitted (limit: 100).`). There is no filter and no Refresh, because the statistics of a snapshot do not change.

## What it shows

| Tab              | Content                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**     | Six figures (files, size, rows, delete files, average file size, small files) and a histogram of file sizes.                      |
| **Columns**      | Every column, nested ones included: path, type, nullable, a bar for the share of NULLs, minimum and maximum.                      |
| **Partitioning** | The current partitioning (keys and transforms), a bar per partition and how evenly they are filled; a message when unpartitioned. |
| **Growth**       | Size and file count after each snapshot that added or removed files, as two step lines; a compaction is marked with a diamond.    |

A table without data files (new, or all rows inline) shows messages, never an empty chart. The tabs follow the WAI-ARIA tab pattern (arrow keys move between tabs), and every chart is an `img` with an `aria-label`.

## Definitions

All figures are as of the shown snapshot. `TableStatistics` (`src/catalog/model.ts`) is the data type; `reader.tableStatistics(tableId, snapshot, signal?)` computes it.

| Figure                | Definition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Files**             | Data files visible at the snapshot (`begin_snapshot <= s < end_snapshot`); the same number as the tree.                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Size**              | Data plus delete files, in binary units (1 KB = 1024 B).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Rows**              | `record_count` of the data files minus `delete_count` of their delete files. Inlined rows are not included. A `~` marks an approximation: a visible file holds more than the snapshot (its `partial_max` is later), as after a compaction.                                                                                                                                                                                                                                                                           |
| **Delete files**      | Delete files visible at the snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Average file size** | Data bytes divided by data files; `–` without files. The card names the largest file.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Small files**       | The share of data files below 16 MiB (`SMALL_FILE_BYTES`, absolute, so a table of tiny files is found too). The card turns orange with a warning sign at 5 or more files with at least half small (`SMALL_FILES` in `src/catalog/thresholds.ts`, shared with the [Storage report](storage-report.md) and the health check).                                                                                                                                                                                          |
| **Size histogram**    | Eight bins that are halves of the largest file: bin 7 holds files of at least half the largest, bin 6 a quarter up to a half, down to bin 0 below 1/128. Integer comparisons only, so all three engines agree. Empty bins are shown.                                                                                                                                                                                                                                                                                 |
| **Null share**        | `sum(null_count) / (sum(null_count) + sum(value_count))` over the visible data files (`ducklake_file_column_stats`). Rows removed by delete files still count; files written before a column was added are not counted. `–` when there are no statistics (struct, list and map parents; `INTERVAL` columns) and for a field below a nullable column or below a list or map, because DuckLake counts a missing parent as NULL for its fields. The bar is blue, orange from 50 % with `(high)`, red with `(all NULL)`. |
| **Minimum, maximum**  | The range according to the statistics; deleting rows does not narrow it. At the latest snapshot it is `ducklake_table_column_stats`. At an older snapshot DuckLake keeps no history, so the ranges of the visible files are combined, compared by type order (below). `–` when there is none. Empty text shows as `"`, a boolean as `true` or `false`.                                                                                                                                                               |
| **Partitions**        | Visible data files written under the partitioning in force, grouped by partition values (`ducklake_file_partition_value`; a transform such as `month` stores the number). Per partition: files, bytes (data and delete) and rows. Files of an earlier partitioning, or none, are counted apart (`earlierFiles`).                                                                                                                                                                                                     |
| **Evenness**          | Of the bytes per partition: the coefficient of variation and the Gini coefficient (`2 * sum(rank * size) / (n * total) - (n + 1) / n`, sizes ascending). Both are 0 for equal sizes; Gini approaches 1 when one partition holds everything. The sentence under the chart turns orange (`uneven`) from a Gini of 0.5. Needs two partitions.                                                                                                                                                                           |
| **Growth**            | For every snapshot up to the shown one that added or removed data or delete files: the data file count and bytes after it, cumulated in snapshot id order. The time is the snapshot's; an expired snapshot has none (`time unknown`). A `merge_adjacent` snapshot for the table is a compaction.                                                                                                                                                                                                                     |

**Orange and red mean a warning, and never alone.** Ordinary series use blue, green, purple and yellow; orange marks a value above a threshold and red an extreme. The page says the same in words (warning sign, `(high)`, `(all NULL)`, `uneven`), because some high-contrast themes make the warning colour nearly the ordinary one.

### The order of the types

Minimum and maximum of the files are text, compared by the column type (`comparatorOf` in `src/catalog/statistics.ts`):

| Type                                                                | Order                                                    |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `int8` ... `int128`, `uint8` ... `uint128`                          | As numbers (`BigInt`, no lost digits).                   |
| `float32`, `float64`                                                | As numbers; `inf` and `-inf` understood, `nan` left out. |
| `decimal(p,s)`                                                      | By value with aligned scales.                            |
| `date`, `time`, `timestamp`, `timestamp_s/ms/ns`, `uuid`, `boolean` | As text (fixed width).                                   |
| `timestamptz`                                                       | As instants (to the millisecond; the text breaks a tie). |
| `varchar`, `json`                                                   | By UTF-8 bytes, as DuckDB orders text.                   |
| everything else (`blob`, `interval`, nested types)                  | No order: no range is shown rather than a wrong one.     |

A value that cannot be read as its type is skipped and does not fail the table.

## Limits

- **Many files.** At an older snapshot the ranges are folded from at most 50 000 statistics rows (`RANGE_ROW_LIMIT`); beyond that the page says `The table has very many files: minimum and maximum cover only some of them.` The null share is a SQL `SUM` and has no cap.
- **Partitions.** The chart names the 50 largest partitions and sums the rest as `other (n)`. At most 10 000 partitions are read; beyond that evenness covers only the largest ones. A partitioning reads at most 32 keys; the page says how many were left out.
- **Growth.** At most 500 points; a longer history is merged into runs, each point being the state after the run's last snapshot. A compaction removes the files it replaces from the catalog, so the history before it shows the files as they are still in the catalog, not as they were. After `expire_snapshots` a point's time is missing.
- **Inlined rows** are in no file and no statistics; a table with only inlined rows shows `0` files and `0` rows.
- **Ranges** of an older snapshot are wider than the truth when a file's range was not exact (`min_is_exact`).
- **Specification 1.0** works: the queries use no column that 1.1 added. A catalog lacking a statistics table shows columns without null share and range, and no partitions, instead of failing.

## The colours follow the VS Code theme

ECharts draws on a canvas and needs colours as text, so the page reads the theme for every drawing (pure code in `src/shell/palette.ts`, shared by all report pages):

- `modeOf` reads the body class (`vscode-dark`, `vscode-light`, `vscode-high-contrast`, `vscode-high-contrast-light`).
- `readPalette` reads `--vscode-editor-background`, `--vscode-charts-*` (foreground, lines, blue, green, purple, yellow, orange, red) and the font.
- **Contrast fallback.** A colour that is missing, unreadable, or below WCAG 4.5:1 (text) or 3:1 (marks, lines) against the background is replaced by the same role in the fallback palette of the mode (`FALLBACK`, the defaults of the four built-in themes). A custom theme without chart colours still gets a readable report.
- `chartTheme` builds the ECharts theme. High contrast gets solid grid lines, outlines, thicker lines, bordered tooltips and patterns (`aria.decal`), so colour is never the only difference.
- **Theme change.** A `MutationObserver` watches the body class, `data-vscode-theme-id` and the root `style`. The page rereads the palette, disposes the charts and draws new ones; the open tab and data stay.

## How it is built

| File                                                 | Job                                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/catalog/statistics.ts`                          | Pure reader helpers: evenness, histogram bins, growth cumulating and merging, type order, the caps.                                                    |
| `src/stats/model.ts`                                 | `StatisticsData` and the page's texts and figures. Pure.                                                                                               |
| `src/stats/chart-options.ts`                         | ECharts options of the three charts, with tooltips as HTML without `style` attributes. Pure.                                                           |
| `src/shell/palette.ts`                               | `modeOf`, `readPalette`, `chartTheme`. Pure.                                                                                                           |
| `src/shell/charts.ts`                                | The only module that imports ECharts (core, the chart and component types in use, Canvas renderer). `drawChart` returns `resize`, `update`, `dispose`. |
| `src/stats/page.ts`, `render.ts`                     | The browser side: tab state, charts, DOM builders of the tabs.                                                                                         |
| `src/stats/kind.ts`, `protocol.ts`, `style.ts`       | The `ReportKind`, the message guard `isStatisticsMessage`, the stylesheet.                                                                             |
| `src/stats/markdown.ts`, `target.ts`                 | `statisticsMarkdown`; which node is a target, the panel key and title.                                                                                 |
| `src/stats/commands.vscode.ts`                       | `registerStatisticsCommand`: the command with progress and Cancel.                                                                                     |
| `src/shell/panels.ts`, `host.vscode.ts`, `client.ts` | `ReportPanels` (one panel per key, the `ready` handshake) and the browser entry of all reports, see [Reports](reports.md).                             |

`esbuild.mjs` builds `dist/report-client.js` as a browser bundle (about 650 kB minified, 220 kB gzipped; ECharts core alone is 490 kB). Only the chart types and components in use are registered. The bundle also serves the [Snapshot report](snapshot-report.md). `scripts/notices.mjs` reads its source map, so `THIRD-PARTY-NOTICES.md` carries the licences of ECharts and zrender.

## Security

The page uses the grid's policy ([Data grid](grid.md#the-page-the-policy-and-why-there-is-no-inline-data)): `default-src 'none'`, nonce for style and script, no `unsafe-inline` or `unsafe-eval`; the webview reads only `dist`. Data arrives by `postMessage` after `ready`, not in the markup.

- **ECharts under this policy.** A style set through the DOM is allowed; a `style` attribute parsed from markup is not. ECharts' default HTML tooltip contains `style="..."`, which the policy blocks, so every tooltip has a `formatter` returning HTML without `style` attributes, and a test checks this.
- **Catalog text** (column names, partition values, minimum and maximum) goes in with `textContent`. Tooltips are HTML, so their text goes through `escapeHtml` (`src/html-escape.ts`).
- **Messages.** The extension passes on only what `isShellRequest` accepts (`ready`, or `markdown` without a view); the page uses data only when `isStatisticsMessage` accepts it.
- **No data leaves.** The page makes no request, and the extension reads only catalog tables, read-only.
