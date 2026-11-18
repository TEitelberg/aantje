# Details

**Show Details** (`aantje.showDetails`) lists the tables, views and macros of a schema, or of every schema of a lake, in one sortable list with their key figures, as **Object Explorer Details** does in SSMS. You find the largest, the most fragmented or the stalest tables without opening each one. The report reads the catalog only, through the explorer's reader, as the [Statistics](statistics.md) and [Storage](storage-report.md) reports do; no data file is opened. It is built on the report shell ([Reports](reports.md)) in `src/details/`.

## Opening it

- **Show Details** in the context menu of an open connection (all schemas), a schema and its folder **Tables** (that schema).
- One panel per connection and scope (`Details · Lake`, `Details: shop · Lake` for a schema); the heading is `Details` or `Details: shop`, the report name as the menus write it and the object after a colon. The report reads at the snapshot that the tree shows; **Refresh** reads again at the snapshot the tree shows then. A refresh of the explorer marks an open panel as out of date.

## The list

The tab **Tables and Views** has one row per table and view, the tab **Macros** one per macro.

| Column       | What it shows                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schema, Name | As in the tree. A click on the name selects the row.                                                                                                                     |
| Kind         | `table` or `view`; on the tab Macros `scalar macro` or `table macro`.                                                                                                    |
| Comment      | The comment at the snapshot, on one line.                                                                                                                                |
| Rows         | The rows of the data files without the deleted ones, as the tree and the Statistics report count them; `~` when approximate. Inlined rows are counted apart.             |
| Size         | Data files plus delete files.                                                                                                                                            |
| Data files   | The data files visible at the snapshot.                                                                                                                                  |
| Small files  | Data files below 16 MiB, as the Statistics and Storage reports count them.                                                                                               |
| Delete files | The delete files visible at the snapshot, as the Storage report counts them.                                                                                             |
| Inlined rows | Rows that DuckLake keeps in the catalog (`ducklake_inlined_data_*`), counted at the newest snapshot only; `–` while the tree shows an older one.                         |
| Partitioning | The keys in force at the snapshot, such as `kind, month(ts)`.                                                                                                            |
| Sort order   | The sort expressions in force at the snapshot, such as `sensor ASC`.                                                                                                     |
| Last change  | The newest snapshot up to the shown one that changed the object, with its time. Maintenance of its files (compaction, merge, rewrite, flush) does not count as a change. |
| Created      | The snapshot that created the object; a rename keeps it.                                                                                                                 |
| Depends on   | The objects that it uses (a view reads a table or view, a view or macro calls a macro), from the [Dependencies](dependencies.md) report.                                 |
| Used by      | The objects that use it.                                                                                                                                                 |

On the tab Macros the columns are schema, name, kind, the parameters of the first overload (`+2` for two more overloads), last change, created, depends on and used by. A figure that a kind has not (the rows of a view) is `–`.

- **Sort** by a click on any column heading; a second click turns the order round. A number sorts the largest first. A row without a value sorts last either way; ties go by schema and name.
- **Filter** keeps the rows whose `schema.name` holds the text, ignoring case.
- **Columns** chooses the columns of the tab Tables and Views. Schema, name, kind, rows, size, data files, small files, delete files, inlined rows and last change are shown at first.
- The page lists 200 rows; the filter reaches the others. The report holds at most 1000 tables and views; a note says how many more the scope has.
- The page keeps the tab, filter, order, columns and selected row while VS Code takes a hidden panel down and with a Refresh.

## Actions

A selected row offers what the menu of its node in the tree offers: **Show in Tree**, **Select Top 1000 Rows** (tables and views), **Statistics** and **Schema History** (tables), **Dependencies**, and the scripts **Merge Adjacent Files**, **Rewrite Data Files** and **Flush Inlined Data** (tables), which open in a SQL document and run nothing ([Maintenance scripts](maintenance.md)). The actions that need the node of the object find it in the tree at the snapshot the tree shows; when the tree does not show it (another snapshot, or a [filter](tree.md#filter)), a message says so.

**Copy** in the header puts the list as it is shown (the tab, the filter, the order and the columns) on the clipboard, tab separated with a heading row, for a spreadsheet; a text that a spreadsheet would read as a formula starts with `'`. **Open as Markdown** writes the same list, at most 500 rows, with the notes. The page sends a view of its choices, which the extension checks field by field (`isDetailsView`) before it builds either text from the data it holds; an action names a row by its kind and id only, and the extension checks that the row was sent and that its kind has the action.

## Where the figures come from

`readDetails` (`src/details/read.ts`) reads in parallel:

- `schemas`, `tables` per schema (four at a time), `views` and `macros` of the scope: names, comments, rows, files and size as the tree reads them.
- `smallFiles(snapshot)` and `deleteFiles(snapshot, scope)`: small and delete files per table, the figures of the Statistics and Storage reports.
- `maintenanceFacts(scope)` for the inlined rows, as the health check and the advisor read them, only while the tree shows the newest snapshot.
- `snapshotActivity(500, { to: snapshot })`: the newest 500 snapshots up to the shown one with their resolved changes, as the Activity report reads them. Last change and created come from them; when there are older snapshots, an object that none of them changed shows `before @<oldest read>` and a note says so.
- The dependency graph of the Dependencies report at the snapshot (`readGraph`, shared and cached), which parses the SQL of the views and macros and runs nothing. When it cannot be read, the two columns are `–` and a note says so.
- Then `partitioning` and `sortOrder` of each table listed, eight at a time.

A Cancel or a closed panel stops the read between the steps.

## Limits

- Inlined rows are counted at the newest state only, at most for 1000 inlined tables; with more, or when a count fails, a note says that some are missing.
- Last change and created reach back 500 snapshots; an expired snapshot is not known.
- 1000 tables and views per report, 200 rows on the page, 500 in the document.
