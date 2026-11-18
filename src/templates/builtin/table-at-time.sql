-- aantje-template: 1
-- name: A table at a point in time
-- description: Reads a table as it was at a point in time (time travel with AT TIMESTAMP): the snapshot that was the newest then.
-- tags: time travel, timestamp, history
-- created: 2026-11-16
-- param: schema | identifier | main | Schema of the table
-- param: table  | identifier |      | Table
-- param: at     | text       |      | Point in time with its zone, such as 2026-11-16 08:00:00+00; not in the future
-- param: limit  | number     | 1000 | Rows to read at most
SELECT *
FROM {{schema}}.{{table}} AT (TIMESTAMP => CAST({{at}} AS TIMESTAMPTZ))
LIMIT $limit;
