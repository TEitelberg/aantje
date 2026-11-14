# Tree

The explorer tree (view `aantje.catalogs`) shows the catalogs of your connections. This page covers its structure, node kinds, connection lifecycle, snapshot selection, refresh and tooltips.

## Code

| File                          | Job                                                                         |
| ----------------------------- | --------------------------------------------------------------------------- |
| `src/tree/model.ts`           | `CatalogTree`: lazy levels, connection states, the snapshot per connection. |
| `src/tree/levels.ts`          | `readBelow`: the levels below a connection, read from its catalog.          |
| `src/tree/nodes.ts`           | Node factories: ids, labels, icons, context values.                         |
| `src/tree/refs.ts`            | `TreeNode`, `NodeRef`, `FolderRef`, `ChangedTable`, `ConnectionState`.      |
| `src/tree/format.ts`          | Descriptions and Markdown tooltips.                                         |
| `src/tree/provider.vscode.ts` | `CatalogTreeProvider`: maps nodes to VS Code tree items. Decides nothing.   |

`CatalogTree` knows nothing about VS Code. It gets the profiles and a function that opens a catalog (`CatalogTreeDeps`) and hands out plain `TreeNode` objects. Everything users rely on (lazy connect, snapshots, refresh, errors) is decided there, so the unit tests run it against the real reader and a real SQLite fixture. The Markdown and panels of the connection reports come from the report folders, not from the tree.

## Structure

The fixture catalog at its latest snapshot. The description after a label is the kind of the connection, the type of a column or the time of a snapshot. No folder, schema or table shows a count:

```text
Fixture lake                       sqlite · DuckLake 1.1 · @13
  main
    Tables
      plain
        Statistics
        History
        Columns
          x                        int64
    Views
      No views.
    Macros
      No macros.
  sales
    Tables
      orders
        Statistics
        History
        Columns
          id                       int32 NOT NULL
          customer                 struct
            name                   varchar
            tags                   list
              element              varchar
          attrs                    map
            key                    varchar
            value                  int32
    Views
      big_orders
        Columns
  Snapshots
    @13                            2026-10-29 21:22:48 UTC
      main.plain                   Altered table
  Query History
    No queries yet.
```

- One connection node per profile, in profile order.
- A connection lists the schemas of the shown snapshot (`main` included, sorted by name), then the folders **Snapshots** and **Query History**. Storage is a report, not a node ([Storage report](storage-report.md)).
- A schema always lists **Tables**, **Views** and **Macros**, also when empty (with a hint such as `No tables.`). **Script as CREATE** on **Macros** writes a template for the first macro ([DDL generation](ddl.md#scripts-for-macros)).
- Names are sorted case-insensitively with numbers by value (`table2` before `table10`), with a fixed English locale, whatever the machine.
- A table has the leaves **Statistics** and **History** and the folders **Columns**, **Partitioning**, **Sort Order** and **Tags**, in that order. `Statistics`, `History` and `Columns` are always there. The others appear only when the table has them at the shown snapshot.
- A column of type `struct`, `list` or `map` has nested fields as children at any depth. They come with the columns, so expanding costs no query.
- A view has the single folder **Columns** when the tree is given `viewColumns` (see [Columns of views](#columns-of-views)), otherwise no children. The SQL of a view is in its tooltip, and **Script as CREATE** and **ALTER** write it into an editor.

## Node kinds

The `kind` of `NodeRef` is the discriminator. The `contextValue` is what the menus in `package.json` match with `viewItem`. An Azure DuckLake adds `.azure` to the value of its connection state (`connection.connected.azure`): the conditions of a connection state accept both, and only Allow My IP and Delete Azure DuckLake... ask for `.azure`. Its tables and views get `table.azure` and `view.azure`, so that their menus leave out Create Notebook, which cannot sign in to Azure; the model sets them from the profile, like those of the connection. The schema `main` has the value `schema.main`: the conditions of a schema accept both, and the `enablement` of `aantje.scriptDrop` (`viewItem != schema.main`) shows Script as DROP disabled there ([Script as DROP](ddl.md#script-as-drop)).

| Kind         | Label                                                        | Description                               | `contextValue`                                          | Children                                  |
| ------------ | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------- |
| `connection` | profile name                                                 | kind, version, snapshot                   | `connection.disconnected`, `.connected`, `.error`       | schemas and two folders, or one `message` |
| `schema`     | schema name                                                  | none                                      | `schema`, `schema.main` for `main`                      | `Tables`, `Views`, `Macros`               |
| `folder`     | folder name                                                  | none                                      | `folder.<name>`                                         | see below                                 |
| `table`      | table name                                                   | none                                      | `table`, `table.azure`                                  | the leaves and folders of a table         |
| `view`       | view name                                                    | none                                      | `view`, `view.azure`                                    | the folder `Columns` (with `viewColumns`) |
| `macro`      | macro name                                                   | `scalar (net, rate := 1.19)`              | `macro`                                                 | none                                      |
| `column`     | column name                                                  | type, with `NOT NULL`                     | `column`, `column.member` (list element, map key/value) | nested fields                             |
| `viewColumn` | column name                                                  | DuckDB type                               | `viewColumn`                                            | none                                      |
| `snapshot`   | `@<id>`                                                      | time in UTC                               | `snapshot`                                              | one `detail` per change, or one `message` |
| `detail`     | the changed object, partition column, sort expression or tag | the action, transform, direction or value | `detail`, `detail.table`                                | none                                      |
| `query`      | the statement on one line, shortened                         | local time and duration                   | `query`                                                 | none                                      |
| `message`    | the text                                                     | none                                      | `message`                                               | none                                      |

A `connecting` connection has the context value `connection.disconnected`, because the menus know no fourth value. Only a connected connection has an icon colour (`charts.green`). Its icon `aantje-duck` is the duck of the Activity Bar, contributed as an icon font (`contributes.icons`, `media/aantje-icons.woff`), so the theme colours it like a codicon.

Folders: `tables`, `views`, `macros` (below a schema), `columns`, `viewColumns`, `partitioning`, `sortOrder`, `tags` (below a table or view), `snapshots` and `queryHistory` (below a connection). `statistics` and `history` are leaves: no children, no description, no tooltip, and a click runs **Show Statistics** and **Schema History** for the table (`TreeNode.command`).

A `detail` node is a leaf that shows a fact and has no command. The exception is the change of a table in a snapshot, which carries `change` and the context value `detail.table`.

A `NodeRef` holds what a command needs (`schema`, `table`, `view`, `column`, the `path` of a nested field, a folder's entries). Entries are in the folder because they were read to decide that it exists, so expanding reads nothing more. Only `snapshots` reads on expansion. Commands that need a table (`relationOf`, `qualifiedNameOf`, `ddlOf`) answer `undefined` for folders and details.

Menus: the exact entries per kind are in `package.json`. Their conditions are anchored (`^(table|view)$`), so `detail` and `message` get no command. Reports are in the **Reports** submenu ([Reports](reports.md)).

## Node ids

A node id is the id of its parent plus one segment, built only from catalog ids: `fixture/s1/tables/t2/columns/c2/c3`. The connection id is URI-encoded.

- **Unique in the whole tree.** Folders use fixed words, entries a letter and a number (`t2`, `v4`, `m16`, `n13`, `p0`, and `q7` for the statement with the sequence number 7 of the Query History), so no leaf can look like a folder.
- **Stable.** No snapshot, counter or position is in the id (except list leaves such as `p0`), so VS Code keeps expansion and selection after a refresh or a time-travel to a snapshot that still has the object.
- **Shared with the search.** `treeNodePath` (`src/search.ts`) builds the same ids, from the schema down to a table, view, column or nested field, so the search can reveal its node.
- Every child that a level returns is recorded with its parent, folders too, so `reveal` finds its way up.

## Connection lifecycle

| Status         | What the node shows                                 | Children                                    |
| -------------- | --------------------------------------------------- | ------------------------------------------- |
| `disconnected` | Icon `plug`, description `sqlite`.                  | Expandable; expanding opens it.             |
| `connecting`   | Icon `sync~spin`, `sqlite · connecting…`.           | Like `connected` once the attempt is over.  |
| `connected`    | Green `aantje-duck`, `sqlite · DuckLake 1.1 · @13`. | Schemas, `Snapshots`, `Query History`.      |
| `error`        | Icon `error`, `sqlite · connection failed`.         | One `message` node; the tooltip repeats it. |

`state(connectionId)` returns the same as data (`status`, `specVersion`, `latestSnapshot`, `snapshot`, `error`). The status bar reads it.

**Lazy connect.** `roots()` opens nothing. Expanding a disconnected connection calls `deps.open(profile)`, which returns the reader together with the info from the catalog check (version, latest snapshot), so one query serves both. The tree then asks `snapshotCount()`. The count is not shown; it decides whether `Snapshots` is expandable and whether its tooltip says that only the newest are listed. If counting fails, the schemas still show.

**One attempt at a time.** Concurrent callers (VS Code asking again, a command calling `connect()`) share one attempt. The tree owns the reader and closes it. In the product `deps.open` is `openWithPassword`, so a PostgreSQL connection shows the password prompt while the node stays `connecting` ([Connections](connections.md)).

**Failure.** `open` failing sets `error`. The user message (`userMessageOf`) is the only child; the technical error goes to the logger. Only an `AantjeError` shows its own text, so a raw driver message with a connection string never reaches the tree. `connect()` does not reject; read `state(id).error`.

**Disconnect.** `disconnect(id)` waits for a running attempt, closes the reader, forgets the cached levels and the pin, and sets `disconnected`. The node then has no expander and `children` returns `[]` until `connect()`, because VS Code reads expanded nodes again after the change event and would otherwise reconnect at once. A connection that was never connected is expandable.

**Profiles that change.** `roots()` reads `deps.profiles()` every time. A new profile is a new disconnected node, a removed one is closed and dropped, and a changed name or kind updates the node. An open reader keeps its old settings until refreshed. The extension refreshes every open or failed connection whose profile changed in anything but the name. Edit Connection refreshes its connection once the new password is stored.

## Snapshot selection

`selectSnapshot(connectionId, snapshot)` sets a snapshot id or `'latest'`.

- `latest` is resolved to a number from `info().latestSnapshot` on connect and refresh. It does not follow the catalog by itself. The description shows `@13`; a pin shows `@5 (pinned)`.
- Every level reads at the shown snapshot, as does the Storage report. The folder `Snapshots` is the exception: it shows what happened in the catalog.
- All levels of a connection use one snapshot. Selecting drops the cached levels and fires a change for the connection node. Stable ids keep the expansion of objects in both snapshots.
- A selection before the first connect is used at connect. A refresh keeps the pin. `disconnect()` resets to `latest`.
- The snapshot is not validated; the picker offers only existing snapshots.

## Refresh

`refresh()` refreshes every connection, `refresh(node)` the connection of the node:

1. Re-read the profiles.
2. Drop the cached levels.
3. If the connection is connected or failed, reopen it (`connecting`, resolve `latest` again, close the old reader once the new one is in place).
4. Fire the change event.

A connection that was never expanded or is disconnected is not opened.

- **Where.** **Refresh** in the view title refreshes every connection. The inline button (`aantje.refresh`) is on an open connection, a schema, the folders **Tables**, **Views** and **Macros** of a schema, a table and a view; each refreshes the connection of its node, so a table that another tool has just created shows up in its folder. Stable ids keep what was expanded.
- **Why reopen.** The SQLite driver reads an in-memory copy taken at open, so a new commit is invisible to an open reader. For PostgreSQL it is a cheap reconnect that also heals a dropped session.
- **Why the whole connection.** Refreshing one table to snapshot 14 while its sibling shows 13 would mix snapshots.
- **Stale nodes.** A node produced by a replaced cache is answered with `[]` and not cached; VS Code then reads the parents again.

Change events carry the same node object that `roots()` returned, because VS Code matches events to elements by identity.

## Columns of views

DuckLake stores no typed columns for a view, only its SQL. The columns come from DuckDB binding the view, which evaluates that SQL with external access enabled ([Security](security.md)). So the caller decides.

- `CatalogTreeDeps.viewColumns` is optional. Without it, a view has no children. With it, the view has the folder `Columns`, and the tree calls `viewColumns` when the user expands **that folder**, not the view. The confirmation appears there.
- The call gets the shown snapshot and an `AbortSignal` that the tree aborts when it replaces or drops the cache. At most three views resolve at once; the others queue in order.
- The answer is cached until the next refresh, snapshot selection or disconnect. Concurrent expansions share one call.
- Children are `viewColumn` nodes in DuckDB order. The description is the DuckDB type with `NOT NULL`. A `STRUCT` column is not unfolded. The id is `<Columns folder id>/c<index>`.
- A rejection becomes one `message` node (icon `error`, logged as an error). A declined question (`ABORTED`) gets the icon `info` and is logged at info level. Both are cached, so a refresh asks again.
- The extension asks once per connection (`ViewTrustStore`, remembered until the target is edited or trust is revoked) and then calls `describeRelation` ([Data access](data-access.md)).

**Trust through another path.** **Select Top 1000 Rows** or **Create Notebook** on a view can trust the connection too. `ViewTrustStore.onDidTrust` fires for a newly trusted connection, and `extension.ts` refreshes that connection only, so the `Columns` folder reads again without a question. A read in flight is aborted and answers with an empty list. **Revoke Trust in Views** refreshes nothing.

## The folders of a table

Expanding a table reads columns, partitioning, sort order and tags in parallel and decides from the answers which folders exist. The column tree of that read names the columns of partitioning and tags.

- **Partitioning** exists when a partitioning is in force at the shown snapshot (a reset counts as none). One leaf per partition column in key order: the label is the column path (`kind`, or `info.c` for a nested field), the description the stored transform. The tooltip says since which snapshot it is in force.
- **Sort Order** exists when the table is sorted at the shown snapshot. One leaf per expression, with direction and null order.
- **Statistics** is a leaf that runs **Statistics** ([Statistics](statistics.md)). The rows, files and size are in the report and in the table tooltip.
- **History** is a leaf that runs **Schema History** ([Schema History](schema-history.md)).
- **Tags** exists when the table or a column has tags other than the comment. Table tags come first, then column tags.

## Snapshots

The folder **Snapshots** is always there. It reads `reader.snapshots(50)` on expansion and shows the newest 50, newest first, whatever snapshot the tree shows. There is no way to load more.

A `snapshot` node has the label `@<id>`, the UTC time as description and a tooltip with the changes in words, the author and the commit message. Expanding it lists one leaf per changed object (dropped and renamed ones too) with the action in words (`Created table`). A snapshot without changes shows "No recorded changes.".

The leaf of a changed table has `ref.change` and the context value `detail.table`. Its menu has **Show Rows Changed** ([Time travel](time-travel.md#show-rows-changed)). Entries for schemas, views and macros, for file maintenance only (`compacted_table`, `merge_adjacent`, `rewrite_delete`, `flushed_inlined`) and for unknown changes have no menu.

- **Show Catalog at this Snapshot** (`aantje.showSnapshot`) pins the snapshot and makes the connection the active one.
- **Show Latest Snapshot** (`aantje.showLatestSnapshot`) makes the tree follow the newest snapshot again. A connection that already follows it gets an information message.

## Query History

The folder **Query History** follows **Snapshots** below a connected connection. It lists the statements that this aantje ran on the connection in the SQL editor with Run Query, Run Statement at Cursor and Execute, newest first ([SQL editor](sql-editor.md#query-history)). It is aantje's own record on this machine, not a log of the lake: DuckLake records no queries, and every client runs its own DuckDB, so the statements of other users and tools are not in it. The tooltip of the folder says so.

- The folder is there while `aantje.queryHistory.size` is above 0. Without entries it shows "No queries yet.".
- A `query` node shows the statement on one line as its label: white space, control and invisible characters become one space, and a label longer than 80 characters ends with `…`. The description is the local time it started (with the date unless it is today) and the duration. The tooltip has the whole statement as code, date and time, duration, rows returned or changed, the status and, for a failure, the error message.
- A failed statement has the icon `error`, a cancelled one `circle-slash`, the others `code`.
- A click opens the statement in a new untitled SQL document bound to the connection (`aantje.openQueryHistoryEntry`, also **Open as New Query** in the menu). Nothing runs. **Copy SQL** (`aantje.copyQueryHistorySql`) copies it. **Clear Query History** (`aantje.clearQueryHistory`) on the folder deletes the entries of that connection.
- Like **Snapshots**, the folder does not follow the snapshot the tree shows.

The entries come from `CatalogTreeDeps.queryHistory`. They are not cached: `children` reads them each time VS Code asks. After a run the extension fires a change for the folder only (`queryHistoryFolder(id)`), so the connection is not read again and completion keeps its catalog. Switching the history on or off (`aantje.queryHistory.size` to or from 0) reads the levels of every connection again with `reread()`, without reopening one.

## Descriptions and tooltips

`src/tree/format.ts` builds all texts as pure functions, with the escaping of `src/markdown.ts`.

- **Connection:** kind, version and snapshot joined with `·`. The tooltip names the server or file, version and snapshot, and for a failure the message. It never contains a password.
- **Table:** rows in data files, number of data files, size (units of 1024 bytes). Rows get a `~` and a hint when `TableStats.approximate` is set (compaction or merged delete files can make an older snapshot's numbers off).
- **View:** the qualified name with the dialect, and the comment. The definition stays out of the tooltip, a long one would fill the screen: **Script as CREATE** shows it.
- **Column:** qualified name with the whole path, comment, type, nullability and default.
- **Macro:** kind and parameters of the first implementation; the tooltip lists every implementation with its dialect and parameters, without its SQL (**Script as CREATE** shows it).
- **Snapshot:** id, UTC time, author, changes in words, commit message.
- **Folder tooltips:** only Partitioning and Sort Order (since which snapshot), Snapshots (newest only) and Query History (whose statements it holds). None has a number.
- **Statement of the Query History:** the whole statement as code, start, duration, rows, status and error ([Query History](#query-history)).

The row count says "in data files" because DuckLake can inline small inserts in the catalog database. The reader sums visible data files minus delete files and does not count inlined rows. `ducklake_table_stats.record_count` is not used: it counts deleted rows and has no history.

**Catalog text is data.** Names, comments, authors, commit messages and view SQL come from the catalog and may contain Markdown. A name goes into a code span with white space collapsed. A comment or commit message is escaped (a backslash before ASCII punctuation, line breaks kept). Control and invisible formatting characters (bidirectional overrides, zero-width characters) are removed. SQL goes into a fence longer than any backtick run inside it. The tooltip is an untrusted `MarkdownString` (no command links, no HTML). Labels and descriptions are plain text; the node factories remove the same characters from the names and values in them (`withoutInvisible` of `src/markdown.ts`), so a name cannot reorder the tree. The rows of the catalog search and of the snapshot picker lose them too, and a `$(` in them is escaped, so that the picker draws no icon.

## Errors

A failure never reaches VS Code as an exception.

| Where                              | What the user sees                                                |
| ---------------------------------- | ----------------------------------------------------------------- |
| `deps.open` fails                  | Status `error`, the message as the only child.                    |
| Reading a level fails              | One `message` node in that level; the connection stays connected. |
| Closing a reader fails             | Nothing (logged).                                                 |
| A change listener throws           | Nothing; the other listeners still run (logged).                  |
| `viewColumns` rejects              | One `message` node below `Columns` (icon `error`).                |
| `viewColumns` declined (`ABORTED`) | One `message` node below `Columns` (icon `info`).                 |

A message node is cached like any level, so a failing catalog is not queried on every expansion. A refresh reads again and reopens the connection, which is the retry.

## Wiring

`extension.ts` creates the `CatalogTree` with `profiles: () => store.list()` and `open: openWithPassword(...)`, the provider and the tree view with `showCollapseAll`. It also passes `viewColumns` and `queryHistory`, and subscribes to `trust.onDidTrust`. The tree is disposed in `deactivate()`, not through `context.subscriptions`, because VS Code does not await asynchronous dispose functions there.

`CatalogTreeProvider` maps `id`, `label`, `description`, `contextValue` one to one, the tooltip to an untrusted `MarkdownString`, the icon to a `ThemeIcon` (with a `ThemeColor` for `iconColor`), `hasChildren` to `Collapsed` or `None`, and a node's `command` to the item's command. `getChildren` returns `tree.roots()` or `tree.children(node)`. `onDidChangeTreeData` forwards `tree.onDidChange`, and fires the folder Query History of a connection whose history changed (`QueryHistory.onDidChange`).

## Known limits

- The tree does not poll. A commit by another process appears after a refresh.
- Inlined rows are not in the row count.
- A refresh of a schema or table refreshes the whole connection, and reopens it (status `connecting` for a moment).
- The context menu of a connection can be stale for about 200 ms after connecting, because the extension host batches change events.
- After `disconnect` the connection cannot be expanded until `connect()`.
- The model does not notice an edited profile by itself; the extension refreshes on a settings change.
- The columns of a view are a flat list and are read again after every refresh and snapshot selection. At most three views resolve at once.
- Names sort with the English collation, whatever the language of VS Code.
- The folder `Snapshots` lists the newest 50 snapshots only.
- The folder `Query History` is there only while the connection is connected. While a writable session holds a DuckDB file, the explorer is disconnected and shows it again once it connects.
