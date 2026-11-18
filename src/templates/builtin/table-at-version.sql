-- aantje-template: 1
-- name: A table at a snapshot
-- description: Reads a table as it was at an earlier snapshot (time travel with AT VERSION).
-- tags: time travel, snapshot, version, history
-- created: 2026-11-16
-- param: schema  | identifier | main | Schema of the table
-- param: table   | identifier |      | Table
-- param: version | number     |      | Snapshot id; the snapshots are in the folder Snapshots of the connection
-- param: limit   | number     | 1000 | Rows to read at most
-- The snapshot id and the limit are asked for at every run.
SELECT *
FROM {{schema}}.{{table}} AT (VERSION => $version)
LIMIT $limit;
