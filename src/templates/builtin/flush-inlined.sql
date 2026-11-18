-- aantje-template: 1
-- name: Flush inlined data of a table
-- description: Writes the rows that DuckLake keeps in the catalog (inlined data) of one table to Parquet files.
-- tags: maintenance, inlined data, flush, parquet
-- created: 2026-11-16
-- param: schema | text | main | Schema of the table
-- param: table  | text |      | Table
-- Without schema_name and table_name the call flushes the inlined data of every table of the lake.
CALL ducklake_flush_inlined_data('lake', schema_name => {{schema}}, table_name => {{table}});
