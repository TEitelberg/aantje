# Suggest Partitioning

**Suggest Partitioning...** (`aantje.suggestPartitioning`) proposes partition and bucket columns for a table from the queries that are actually run on it and from its data, so that a partitioning fits the filters and does not produce thousands of tiny files. It is a report on the [report shell](reports.md) with **Refresh** and **Open as Markdown**; nothing runs on the lake but read-only measurements, and the script it opens is for you to run.

## Opening it

- **Where.** The **Reports** submenu of a table, and the large tables without partitioning in the [Maintenance Advisor](advisor.md#the-page). The command needs a node and is hidden from the Command Palette.
- **One panel per connection and table**, titled `Suggest Partitioning: schema.table · <connection>` (the page heading is `Suggest Partitioning: schema.table`). It reads the table at the newest snapshot, because a partitioning applies to what is written next.
- **Progress with Cancel** while the history is read and the data is measured. A table that no longer exists at the newest snapshot gets a message and no panel.

## Where the suggestions come from

**The filters of the Query History.** The statements of your [Query History](sql-editor.md#query-history) of the connection that ran without an error are read with DuckDB's parser (`json_serialize_sql` on the sandboxed parser of `src/sql/parser-engine.ts`; nothing is run). Of every query that reads the table (catalog `lake` or none, schema `main` for an unqualified name, as in the SQL editor; CTEs and subqueries included), the columns of the table in WHERE and JOIN ON count, per query: by equality (`=`, `IN`), by range (`<`, `>`, `BETWEEN`), in a join (`a.x = b.y`) or otherwise (`LIKE`, a function, `<>`, `NOT IN`). A statement that writes is no query here. The history is local: it holds only your own statements on this machine, at most `aantje.queryHistory.size` per connection, so the panel says how many statements it found, how many are queries and how many filter the table; queries of other users and clients are not visible to aantje. The history stores no profiles, so the dynamic filters of a profile are not part of it.

**The data, measured by DuckDB** on a read-only session of the lake (the storage sign-in of the connection, as the [Health check](health-check.md) uses it), one scan per statement and each under the statement time limit (`src/partitioning/measure.ts`):

- `count(*)`, and for each measured column `approx_count_distinct` and its NULLs. The columns measured are the most filtered (up to 6), the date and timestamp columns (up to 3) and, when that gives fewer than two, other columns of a type a partition can take (no float, nested type or blob); at most 8.
- For a date or timestamp column, the partitions of each unit: the distinct years, months, days and hours.
- For the best three candidates, the rows of the largest partition (one `GROUP BY` scan each).

Rows and bytes per partition follow from the rows and the size of the table in the catalog.

## The candidates

| Column                               | Transform                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A date or timestamp                  | The finest unit whose partitions keep at least 128 MiB each: `year(ts)`, `year(ts), month(ts)`, then day and hour as further keys (DuckLake's `month` is the month of the year, so the year stays a key). |
| At most 1,000 distinct values        | Identity: the column itself.                                                                                                                                                                              |
| More, filtered by equality or a join | `bucket(N, column)`, with N so that a partition gets towards 128 MiB to 1 GiB (at most 1,024); none when the table is too small for two such buckets.                                                     |

Each candidate shows its partitions, rows and bytes per partition, and the files per partition with their size, from the target file size of the table or the lake (`target_file_size`, else DuckLake's 512 MB). Reasons: how many of the queries filter on the column and how; the distinct values; what a filter reads. Risks: files below 16 MiB (the small-file threshold of the [Statistics report](statistics.md)), more than 1,000 partitions, a table smaller than one good file, 10 % or more NULL values, a skewed largest partition. Candidates with filters by equality and, for a time, by range come first; every risk ranks a candidate lower.

On the page each candidate, and the sort order offered instead, is a closed card with its keys as its title (a candidate with a risk has the warning sign before it); you open the one you want.

The panel also shows the partitioning and the sort order the table has, and **a sort order instead** when the most filtered column fits no partitioning without a risk: written sorted by it, files and row groups have narrow ranges that a filter skips (the [performance tips](sql-editor.md#performance-tips) suggest the same).

## The scripts

**Open Script** on a candidate opens an untitled SQL document of the connection; nothing runs when it opens:

1. **A dry run, active:** a `SELECT` of the new keys with `count(*)`, grouped, the largest partition first. It only reads. DuckDB has no `bucket` function, so a bucket is counted with `hash(column) % N` there; DuckLake spreads the values as evenly, into other buckets.
2. **The partitioning, commented out:** `ALTER TABLE lake."schema"."table" SET PARTITIONED BY (...)`. DuckLake applies it to what it writes from then on.
3. **The rewrite, commented out:** in one transaction, `DELETE` and `INSERT ... SELECT * FROM ... AT (VERSION => getvariable('aantje_snapshot'))`, the snapshot the transaction starts from, so it writes back exactly the rows the DELETE removes, now under the new partitioning (as the sort-order script of the performance tips does). The old files stay for time travel until Expire Snapshots and Clean Up Old Files remove them.

The commented statements are commented line by line, so a line break in a name cannot end the comment. Like the destructive [Maintenance scripts](maintenance.md), the real statements are yours to uncomment. **Open Sort Order Script** opens the script of the performance tips for the column. The page names a candidate by its index; the extension writes the script from its own data (`planPartitionAction`).

## Module

`src/partitioning/`: `filters.ts` (the predicates of the parse tree), `measure.ts` (the statements of the measurements), `model.ts` (the candidates, their figures, reasons and risks), `read.ts`, `script.ts`, `actions.ts`, `protocol.ts`, `kind.ts`, `markdown.ts`, `page.ts`, `style.ts`, `commands.vscode.ts`.

## Known limits

- A suggestion from few queries is a weak one, and other clients' queries are not seen.
- `approx_count_distinct` is an estimate; the partitions of a time unit are exact.
