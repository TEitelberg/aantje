-- aantje-template: 1
-- name: Partitioned table from Parquet files
-- description: Creates a table from Parquet files with a partitioning by year and month and a sort order, before the rows go in, so that every file is written that way.
-- tags: load, ctas, partitioning, sort order, parquet
-- created: 2026-11-16
-- param: schema      | identifier | main                       | Schema of the new table
-- param: table       | identifier |                            | Name of the new table
-- param: files       | text       | s3://bucket/path/*.parquet | Parquet files to load: a path, a glob or a URL
-- param: ts_column   | identifier | ts                         | Timestamp column to partition by year and month
-- param: sort_column | identifier | id                         | Column to sort the rows of each file by
-- The table is created empty first: DuckLake writes the partitioning and the sort order into the files that come after.
CREATE TABLE {{schema}}.{{table}} AS SELECT * FROM read_parquet({{files}}) LIMIT 0;
ALTER TABLE {{schema}}.{{table}} SET PARTITIONED BY (year({{ts_column}}), month({{ts_column}}));
ALTER TABLE {{schema}}.{{table}} SET SORTED BY ({{sort_column}} ASC);
INSERT INTO {{schema}}.{{table}} SELECT * FROM read_parquet({{files}});
