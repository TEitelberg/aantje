-- aantje-template: 1
-- name: Remove duplicates, keep newest
-- description: Keeps one row of each key, the one with the largest value of an order column, and deletes the others; it starts as a dry run that counts the rows that would go and shows some of them. The key is one column.
-- tags: data quality, duplicates, deduplicate, cleanup
-- created: 2026-11-17
-- param: schema       | identifier | main | Schema of the table
-- param: table        | identifier |      | Table with duplicate rows
-- param: id_column    | identifier | id   | Column whose values should each have one row
-- param: order_column | identifier | ts   | Column whose largest value marks the row to keep, such as the time of a change
-- param: limit        | number     |      | Rows that would go to show at most
-- WARNING: the real step deletes the duplicate rows, and nothing else of the table changes: it keeps its id and its
-- settings (NOT NULL, partitioning, sort order, comments), DuckLake records a snapshot with the deletions, and time
-- travel to a snapshot before it still reads the deleted rows.
-- It finds the rows by rowid, the number that DuckDB gives each row. Do not run it on a table with a column of its
-- own named rowid: that column hides the number, and the step would delete other rows.
-- The statements that are not commented out are a dry run: the number of rows that would go, and some of them. To
-- delete them for real, remove the "-- " in front of the lines of DELETE at the end and run them.
-- Of the rows of a key with the same largest value of the order column, any one is kept.
SELECT count(*) AS rows_to_remove
FROM (
  SELECT row_number() OVER (PARTITION BY {{id_column}} ORDER BY {{order_column}} DESC) AS position
  FROM {{schema}}.{{table}}
)
WHERE position > 1;
SELECT *
FROM {{schema}}.{{table}}
QUALIFY row_number() OVER (PARTITION BY {{id_column}} ORDER BY {{order_column}} DESC) > 1
ORDER BY {{id_column}}, {{order_column}} DESC
LIMIT $limit{100};
-- DELETE FROM {{schema}}.{{table}}
-- WHERE rowid IN (
--   SELECT rowid
--   FROM {{schema}}.{{table}}
--   QUALIFY row_number() OVER (PARTITION BY {{id_column}} ORDER BY {{order_column}} DESC) > 1
-- );
