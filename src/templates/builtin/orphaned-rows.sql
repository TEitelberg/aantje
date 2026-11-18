-- aantje-template: 1
-- name: Orphaned rows
-- description: Lists the rows of a child table whose key of a parent has no row in the parent table; DuckLake has no foreign keys that would prevent them. The key is one column.
-- tags: data quality, foreign key, orphans, referential integrity, anti join
-- created: 2026-11-17
-- param: child_schema  | identifier | main | Schema of the child table
-- param: child_table   | identifier |      | Child table, whose rows name a row of the parent
-- param: child_column  | identifier |      | Column of the child with the key of the parent
-- param: parent_schema | identifier | main | Schema of the parent table
-- param: parent_table  | identifier |      | Parent table
-- param: parent_column | identifier | id   | Key column of the parent
-- param: limit         | number     |      | Rows to show at most
-- A row of the child whose key is NULL names no parent and is left out.
SELECT child.*
FROM {{child_schema}}.{{child_table}} AS child
ANTI JOIN {{parent_schema}}.{{parent_table}} AS parent
  ON child.{{child_column}} = parent.{{parent_column}}
WHERE child.{{child_column}} IS NOT NULL
LIMIT $limit{1000};
