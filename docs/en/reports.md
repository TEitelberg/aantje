# Reports

The reports of aantje are webview panels with one look and one way to work: a header with title, summary, **Refresh** and **Open as Markdown**, key figures, filters, charts or lists, and actions. They share one report shell, so a new report is a few small files and not a new panel from scratch. This page covers the Reports submenu, **Open as Markdown**, the Properties report, the shell and how to add a report.

| Report                                    | Where                                                                        | Command                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| [Snapshot report](snapshot-report.md)     | Reports submenu of an open connection                                        | `aantje.showSnapshotReport`                     |
| [Properties](#the-properties-report)      | Reports submenu of an open connection                                        | `aantje.showProperties`                         |
| [Storage report](storage-report.md)       | Reports submenu of an open connection and of a schema                        | `aantje.showStorage`                            |
| [Statistics report](statistics.md)        | Reports submenu of a table                                                   | `aantje.showStatistics`                         |
| [Schema History](schema-history.md)       | Reports submenu of a table                                                   | `aantje.showSchemaHistory`                      |
| [Activity report](activity-report.md)     | Reports submenu of an open connection and of a schema                        | `aantje.showActivity`                           |
| [Health check](health-check.md#the-panel) | Reports submenu of an open connection, a schema and a table                  | `aantje.checkHealth`, `aantje.checkTableHealth` |
| [Dependencies](dependencies.md)           | Reports submenu of an open connection, a schema, a table, a view and a macro | `aantje.showDependencies`                       |
| [Maintenance Advisor](advisor.md)         | Reports submenu of an open connection and of a schema                        | `aantje.showAdvisor`                            |
| [Growth report](growth-report.md)         | Reports submenu of an open connection, a schema and a table                  | `aantje.showGrowth`                             |

## The Reports submenu

The context menu of an open connection, a schema, a table, a view and a macro has a submenu **Reports** (`aantje.reports`, group `3_reports`). Its entries are declared in `package.json` under `menus["aantje.reports"]`; adding a report is one more object there:

```json
{
  "command": "aantje.showStorage",
  "when": "viewItem =~ /^connection\\.connected(\\.azure)?$/",
  "group": "1_lake@3"
}
```

The groups `1_lake` (a lake, `connection.connected`, or `connection.connected.azure` for an Azure DuckLake), `1_schema`, `2_table`, `3_view` and `4_macro` keep the levels apart. The commands need a node, so each is hidden from the Command Palette. The Statistics leaf of a table keeps its own inline button, because that opens the report for that table.

## Reports for one schema

The Reports submenu of a schema node offers the reports whose data is per table, limited to the tables of that schema. A report of a schema has the scope `{ kind: 'schema', id, name }` (`ReportScope` in `src/shell/scope.ts`) in its data, one panel per connection and schema, the schema in the panel title (`Storage · Lake · schema shop`) and in the title of the Markdown document (`# Storage of Lake · schema shop`). What belongs to the whole lake stays the lake's, is labelled `(lake-wide)` where it appears in a schema report and is described in a note.

| Report                                                                                                           | On a schema node | What it shows for the schema                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Maintenance Advisor](advisor.md#advice-for-one-schema)                                                          | yes              | Merge, rewrite and flush candidates of its tables. Snapshots, expiry, cleanup, orphans and the policy are lake-wide and labelled.                                                                                |
| [Health check](health-check.md#scope-of-a-schema)                                                                | yes              | Findings about its tables and its directory in the store. Snapshots, cleanup and connection findings are lake-wide and labelled.                                                                                 |
| [Storage report](storage-report.md#for-one-schema)                                                               | yes              | Its tables, their files, size and small files, the file and row totals and the growth of its files. The data path, the encryption and the files scheduled for deletion are lake-wide and labelled.               |
| [Growth report](growth-report.md#for-one-schema)                                                                 | yes              | The snapshots that changed the schema, its tables and what they did to their rows, bytes and files.                                                                                                              |
| [Activity report](activity-report.md#for-one-schema)                                                             | yes              | The snapshots that changed the schema, with only their changes to it.                                                                                                                                            |
| [Dependencies](dependencies.md#for-one-schema)                                                                   | yes              | Its views, macros and tables that use or are used by another object, and the objects of other schemas next to them.                                                                                              |
| [Statistics report](statistics.md)                                                                               | no               | It is the report of one table (columns, partitions, file sizes); a schema has no such figures. The Storage report of the schema lists the tables with their files, size and rows, and each opens its statistics. |
| [Snapshot report](snapshot-report.md), [Schema History](schema-history.md), [Properties](#the-properties-report) | no               | Snapshots, the history of one table and the options of the catalog belong to the whole lake; they are not offered on a schema node.                                                                              |

## Open as Markdown

Every report has **Open as Markdown** in its header. It opens an untitled Markdown document with the content of the report, with the filters that are set, to copy into a ticket, keep or compare.

The page does not send the document. It posts `{ type: 'markdown' }`, with a `view` when the report has filters. The extension checks the view with the guard of the report, fits it to the data it holds and builds the text itself. A request with an undeclared field, a view of the wrong shape or a `markdown` text is ignored.

Each report has a pure `toMarkdown(data, view)` in a module without `vscode`: `src/<report>/markdown.ts` (`statisticsMarkdown`, `snapshotReportMarkdown`, `schemaHistoryMarkdown`, `activityMarkdown`, `storageMarkdown`, `healthMarkdown`, `dependenciesMarkdown`, `advisorMarkdown`, `growthMarkdown`) and `propertiesMarkdown` in `src/properties.ts`. Rules:

- A title, a summary, then tables and details. The filters are named as text.
- Everything from the catalog (names, authors, messages, the filter text) goes through `code()` in `src/markdown.ts`: a code span on one line with pipes escaped, so nothing renders and no table cell breaks. The connection name in the title goes through `markdownText`.
- A long table is cut with `… n more omitted (limit: m).` (`capRows`). The limits are constants in each `markdown.ts`.

## The Properties report

**Properties** (`aantje.showProperties`) opens one panel per connection (`Properties · Lake`), built in `src/properties-report/`.

- **Key figures:** the DuckLake version, who created the catalog, whether it is encrypted, the number of snapshots, the time of the first and of the latest one. `not set` and `none` stand for a missing value.
- **Metadata:** every row of `ducklake_metadata` (key, value, scope: `global` or `table 10`) behind a filter box that matches key, value or scope, ignoring case. The page shows the first 500 entries (`500 of 620 entries are shown`); the filter reaches the others. The filter text survives a hidden panel.
- **Actions.** The data carries a list `actions` (today `['showStorage']`); the page shows a button for each, and the extension runs an action only if its own list offers it. **Show Storage Report** opens the [Storage report](storage-report.md) of the connection.
- A closed connection gets `Connect to a catalog first to show its properties.` and no panel.

## The shell

```text
src/shell/
  panels.ts          ReportPanels, ReportKind, PanelPort          (host side, pure)
  protocol.ts        ShellRequest, isShellRequest, actionGuard    (what a page may send)
  host.vscode.ts     createPanel, reportPanels, openReport, openMarkdown, profileOf
  report-port.ts, report-port.vscode.ts, table-actions.vscode.ts   (what actions do in VS Code)
  client.ts          the one page script: picks the page by the first message
  kinds.ts, page.ts  the list of page kinds, PageContext, Page, StateStore
  blocks.ts          the page building blocks
  palette.ts, theme.ts, charts.ts, chart-option.ts, dom.ts, style.ts, model.ts, numbers.ts
```

### Host side

`ReportPanels<Data, Action, View>` keeps one panel per key (connection, kind of report and what it is about). Showing a key again updates the title, reveals the panel and sends the new data; a panel the user closed is forgotten. A page may send at most `MAX_REQUESTS_PER_WINDOW` (10) requests per second that are not `ready`; the rest are dropped, so a flooding page cannot start a read or open an editor per message.

- **Handshake.** Nothing is sent before the page says `ready`. A page that VS Code rebuilds after the panel was hidden says `ready` again and gets the data again; it keeps its own choices with `getState` and `setState`.
- **Security.** `createPanel` (`host.vscode.ts`) is the one place where aantje creates a webview panel (the grid and the SQL results use it too): `localResourceRoots` is `dist` only, the page has a nonce CSP (`default-src 'none'`, one script, one style element) and no data in the markup.
- **Requests.** `isShellRequest` accepts `ready`, `refresh` and `markdown` with nothing else; the guard of the kind accepts its actions. Anything else is ignored.
- **Progress.** `withCancel(title, read, outer?)` (`src/progress.vscode.ts`) shows a notification with Cancel and passes an `AbortSignal` to the read.
- **Reads.** `panels.read(key, run)` resolves to `undefined` when a newer read of the key started (the newer result wins) or the user closed the panel meanwhile; both abort the older read.
- **Changes while the page is open.** `update(key, data, message)` replaces the data without sending it and posts `message` instead, for a page that applies changes (the Health check applies the events of a run). `onClose(key)` tells the report that the user closed the panel.
- **Out of date.** When the explorer refreshes a connection, which the SQL editor does after a statement that may change the lake (see [SQL editor](sql-editor.md)), `openReport` marks the open panels of that connection with `panels.markStale(key)` (through `markStaleOnRefresh`; a statistics panel shows one snapshot, which does not change, and is not marked). The page then shows a note above the report (`The lake changed after this report was read ...`) until new data arrives with Refresh. The numbers are not read again by themselves: a report such as the Advisor runs dry runs and reads a lot, and a read would also pull the panel to the front. The Health check panel is not marked, because it shows the result of a run the user started. A Refresh of the explorer by hand marks the panels as well, whether or not the lake changed.
- **Removed connections.** A refresh or action of a panel whose connection was removed says `The connection of this … was removed. Close the report.` (`profileOf`).

A report kind is a plain object:

```ts
interface ReportKind<Data, Action, View> {
  viewType: string; // 'aantje.properties'
  css: string; // SHELL_CSS plus the rules of the report
  message: (data: Data) => unknown; // { type: 'properties', data }
  isAction?: (value: unknown) => value is Action; // none: the page sends no action
  isView?: (value: unknown) => value is View; // none: Open as Markdown takes no view
  toMarkdown: (data: Data, view: View | undefined) => string;
}
```

`actionGuard(fields)` builds `isAction` from a table of action ids and the fields each carries. The page names an action and numbers, never a command id and never free text; the report checks the numbers against the data it sent.

### Page side

`dist/report-client.js` is one script for all reports (ECharts is bundled once). `src/shell/client.ts` waits for the first message and builds the page of the kind whose guard accepts it. A message with a known type that fails its guard shows `This page cannot read the data it was sent. Open it again; if that does not help, update aantje.`

A page is `createXPage(context: PageContext): Page<Data>` with `show(data)`, `redraw()` (theme change) and `resize()`. The building blocks in `src/shell/blocks.ts`: `pageHeader`, `cardGrid` (key figures with a severity), `tabBar` (WAI-ARIA tabs), `toolbar` and `searchBox`, `kindCheckbox` and `rangeField`, `dataTable` and `tableRow`, `findingCard`, `keyList`, `actionButton`, `note`, `empty` and `truncation`.

The theme is shared: `readTheme()` reads the VS Code chart colours, checks their contrast against the background and falls back to a palette of the mode; `chartTheme` adds patterns in the high contrast themes. Text formats (`formatBytes`, `count`, `plural`, `formatUtc`) are in `src/shell/model.ts`.

### Layout

Every page of aantje (reports, data grid, SQL results) shares one layout, defined in `src/shell/style.ts` (`LAYOUT_CSS`):

| Token                   | Value       | Used for                                     |
| ----------------------- | ----------- | -------------------------------------------- |
| `--aantje-gutter`       | `20px`      | Distance of everything to the view's edges   |
| `--aantje-section-gap`  | `16px`      | Distance between sections, headings, cards   |
| `--aantje-card-padding` | `10px 12px` | The inside of cards and boxes                |
| `--aantje-control-gap`  | `8px`       | Distance between controls, notes, list lines |

The page script creates the container `.app` with `createApp()` and gives it to the page as `context.app`; everything a page shows is a child of it. Rules for a report author:

- No `margin` or `padding` on `body`, `html`, `.app`, `main`, `header` or `.tabs`, and no horizontal margin on a block in the container. Space comes from the tokens, not from numbers.
- A row of cards is followed by one section gap (the gap belongs to `.cards` in `SHELL_CSS`), so a report adds no margin below its cards and builds no row of cards by hand.
- A heading carries its own section gap above it. Only the first heading of `main` has none. A wrapper with padding, border, `flex`, `grid`, `float`, `overflow` or positioning at the top would keep the margin inside, so a section that starts with a heading does not get such a style.
- A table goes through `dataTable` (or `scrollable(table)`): a box with `overflow-x: auto`, so a wide table scrolls inside the gutter. A chart is `width: 100%` and draws again on `resize`.
- A box with a border keeps it in the high contrast themes (`--vscode-contrastBorder`).

## Adding a report

1. **Model** (pure): the data the extension sends, the figures and texts.
2. **Protocol** (pure): the guard for the message to the page, the actions with `actionGuard`, the guard for the view of Open as Markdown.
3. **`toMarkdown`** (pure): use `code`, `markdownTable`, `reportTitle` and `capRows` from `src/markdown.ts`.
4. **Kind** (`kind.ts`, pure): the `ReportKind` object.
5. **Page** (`page.ts`, browser): `createXPage` and `export const xPage: PageKind<Data>`, built from the blocks; add it to `pageKinds` in `src/shell/kinds.ts`.
6. **Command** (`commands.vscode.ts`): a report read per connection calls `openReport(env, spec)` from `host.vscode.ts` (read with progress and Cancel, `panels.show`, Refresh, check of every action against the data; the spec holds key, read, title, `planAction`, `perform`; a read may answer `null` with an `absent` text when its subject does not exist at the snapshot, and `refreshParams` changes the parameters of a Refresh). All reports but the Health check and Statistics use it. A report of another shape uses `reportPanels(env, kind, { onAction, onRefresh })` and `panels.read`.
7. **Menu:** the command and one entry in `menus["aantje.reports"]`, hidden from the Command Palette.
8. **Tests and docs:** model, protocol, `toMarkdown`, the page with `test/support/page-harness.ts`, an integration suite; a page in `docs/en` and the module map in `architecture.md`.

## Testing

Unit tests cover the layout rules (`shell-layout.test.ts`), the request guards as tables (`shell-protocol.test.ts`), the panel lifecycle with a stand-in webview (`shell-panels.test.ts`, `open-report.test.ts`), the page blocks against a DOM stand-in, the theme and chart options, the Properties report, and the Markdown documents against the history fixture. The pages draw with ECharts on a canvas, which the unit tests replace; `test/integration/report-shell.test.ts` runs the Reports submenu, the Properties panel (CSP, nonce per panel, hide and show) and Open as Markdown in a real VS Code, and the end-to-end suite checks the pages and the layout in a browser.
