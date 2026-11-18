-- aantje-template: 1
-- name: Restore a table to a snapshot
-- description: Gives a table the rows of an earlier snapshot back, in one transaction; the table keeps its id, so its history goes on.
-- tags: restore, time travel, snapshot, undo
-- created: 2026-11-16
-- param: schema  | identifier | main | Schema of the table
-- param: table   | identifier |      | Table
-- param: version | number     |      | Snapshot id to restore; the snapshots are in the folder Snapshots of the connection
-- WARNING: this deletes the rows of the table and inserts those of the snapshot. The snapshots in between stay readable.
-- The columns must be as they were at the snapshot. For a table whose columns changed since, use Restore Table to Snapshot... in the explorer.
BEGIN TRANSACTION;
DELETE FROM {{schema}}.{{table}};
INSERT INTO {{schema}}.{{table}} SELECT * FROM {{schema}}.{{table}} AT (VERSION => $version);
COMMIT;
