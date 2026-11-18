-- aantje-template: 1
-- name: Upsert rows with MERGE
-- description: Updates the rows of a table that a source has as well, matched by a column, and inserts the rows that are new.
-- tags: merge, upsert, load, update, insert
-- created: 2026-11-16
-- param: schema       | identifier | main | Schema of the target table
-- param: table        | identifier |      | Target table
-- param: source       | identifier |      | Table or view with the new rows, with the columns of the target in the same names
-- param: match_column | identifier | id   | Column that identifies a row in both
-- DuckLake allows one UPDATE or DELETE action per MERGE; rows that only the target has stay as they are.
MERGE INTO {{schema}}.{{table}} AS target
USING {{schema}}.{{source}} AS source
ON target.{{match_column}} = source.{{match_column}}
WHEN MATCHED THEN UPDATE
WHEN NOT MATCHED THEN INSERT;
