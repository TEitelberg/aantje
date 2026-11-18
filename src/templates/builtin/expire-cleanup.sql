-- aantje-template: 1
-- name: Expire snapshots and clean up old files
-- description: Expires the snapshots older than an age and deletes the files that no snapshot needs any more; both start as dry runs.
-- tags: maintenance, expire, snapshots, cleanup, files, storage
-- created: 2026-11-16
-- param: older_than | text | 30 days | Age of the snapshots to expire, an interval such as 30 days or 12 hours
-- WARNING: an expired snapshot can no longer be read, and deleted files cannot be restored.
-- The calls that are not commented out are dry runs: they only list what would go. To do it for real, remove the "-- "
-- in front of the commented call and run it; the age is asked for again, with the value of the dry run.
-- 1. Expire the snapshots older than the age (the newest snapshot never).
CALL ducklake_expire_snapshots('lake', older_than => now() - CAST($older_than AS INTERVAL), dry_run => true);
-- CALL ducklake_expire_snapshots('lake', older_than => now() - CAST($older_than AS INTERVAL));
-- 2. Delete the files that no snapshot needs any more and that are older than the option delete_older_than of the lake (2 days when it sets none).
CALL ducklake_cleanup_old_files('lake', dry_run => true);
-- CALL ducklake_cleanup_old_files('lake');
