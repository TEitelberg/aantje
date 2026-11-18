-- aantje-template: 1
-- name: Rows changed between two snapshots
-- description: Lists the rows of a table that were inserted, updated or deleted between two snapshots, with the snapshot and the kind of each change.
-- tags: changes, snapshots, time travel, audit, change feed
-- created: 2026-11-16
-- param: schema        | text   | main | Schema of the table
-- param: table         | text   |      | Table
-- param: from_snapshot | number | 1    | First snapshot id; the snapshots are in the folder Snapshots of the connection
-- param: to_snapshot   | number |      | Last snapshot id
-- The snapshot ids are asked for at every run, so the same document reads other snapshots without an edit.
SELECT *
FROM ducklake_table_changes('lake', {{schema}}, {{table}}, $from_snapshot, $to_snapshot)
ORDER BY snapshot_id, rowid;
