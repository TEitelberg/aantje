# Snapshot selection, catalog search and status bar

`src/snapshot.ts`, `src/search.ts` and `src/status.ts` hold the logic behind three explorer features: time travel with a snapshot picker, the catalog search and the status bar item. They are pure functions without a `vscode` import. The wiring in `src/commands.vscode.ts` (the two pickers, built on `createQuickPick`) and `src/extension.ts` (the status bar item) only turns their results into UI.

## What the user gets

### Show Catalog at Snapshot

`aantje: Show Catalog at Snapshot...` (`aantje.selectSnapshot`; an inline icon on a connected connection, an entry in its context menu, and the status bar item) time-travels the whole tree: schemas, tables, views, columns, comments and statistics are shown as they were at the picked snapshot. The picker lists:

- **Latest** first. It follows the newest snapshot, also after a refresh. Its description names the id that is newest now.
- Then every snapshot, newest first: label `@<id>`, description the commit time in UTC (`2026-10-29 21:22:46 UTC`), detail what the snapshot changed. A commit message (`CALL set_commit_message`) is shown in front of the changes on one line: `Nightly import · Inserted into table #9`. Line breaks in the message become spaces and `$(` is escaped.

The cursor starts on the current selection (`picked`): "Latest" while the tree follows the latest snapshot, else the pinned snapshot. Pinning the newest snapshot explicitly is a different state from "Latest", because the tree then no longer follows new snapshots. When the pinned snapshot has expired, no row is picked. You can type a date or a word of the detail to filter.

### Search Catalog

`aantje: Search Catalog...` (`aantje.search`) lists every table and view of the connected catalog at the selected snapshot as `<schema>.<name>` with `table` or `view` as description, sorted by schema and then name, ignoring case and comparing numbers by value (`part_2` before `part_10`), like the tree. VS Code filters the list while you type. After a pick the tree opens the connection, schema and folder, selects the node and takes the focus.

`treeNodeId` gives the id of that node: `<connectionId>/s<schemaId>/tables/t<tableId>` for a table and `.../views/v<viewId>` for a view; `folderNodeId` gives the folder. The connection id is URI-encoded like the connection node's id. The id builders live in `src/tree/nodes.ts` and are shared with the tree.

### Status bar item

| State                           | Text                                                | Tooltip                                                                          |
| ------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Connected, following the latest | `$(database) example · DuckLake 1.1 · latest (@13)` | `Select snapshot. Following the latest snapshot (@13).`                          |
| Connected, snapshot 6 pinned    | `$(database) example · DuckLake 1.1 · @6 (pinned)`  | `Select snapshot. Pinned to snapshot @6, not following the latest (@13).`        |
| Connecting                      | `$(sync~spin) example · connecting…`                | `Connecting to example…`                                                         |
| Disconnected                    | `$(debug-disconnect) example · disconnected`        | `example is not connected.`                                                      |
| Error                           | `$(error) example · connection failed`              | `The connection to example failed. See the "aantje" output channel for details.` |

- Unknown parts are left out: without a spec version the `DuckLake 1.1` part is missing; without the latest snapshot id the text says `latest`. Snapshot `0` is a known id.
- Only a connected item has a click command (`aantje.selectSnapshot`); the other states have none, because there is no catalog to pick from.

### The connection in use

Without a node (view title, Command Palette, status bar) the commands act on the connection in use: the one connected or selected last. When it is disconnected or removed, another connected one takes over, else the first profile (`activeProfile`). If that one is not connected, the command says `Connect to a catalog first to choose a snapshot.` (or `... to search it.`). The status bar item shows the connection in use. It is visible while the aantje view is visible or the connection is not disconnected, so windows that never use aantje stay clean. `src/active-connection.vscode.ts` keeps the choice and the item.

## Change descriptions

`describeChanges(changes)` turns the `changes_made` column of `ducklake_snapshot_changes` into text. The column holds comma-separated `token:argument` entries, for example `created_table:"main"."t",inserted_into_table:7`. `parseChanges` and the token vocabulary live in `src/catalog/changes.ts` ([Catalog reader](catalog-reader.md)); `src/snapshot.ts` owns the wording (`describeAction`). The vocabulary is the DuckLake specification plus tokens only the extension source knows (`flushed_inlined`, tags, `expired_snapshot`).

| Shown as                                                                                                                        | Token(s)                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Created schema sales`, `Created table sales.orders`, `Created view ...`, `Created scalar macro ...`, `Created table macro ...` | `created_schema`, `created_table`, `created_view`, `created_scalar_macro`, `created_table_macro` (name) |
| `Dropped schema #1`, `Dropped table #3`, `Dropped view #4`, `Dropped scalar macro #7`, `Dropped table macro #8`                 | `dropped_*` (id)                                                                                        |
| `Altered table #2`, `Altered view #4`                                                                                           | `altered_table`, `altered_view`                                                                         |
| `Inserted into table #2`, `Deleted from table #2`                                                                               | `inserted_into_table`, `deleted_from_table`                                                             |
| `Inserted inlined rows into table #2`, `Deleted inlined rows from table #2`                                                     | `inlined_insert`, `inlined_delete`                                                                      |
| `Flushed inlined data of table #2`                                                                                              | `flushed_inlined`, `inline_flush`                                                                       |
| `Compacted table #2`, `Merged adjacent files of table #2`, `Rewrote data files of table #2`                                     | `compacted_table`, `merge_adjacent`, `rewrite_delete`                                                   |
| `Created snapshot tag release 1`, `Dropped snapshot tag release 1`, `Expired snapshot @5`                                       | `created_tag`, `dropped_tag` (name), `expired_snapshot` (snapshot id)                                   |

- **Several changes** in one snapshot appear in stored order, separated by `; `.
- **Names** are SQL identifiers in double quotes: `"sales"."orders"` is `sales.orders`; a doubled quote is one quote. A comma inside a quoted name does not separate two changes; a colon or line break inside a name belongs to the name.
- **Ids.** `#<id>` is a catalog id (schemas, tables, views and macros share one id space), `@<id>` a snapshot id. The stored text names only created objects, so other changes show an id. The names come from `reader.snapshotChanges(id)` ([Catalog reader](catalog-reader.md)).
- **Nothing is hidden.** An unknown token, a known token with an argument of the wrong shape, or an entry without a colon is shown as stored. Such input never throws.
- `null` and the empty string give `No recorded changes`.

## Public API

```ts
// src/snapshot.ts
export function describeChanges(changes: string | null): string;
export function snapshotPickItems(
  snapshots,
  current: { selected: SnapshotId | 'latest'; latest: SnapshotId },
): SnapshotPickItem[];
export function snapshotChoices(
  snapshots,
  selected: SnapshotId | undefined,
  within?: Lifetime,
): SnapshotPickItem<SnapshotId>[];

// src/search.ts
export function searchPickItems(entries: readonly CatalogEntry[]): SearchPickItem[];
export function treeNodeId(connectionId: string, entry: CatalogEntry): string;
export function folderNodeId(connectionId: string, entry: CatalogEntry): string;

// src/status.ts
export function statusBarContent(state: StatusBarState): { text: string; tooltip: string };
export function activeProfile(profiles, inUse: string | undefined, statusOf): Profile | undefined;
```

- `snapshotPickItems` sorts by id, newest first, not by commit time, which is the clock of the client that wrote the snapshot. The description is the first 19 characters of `SnapshotInfo.time` (ISO 8601 in UTC), so no `Date` and no time zone is involved and seconds are cut, not rounded.
- `snapshotChoices` is the same list without the "Latest" row, optionally cut to the `Lifetime` of a table or view (first snapshot inclusive, end exclusive). The commands of [Time travel](time-travel.md) use it.
- `searchPickItems` does not change its input. Names are ordered with the shared collator of `src/order.ts` (`en`, numeric, base sensitivity), so a name has the same place in the search and in the tree.
- `statusBarContent` covers every `status` of the tree's `ConnectionState`; a new status is a compile error until it has a text.
- Both item types are shaped like `vscode.QuickPickItem` plus a `value`, so a chosen item hands the selection back without a lookup.

## Design decisions

- **Pure functions, ready-made texts.** The adapter has nothing to decide, and ESLint keeps `vscode` out of these files.
- **`picked` marks the selection.** VS Code honours `picked` only in multi-select pickers, so the wiring moves the picked row into `activeItems`.
- **Unknown input is shown, not dropped.** DuckLake adds tokens over time; a history that silently left a change out would be worse than one that shows a raw token.
- **Quote-aware splitting**, as in DuckLake's parser: a table can be named `orders, 2026`.
- **A `Map` for the vocabulary**, so `constructor` or `toString` are not known tokens.
- **The tooltip does not promise what a click cannot do.**

## Testing

```bash
npx vitest run test/unit/snapshot.test.ts test/unit/search.test.ts test/unit/status.test.ts
```

The tests read the real fixture catalog (14 snapshots, plus a history fixture with commit messages) and check the pick rows, the descriptions of every token and of malformed input, the order and node ids of the search (including a comparison with the nodes of the real tree), and the status bar texts for every state.

## Limits

- **Ids instead of names.** `Inserted into table #2` does not say which table; the names come from `reader.snapshotChanges(id)`.
- **A long change list is one long line.** The picker truncates it; there is no "and 5 more".
- **Only the commit message is shown.** `author` and `commitExtraInfo` of `SnapshotInfo` are left out.
- **The time must be UTC.** A value with an offset would show its local time labelled `UTC`.
- **Tables and views are mixed** in the search; the tree lists tables first, then views. VS Code re-orders the list by match quality as soon as you type.
- **Names are not escaped** in the status bar text and in search row labels: a name that contains `$(` shows an icon where the text should be.
- **Wording of newer tokens.** The specification does not describe `created_tag`, `dropped_tag` or `expired_snapshot`; "snapshot tag" and "expired snapshot" follow the DuckLake source.
