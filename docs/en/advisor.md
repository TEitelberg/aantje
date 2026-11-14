# Maintenance Advisor

The Maintenance Advisor (`aantje.showAdvisor`) says what maintenance would do to a lake and offers the script that does it. It measures with the dry runs DuckLake offers (`dry_run => true`) and with the catalog, ranks the findings by impact, effort and risk, and opens the matching script of the [Maintenance menu](maintenance.md) on request. Nothing is executed: the report reads, the scripts open as documents, and the user runs them.

It is a report on the [report shell](reports.md).

## Opening the advisor

- **Where.** The **Reports** submenu of an open connection or of a schema. The command needs a node, so it is hidden from the Command Palette.
- **Snapshot.** Always the newest: the dry runs act on the newest state, and the catalog facts are read at the same snapshot. The tree may show another one; the report says `Snapshot @130`.
- **One panel per connection and scope**, titled `Maintenance Advisor · <connection>` or `Maintenance Advisor · <connection> · schema <schema>`. The command again reveals it with fresh data.
- **Progress with Cancel.** The notification `Measuring the maintenance of "Lake"...` has a Cancel button. Cancelling interrupts the running statement and ends the command with `The query was cancelled.`; an open panel keeps what it showed.
- **Closed connection.** `Connect to a catalog first to show its maintenance advice.` A refresh after the connection was removed says `The connection of this maintenance advisor was removed. Close the report.`

## Advice for one schema

The command on a schema node (`AdvisorScope` `{ kind: 'schema', id, name }`) limits the merge, rewrite and flush candidates to the tables of the schema: the catalog reads (`maintenanceFacts`, `deleteHeavyTables`) take the schema as scope, so the cut at 100 tables per kind and `more` are about the schema. Snapshots, expiry, files that cleanup would delete, orphaned files and the files scheduled for deletion are lake-wide, and so are the options of the policy: the report keeps them, writes `(lake-wide)` after their key figures, summary rows and recommendations, and says so in a note and in the Markdown Scope row. The scripts of these three recommendations stay the lake's. **Check Health** in a schema report opens the health check of the schema; **Show Storage Report** stays the lake's.

## What is measured

| Measurement                     | Source                                                                    | Result                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Snapshots that would expire     | `ducklake_expire_snapshots(..., older_than => <policy>, dry_run => true)` | How many, from which time to which.                                                                                              |
| Files that cleanup would delete | `ducklake_cleanup_old_files('lake', dry_run => true)`                     | How many files and their size.                                                                                                   |
| Orphaned files                  | `ducklake_delete_orphaned_files('lake', dry_run => true)`                 | How many files and their size.                                                                                                   |
| Merge candidates                | the catalog (`maintenanceFacts`)                                          | Tables with many small files, with the estimate of their files after a merge and their small files with deleted rows.            |
| Rewrite candidates              | the catalog (`deleteHeavyTables`)                                         | Tables with data files in which at least half the rows are deleted (or the lake's threshold, when lower), and how many reach it. |
| Flush candidates                | the catalog (`maintenanceFacts`)                                          | Tables with more than 10 000 rows inlined in the catalog.                                                                        |

The dry runs and the size lookups go through the one-shot engine (`withLakeSession`): a private in-memory DuckDB that attaches the lake `READ_ONLY` at its newest snapshot and locks the configuration. Statements are fixed text; the only values are the policy interval and the paths a dry run returned, both as string literals.

How the dry runs behave (checked with DuckDB 2.0.0, DuckLake 1.1, local files, a stand-in object store and RustFS):

- **Expiry.** `ducklake_expire_snapshots` lists the snapshots it would expire, never the newest. It can be aggregated, so the page gets one row. Without `older_than` it lists nothing, because DuckLake has no default age.
- **Cleanup and orphans** return only `path`; there is no size. Without `older_than` they apply the lake's `delete_older_than`, else DuckLake's own default of 2 days (checked with DuckLake 1.1: a file scheduled 47 hours ago is spared, one scheduled 48 hours ago is listed). The files that the dry run of cleanup lists are the ready ones; the card **Scheduled for deletion** and the summary of the document show all scheduled files as `n ready now, m waiting` (from the catalog, see [Storage report](storage-report.md#files-scheduled-for-deletion)).
- **Sizes** come from `read_blob([...])` with only `size` selected: one `HEAD` per file, nothing is downloaded. At most the first 1000 files of a list are sized, in batches of 250; the page says `at least` when the size covers only part. Glob characters in a path are written as classes. A file that is gone is not counted.
- **Only paths below the data path are sized.** A catalog can name any path or URL, so a path elsewhere (a URL, a `..` segment) is listed and counted but never contacted.
- **`dry_run => true` changes nothing**, even in the read-only attachment. The same functions delete files without it, even in a read-only session (see [SQL session](sql-session.md)), so every statement carries `dry_run => true`.
- **Rewrite** has no dry run, so the advisor counts from the delete files: per data file `delete_count` against `record_count`. DuckLake rewrites a file when its deleted share is at least the threshold.

## The policy

Every number rests on a setting the page shows under **Policy**. The lake's global option wins, else the default is named.

| Setting                     | Option of the lake         | Default                                    | Used for                                           |
| --------------------------- | -------------------------- | ------------------------------------------ | -------------------------------------------------- |
| Age for the expiry          | `expire_older_than`        | 30 days (the advisor's; DuckLake has none) | The `older_than` of the expiry dry run.            |
| Age for cleanup and orphans | `delete_older_than`        | the age DuckLake itself applies            | Nothing is passed; the dry runs use the lake rule. |
| Split of the snapshots      | `expire_older_than`        | 30 days (the advisor's)                    | `n expirable now, m younger` from the catalog.     |
| Share for a rewrite         | `rewrite_delete_threshold` | 0.95 (DuckLake's default)                  | The files Rewrite Data Files rewrites.             |
| Size of a merged file       | `target_file_size`         | 512 000 000 bytes (DuckLake's default)     | The estimate of the files after a merge.           |

Option values go into SQL or a division, so they are checked first: an interval is whole numbers with a unit, a threshold a number from 0 to 1, a size a whole number of bytes. A value that fails is named in the policy and the default applies. Options of a single table are not considered.

## The recommendations

Each recommendation has a title, an explanation, exact figures and three levels written as words and symbols, not colour alone: `high ▲▲▲`, `medium ▲▲△`, `low ▲△△`. Medium or high risk gets a `⚠`; a high-risk card has a warning border.

| Kind                  | Offered when                                                                   | Impact by (medium / high)                                       | Effort                       | Risk   |
| --------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------- | ------ |
| Clean up old files    | the dry run lists files                                                        | 100 MiB or 100 files / 1 GiB or 1000 files                      | low                          | medium |
| Delete orphaned files | the dry run lists files                                                        | the same                                                        | medium                       | high   |
| Expire snapshots      | the dry run lists snapshots                                                    | 100 / 1000 snapshots                                            | low                          | high   |
| Merge adjacent files  | a table has at least 5 data files, at least half below 16 MiB (`SMALL_FILES`)  | files saved: 100 / 1000                                         | low                          | low    |
| Rewrite data files    | a table has files with at least half the rows deleted (or the lower threshold) | deleted bytes: 100 MiB / 1 GiB; low if none reach the threshold | low, medium if none reach it | low    |
| Flush inlined data    | a table has more than 10 000 inlined rows                                      | rows: 100 000 / 1 000 000                                       | low                          | low    |

Ranking: highest impact, then lowest risk, then lowest effort, then the kind (clean up, orphans, expire, rewrite, merge, flush), then the larger gain. A dry run that finds nothing makes no recommendation; a skipped one is listed under **Not measured**.

- **Expiring frees nothing by itself.** Files only expired snapshots needed are scheduled for deletion; Clean Up Old Files deletes them. Time travel to an expired snapshot ends for good.
- **Orphaned files** carry the live-writer warning: a running writer (such as Sail) may have uploaded files it has not committed, and deleting them breaks its commit.
- **A merge estimate** is labelled as such: the small files add up to the sum of their catalog sizes and become files of the target size (never more files than before, never fewer than one). A real merge joins only adjacent files of one partition, so the real number can be higher. The estimate counts on the rewrite that the script puts first (next point), so the small files with deleted rows are merged too.
- **Small files with deleted rows.** A merge leaves a file with a delete file alone. When some small files of a candidate have a delete file, the recommendation says how many, that the merge leaves them alone and that its script rewrites them first: `ducklake_rewrite_data_files` with `delete_threshold => 0`, which rewrites every file of the table with a deleted row, small or not. The figures add how many small files have deleted rows and how many files of which size the rewrite writes. The script is the Merge script of the [Maintenance menu](maintenance.md#merge-adjacent-files-small-files-with-deleted-rows), with that rewrite. It is made from the counts of the panel and reads nothing again, so it is the same while the explorer is not connected. When those counts cannot be read (a size in the catalog that is no count, or a failed read), the recommendation goes without them and says so. Its script and the script for all recommendations then say that they could not tell which small files have deleted rows, and the merge stays plain.
- **A rewrite below the threshold.** With the default 0.95 a file with 70 % deleted rows is not rewritten and the plain script changes nothing. The recommendation says so and names the way out (`delete_threshold => 0.5` in the call, or the option).

## The page

The header has the title, a summary (`Snapshot @130 · Lake · read 2026-10-31 12:00:00 UTC · dry runs only, nothing is changed`), **Create maintenance script for all recommendations** (only when there is a recommendation), **Refresh** (measures again at the newest snapshot) and **Open as Markdown**. Below:

1. **Key figures.** Snapshots to expire, files to clean up, orphaned files, reclaimable space (cleanup plus orphans; `at least` when something was skipped or sized in part) and the merge, rewrite and flush candidates. A skipped measurement reads `not measured` with the reason. The hint of **Snapshots to expire** and a row of the document say how many snapshots are expirable now and how many are younger than the age (`100 snapshots expirable now, 19 younger than 30 days`), counted from `ducklake_snapshot` with the options (`expirableSnapshots(metadata)` of the reader, one read of the options for all); the note says when the lake sets no `expire_older_than`, so that Expire Snapshots as generated names the age.
2. **Recommendations** as expandable cards, the first open, with the buttons below.
3. **Not measured**, only when something was skipped: the reason, and **Open script** for the failed dry run so the user can run it and read the error.
4. **Policy** with this lake's values.

## Actions

The page asks for an action by id and, for a table, by catalog id; it never names a command or sends text. The extension checks the request against the report guard and then against the data it sent (`planAdvisorAction` in `src/advisor/actions.ts`): a table not in the data is ignored, and a table script is accepted only for a table the advisor named for it.

| Action id                                        | Field   | What it does                                                                              |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------- |
| `scriptExpire`, `scriptCleanup`, `scriptOrphans` |         | **Open script:** the lake's Maintenance script, dry run active, real call commented out.  |
| `scriptMerge`, `scriptRewrite`, `scriptFlush`    | `table` | **Open script:** the Maintenance script of that table (a merge with its rewrite first).   |
| `revealTable`                                    | `table` | **Show table in tree**; says so when the tree's snapshot has no such table.               |
| `showStatistics`                                 | `table` | **Show Statistics** at the report's snapshot.                                             |
| `showStorage`                                    |         | **Show Storage Report** of the connection.                                                |
| `maintenanceScript`                              |         | **Create maintenance script** ([below](#the-maintenance-script-for-all-recommendations)). |
| `checkHealth`                                    |         | **Check Health** of the connection, or of the schema in a schema report.                  |

The scripts are those of the Maintenance menu (`maintenanceOf` in `src/maintenance/scripts.ts`). The document belongs to the connection, so F5 runs it there; opening never runs it. The scripts follow the options of the lake like those of the menu, see [Maintenance scripts](maintenance.md#expire-snapshots-and-delete-orphaned-files-which-age-the-script-uses): Expire Snapshots follows `expire_older_than` when the lake sets it and names the age of 30 days otherwise; Delete Orphaned Files follows `delete_older_than`.

## The maintenance script for all recommendations

**Create maintenance script for all recommendations** (header of the panel) opens one untitled SQL document that belongs to the connection. It is a button of the report, not an entry of the context menu. The button uses the data of the panel, so the script follows its scope: a schema report gives merge, rewrite and flush for the tables of that schema, and expire, clean up and orphans for the lake, which are lake-wide either way. Nothing runs when the document opens.

`advisorScriptOf` (`src/advisor/script.ts`) turns every recommendation into a block and hands the blocks to `scriptDocument` (`src/maintenance/document.ts`), the builder that the [Health script](health-check.md#the-maintenance-script-for-all-findings) uses too; the statements are those of the Maintenance menu (`lakeScript`, `tableScript`), and a merge block rewrites the small files with deleted rows first, from the counts of the panel. The order is the one of the steps: merge and flush (by table), rewrite, expire snapshots, clean up old files, delete orphaned files last. Each block names its subject (the lake or `Table schema.name`), the recommendation as the page words it and its figures, so the estimate is in the comment. Destructive calls start with the dry run and keep the real call commented out, with the age of the Maintenance menu (30 days), not the policy. The Advisor has no option recommendation; a table with `auto_compact` `false` is skipped by the compaction even when named, which the Health script covers.

A rewrite recommendation that is only a hint (no file reaches the threshold) gets a note: the plain call changes nothing until `delete_threshold` is added.

## Open as Markdown

The header button opens an untitled Markdown document built from the panel's data (`advisorMarkdown` in `src/advisor/markdown.ts`): a Property / Value table, `## Policy`, `## Not measured` when needed, and `## Recommendations` (a ranked table, then one section each with explanation, figures and the matching Maintenance entry). Catalog text goes through `code()` of `src/markdown.ts`, the connection name through `markdownText`. Recommendations are cut at 50 with `… n more omitted (limit: 50).`; table lists are cut at 100 per kind. The page has no filter, so the extension refuses a request that carries a view.

## Reading the data

`readAdvisor` (`src/advisor/read.ts`) reads the newest snapshot and the options, then in parallel the storage totals, the tables, `maintenanceFacts`, `deleteHeavyTables` and the three dry runs of `measureDryRuns` (`src/advisor/measure.ts`). A dry run that fails (store refuses, time limit, unreachable data path) becomes `{ state: 'skipped', reason }` and the others go on. If the engine cannot start, all three are skipped and the catalog candidates are still shown. A cancel rejects with `ABORTED`. Each statement is limited by `aantje.queryTimeoutSeconds`, else 60 seconds. The page checks the data with `isAdvisorMessage` before showing it.

For each table of small files, `maintenanceFacts` also counts the data files with a delete file: the small ones, all of them and their size (see [Catalog reader](catalog-reader.md#reads-for-the-health-check)).

`deleteHeavyTables(scope, floor, threshold, limit, signal?)` of the catalog reader returns tables with data files in which at least `floor` of the rows are deleted by the delete file valid at the newest state, with the files reaching `threshold`, the rows and the size. The advisor passes half, or the lake's threshold when lower, so a file the real call would rewrite is never invisible. Shares are compared as whole numbers so SQLite, DuckDB and PostgreSQL agree.

## Security

The page loads from `dist` under a nonce CSP (see [Reports](reports.md#the-shell)). Catalog text is set as text, never as markup. A request is `ready`, `refresh`, `markdown` (with no view) or one of the eleven actions with exactly its fields; anything else is ignored, so the page cannot make the extension run a command, open text it wrote, choose a script's age or touch a table it was not sent. The engine is read-only and locked, and the connection string and password never reach an error text. What a hostile catalog can still make the extension touch is in [Security](security.md).

## Known limits

- The dry runs act on the newest snapshot, whatever the tree shows.
- How many files and bytes an expiry frees is not measured; the dry run lists snapshots only.
- At most 1000 files of a dry run are sized; larger figures are lower bounds, and `size unknown` appears when the store gives none.
- The orphan dry run reads the whole data path (on an object store one request per 1000 keys).
- At most 100 tables of each kind are named, and inlined rows are counted for at most 101 inlined tables; the page says when more may qualify. When the inlined rows of some tables cannot be read, the page and the document say that Flush Inlined Data may concern more tables than listed.
- A dropped table that still has inlined data is not named.
